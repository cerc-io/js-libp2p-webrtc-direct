import { logger } from '@libp2p/logger'
import * as mafmt from '@multiformats/mafmt'
import { base58btc } from 'multiformats/bases/base58'
import assert from 'assert'
import { fetch } from 'native-fetch'
import { AbortError } from 'abortable-iterator'
import { toString } from 'uint8arrays/to-string'
import { fromString } from 'uint8arrays/from-string'
import { Signal, WebRTCInitiator, WebRTCInitiatorInit, WebRTCReceiverInit, WRTC } from '@libp2p/webrtc-peer'
import { symbol } from '@libp2p/interface-transport'
import type { CreateListenerOptions, DialOptions, Listener, Transport, Upgrader } from '@libp2p/interface-transport'
import type { Multiaddr } from '@multiformats/multiaddr'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import type { PeerId } from '@libp2p/interface-peer-id'
import { pEvent } from 'p-event'

import { CODE_CIRCUIT, CODE_P2P } from './constants.js'
import { toMultiaddrConnection } from './socket-to-conn.js'
import { createListener, WebRTCDirectListener } from './listener.js'
import type { ConnectRequest, JoinRequest, SignallingMessage } from './signal-message.js'
import { WebRTCDirectSigServer } from './server.js'

const log = logger('libp2p:webrtc-direct')

export { P2P_WEBRTC_STAR_ID } from './constants.js'

export interface WebRTCDirectInit {
  wrtc?: WRTC
  initiatorOptions?: WebRTCInitiatorInit
  receiverOptions?: WebRTCReceiverInit
  enableSignalling: boolean
  relayPeerId?: String
}

export interface WebRTCDirectComponents {
  peerId: PeerId
  upgrader?: Upgrader
}

class WebRTCDirect implements Transport {
  private readonly initiatorOptions?: WebRTCInitiatorInit
  private readonly receiverOptions?: WebRTCReceiverInit
  public wrtc?: WRTC

  peerId?: PeerId
  upgrader?: Upgrader

  private enableSignalling: boolean
  private relayPeerId?: String
  private signallingChannel?: RTCDataChannel

  peerListener?: WebRTCDirectListener

  constructor (init: WebRTCDirectInit) {
    this.initiatorOptions = init?.initiatorOptions
    this.receiverOptions = init?.receiverOptions
    this.wrtc = init?.wrtc

    this.enableSignalling = init.enableSignalling
    this.relayPeerId = init?.relayPeerId
  }

  get [symbol] (): true {
    return true
  }

  get [Symbol.toStringTag] () {
    return '@libp2p/webrtc-direct'
  }

  async dial (ma: Multiaddr, options: DialOptions) {
    let socket: WebRTCInitiator

    // TODO: Restructure if-else using ma
    // Perform regular dial if relayPeerId not set
    if (!this.relayPeerId) {
      socket = await this._connect(ma, options, false)
    } else if (ma.getPeerId() === this.relayPeerId) {
      // If the relay node is being dialled, perform regular dial + create an additional channel for signalling
      socket = await this._connect(ma, options, true)

      this.signallingChannel = socket.signallingChannel
      assert(this.signallingChannel)

      if (this.peerListener?.server instanceof WebRTCDirectSigServer) {
        // Start listening using the signalling channel
        this.peerListener.server.init(this.signallingChannel)
      }
    } else if (this.signallingChannel) {
      // Connect using signallingChannel if exists
      socket = await this._connectUsingRelay(ma, options)
    } else {
      // relayPeerId set but signallingChannel does not exist
      throw new Error('signalling channel not open to relay node')
    }

    const maConn = toMultiaddrConnection(socket, { remoteAddr: ma, signal: options.signal })
    log('new outbound connection %s', maConn.remoteAddr)
    const conn = await options.upgrader.upgradeOutbound(maConn)
    log('outbound connection %s upgraded', maConn.remoteAddr)

    return conn
  }

  async _connect (ma: Multiaddr, options: DialOptions, diallingRelayNode: boolean) {
    if (options.signal?.aborted === true) {
      throw new AbortError()
    }

    const channelOptions = {
      initiator: true,
      trickle: false,
      ...this.initiatorOptions,
      createSignallingChannel: diallingRelayNode
    }

    // Use custom WebRTC implementation
    if (this.wrtc != null) {
      channelOptions.wrtc = this.wrtc
    }

    return new Promise<WebRTCInitiator>(async (resolve, reject) => {
      let connected: boolean

      const cOpts = ma.toOptions()
      log('Dialing %s:%s', cOpts.host, cOpts.port)

      const protoNames = ma.protoNames()
      let url: string

      if (protoNames.includes('https')) {
        url = `https://${cOpts.host}:${cOpts.port}`
      } else {
        url = `http://${cOpts.host}:${cOpts.port}`
      }

      const channel = new WebRTCInitiator(channelOptions)

      const onError = (evt: CustomEvent<Error>) => {
        const err = evt.detail

        if (!connected) {
          const msg = `connection error ${cOpts.host}:${cOpts.port}: ${err.message}`

          log.error(msg)
          err.message = msg
          done(err)
        }
      }

      const onAbort = () => {
        log.error('connection aborted %s:%s', cOpts.host, cOpts.port)
        void channel.close().finally(() => {
          done(new AbortError())
        })
      }

      const done = (err?: Error) => {
        channel.removeEventListener('error', onError)
        options.signal?.removeEventListener('abort', onAbort)

        if (err != null) {
          reject(err)
        } else {
          resolve(channel)
        }
      }

      channel.addEventListener('error', onError, {
        once: true
      })
      channel.addEventListener('close', () => {
        channel.removeEventListener('error', onError)
      })
      options.signal?.addEventListener('abort', onAbort)

      const onSignal = async (signal: Signal) => {
        if (signal.type !== 'offer') {
          // skip candidates, just send the offer as it includes the candidates
          return
        }

        const signalStr = JSON.stringify(signal)

        let host = cOpts.host
        if (cOpts.family === 6 && !host.startsWith('[')) {
          host = `[${host}]`
        }

        const path = `/?signal=${base58btc.encode(fromString(signalStr))}`
        const uri = url + path

        try {
          const res = await fetch(uri)
          const body = await res.text()

          if (body.trim() === '') {
            // no response to this signal
            return
          }

          const incSignalBuf = base58btc.decode(body)
          const incSignalStr = toString(incSignalBuf)
          const incSignal = JSON.parse(incSignalStr)

          channel.handleSignal(incSignal)
        } catch (err: any) {
          await channel.close(err)
          reject(err)
        }
      }

      channel.addEventListener('signal', (evt) => {
        const signal = evt.detail

        void onSignal(signal).catch(async err => {
          await channel.close(err)
        })
      })

      const channelPromises: Promise<any>[] = [pEvent(channel, 'ready')]

      // Send a join request if dialling to the relay node
      if (diallingRelayNode) {
        const signallingChannel = channel.signallingChannel
        assert(signallingChannel)

        const onSignallingChannelOpen = () => {
          assert(this.peerId)

          const request: JoinRequest = {
            type: 'JoinRequest',
            peerId: this.peerId.toString()
          };
          const msg = uint8ArrayFromString(JSON.stringify(request))

          signallingChannel.send(msg)
        }

        // Send a JoinRequest when the signalling channel opens
        signallingChannel.addEventListener('open', onSignallingChannelOpen, { once: true })
        channelPromises.push(pEvent(signallingChannel, 'open'))
      }

      // Wait for all channels to be ready/opened
      await Promise.all(channelPromises)
      connected = true
      log('connection opened %s:%s', cOpts.host, cOpts.port)
      done()
    })
  }

  async _connectUsingRelay (ma: Multiaddr, options: DialOptions) {
    assert(this.peerId)
    const peerId = this.peerId

    if (options.signal?.aborted === true) {
      throw new AbortError()
    }

    const channelOptions = {
      initiator: true,
      trickle: false,
      ...this.initiatorOptions,
      createSignallingChannel: false
    }

    // Use custom WebRTC implementation
    if (this.wrtc != null) {
      channelOptions.wrtc = this.wrtc
    }

    return await new Promise<WebRTCInitiator>((resolve, reject) => {
      let connected: boolean

      // const cOpts = ma.toOptions()
      const dstPeerId = ma.getPeerId()
      if (!dstPeerId) {
        throw new AbortError('Peer Id missing from multiaddr to dial')
      }
      log('Dialing peer %s', dstPeerId)

      const channel = new WebRTCInitiator(channelOptions)

      const onError = (evt: CustomEvent<Error>) => {
        const err = evt.detail

        if (!connected) {
          const msg = `connection error ${dstPeerId}: ${err.message}`

          log.error(msg)
          err.message = msg
          done(err)
        }
      }

      const onReady = () => {
        connected = true

        log('connection opened %s', dstPeerId)
        done()
      }

      const onAbort = () => {
        log.error('connection aborted %s', dstPeerId)
        void channel.close().finally(() => {
          done(new AbortError())
        })
      }

      const done = (err?: Error) => {
        channel.removeEventListener('error', onError)
        channel.removeEventListener('ready', onReady)
        options.signal?.removeEventListener('abort', onAbort)

        if (err != null) {
          reject(err)
        } else {
          resolve(channel)
        }
      }

      channel.addEventListener('error', onError, {
        once: true
      })
      channel.addEventListener('ready', onReady, {
        once: true
      })
      channel.addEventListener('close', () => {
        channel.removeEventListener('error', onError)
      })
      options.signal?.addEventListener('abort', onAbort)

      const onSignal = async (signal: Signal) => {
        if (signal.type !== 'offer') {
          // skip candidates, just send the offer as it includes the candidates
          return
        }

        const signalStr = JSON.stringify(signal)

        assert(this.signallingChannel)
        const signallingChannel = this.signallingChannel

        try {
          // Create a connection request with signal string and send over signalling channel
          const request: ConnectRequest = {
            type: 'ConnectRequest',
            src: peerId.toString(),
            dst: dstPeerId,
            signal: signalStr
          };
          signallingChannel.send(uint8ArrayFromString(JSON.stringify(request)));

          // Wait for response message from the signalling channel
          // TODO Add timeout?
          const responseSignalJson = await new Promise<string>((resolve, reject) => {
            const onMessage = (evt: MessageEvent) => {
              try {
                const msgUint8Array = new Uint8Array(evt.data)
                const msg: SignallingMessage = JSON.parse(uint8ArrayToString(msgUint8Array))

                if (
                  msg.type === 'ConnectResponse' &&
                  msg.src === dstPeerId &&
                  msg.dst === peerId.toString()
                ) {
                  // Remove this handler after receiving the response
                  signallingChannel.removeEventListener('message', onMessage);
                  resolve(msg.signal)
                }
              } catch (err) {
                reject(err)
              }
            }

            signallingChannel.addEventListener('message', onMessage)
          });

          const responseSignal = JSON.parse(responseSignalJson)
          channel.handleSignal(responseSignal)
        } catch (err: any) {
          await channel.close(err)
          reject(err)
        }
      }

      channel.addEventListener('signal', (evt) => {
        const signal = evt.detail

        void onSignal(signal).catch(async err => {
          await channel.close(err)
        })
      })
    })
  }

  /**
   * Creates a WebrtcDirect listener. The provided `handler` function will be called
   * anytime a new incoming Connection has been successfully upgraded via
   * `upgrader.upgradeInbound`.
   */
  createListener (options: CreateListenerOptions): Listener {
    this.peerListener = createListener({
      ...options,
      receiverOptions: this.receiverOptions,
      wrtc: this.wrtc,
      signallingEnabled: this.enableSignalling
    })

    return this.peerListener
  }

  /**
   * Takes a list of `Multiaddr`s and returns only valid addresses
   */
  filter (multiaddrs: Multiaddr[]): Multiaddr[] {
    multiaddrs = Array.isArray(multiaddrs) ? multiaddrs : [multiaddrs]

    return multiaddrs.filter((ma) => {
      if (ma.protoCodes().includes(CODE_CIRCUIT)) {
        return false
      }

      const decapsulated = ma.decapsulateCode(CODE_P2P)
      return mafmt.WebRTCDirect.matches(decapsulated) || mafmt.WebRTCDirect.matches(decapsulated.decapsulateCode(CODE_P2P))
    })
  }
}

export function webRTCDirect (init: WebRTCDirectInit = { enableSignalling: false }): (components: WebRTCDirectComponents) => Transport {
  return (components: WebRTCDirectComponents) => {
    const transport = new WebRTCDirect(init)
    transport.peerId = components.peerId
    transport.upgrader = components.upgrader

    return transport
  }
}
