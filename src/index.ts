import { logger } from '@libp2p/logger'
import * as mafmt from '@multiformats/mafmt'
import { base58btc } from 'multiformats/bases/base58'
import assert from 'assert'
import { fetch } from 'native-fetch'
import { AbortError } from 'abortable-iterator'
import { toString } from 'uint8arrays/to-string'
import { fromString } from 'uint8arrays/from-string'
import { CODE_CIRCUIT, CODE_P2P } from './constants.js'
import { toMultiaddrConnection } from './socket-to-conn.js'
import { createListener } from './listener.js'
import { Signal, WebRTCInitiator, WebRTCInitiatorInit, WebRTCPeer, WebRTCReceiver, WebRTCReceiverInit, WRTC } from '@libp2p/webrtc-peer'
import { symbol } from '@libp2p/interface-transport'
import type { CreateListenerOptions, DialOptions, Listener, Transport, Upgrader } from '@libp2p/interface-transport'
import { Multiaddr, multiaddr } from '@multiformats/multiaddr'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import type { PeerId } from '@libp2p/interface-peer-id'
import type { ConnectSignal, JoinRequest, SignallingMessage } from './signal-message.js'
import defer, { DeferredPromise } from 'p-defer'

const log = logger('libp2p:webrtc-direct')

export interface WebRTCDirectInit {
  wrtc?: WRTC
  initiatorOptions?: WebRTCInitiatorInit
  receiverOptions?: WebRTCReceiverInit
  enableSignalling: boolean
  relayMultiAddr?: Multiaddr
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

  enableSignalling: boolean
  relayMultiAddr?: Multiaddr
  relayConnection?: WebRTCPeer

  constructor (init: WebRTCDirectInit) {
    this.initiatorOptions = init?.initiatorOptions
    this.receiverOptions = init?.receiverOptions
    this.wrtc = init?.wrtc

    this.enableSignalling = init.enableSignalling
    this.relayMultiAddr = init?.relayMultiAddr
  }

  get [symbol] (): true {
    return true
  }

  get [Symbol.toStringTag] () {
    return '@libp2p/webrtc-direct'
  }

  async dial (ma: Multiaddr, options: DialOptions) {
    let socket: WebRTCInitiator

    // TODO: restructure using enableSignalling
    // Perform regular dial if relayMultiAddr or the relay node is being dialled
    if (!this.relayMultiAddr || ma.equals(this.relayMultiAddr)) {
      socket = await this._connect(ma, options)

      // Set relayConnection if relay node was dialled
      if (this.relayMultiAddr && ma.equals(this.relayMultiAddr)) {
        this.relayConnection = socket

        // Register handler for connection requests from other peers
        this._registerRequestHandler()
      }
    } else if (this.relayConnection) {
      // Connect using relay connection if exists
      socket = await this._connectUsingRelay(ma, options)
    } else {
      // relayMultiAddr set but relayConnection does not exist
      throw new Error('not connected to relay node')
    }

    const maConn = toMultiaddrConnection(socket, { remoteAddr: ma, signal: options.signal })
    log('new outbound connection %s', maConn.remoteAddr)
    const conn = await options.upgrader.upgradeOutbound(maConn)
    log('outbound connection %s upgraded', maConn.remoteAddr)
    return conn
  }

  async _connect (ma: Multiaddr, options: DialOptions) {
    if (options.signal?.aborted === true) {
      throw new AbortError()
    }

    const createSignallingChannel = (this.relayMultiAddr !== undefined && ma.equals(this.relayMultiAddr))
    const channelOptions = {
      initiator: true,
      trickle: false,
      ...this.initiatorOptions,
      createSignallingChannel
    }

    // Use custom WebRTC implementation
    if (this.wrtc != null) {
      channelOptions.wrtc = this.wrtc
    }

    return new Promise<WebRTCInitiator>((resolve, reject) => {
      let connected: boolean
      const deferredSignallingChannel: DeferredPromise<void> = defer()

      const cOpts = ma.toOptions()
      log('Dialing %s:%s', cOpts.host, cOpts.port)

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

      const onReady = async () => {
        // Wait for signalling channel resolution
        await deferredSignallingChannel.promise

        connected = true
        log('connection opened %s:%s', cOpts.host, cOpts.port)
        done()
      }

      const onAbort = () => {
        log.error('connection aborted %s:%s', cOpts.host, cOpts.port)
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

        let host = cOpts.host

        if (cOpts.family === 6 && !host.startsWith('[')) {
          host = `[${host}]`
        }

        const url = `http://${host}:${cOpts.port}`
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

      if (this.enableSignalling) {
        const signallingChannel = channel.signallingChannel
        assert(signallingChannel)

        // Send a JoinRequest when the signalling channel opens
        signallingChannel.addEventListener('open', () => {
          assert(this.peerId)

          const request: JoinRequest = {
            type: 'JoinRequest',
            peerId: this.peerId.toString()
          };
          const msg = uint8ArrayFromString(JSON.stringify(request))

          signallingChannel.send(msg)
          deferredSignallingChannel.resolve()
        }, { once: true })
      } else {
        deferredSignallingChannel.resolve()
      }
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

        assert(this.relayConnection?.signallingChannel)
        const signallingChannel = this.relayConnection.signallingChannel;

        try {
          // Create a connection request with signal string and send over signalling channel
          const request: ConnectSignal = {
            type: 'ConnectSignal',
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
                  msg.type === 'ConnectSignal' &&
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

  _registerRequestHandler () {
    // Register handler for connection requests from other peers
    const signallingChannel = this.relayConnection?.signallingChannel
    assert(signallingChannel)

    signallingChannel.addEventListener('message', (evt: MessageEvent) => {
      assert(this.peerId)

      const msgUint8Array: Uint8Array = evt.data;
      const msg: SignallingMessage = JSON.parse(uint8ArrayToString(msgUint8Array))

      if (
        msg.type === 'ConnectSignal' &&
        msg.dst === this.peerId.toString()
      ) {
        this._handleConnectionRequest(msg)
      }
    })
  }

  _handleConnectionRequest(request: ConnectSignal) {
    const incSignal: Signal = JSON.parse(request.signal);

    if (incSignal.type !== 'offer') {
      // offers contain candidates so only respond to the offer
      return
    }

    const signallingChannel = this.relayConnection?.signallingChannel
    assert(signallingChannel)

    const channel = new WebRTCReceiver({
      wrtc: this.wrtc,
      ...this.receiverOptions
    })

    // TODO keep track of inbound channels?
    // this.channels.push(channel)

    channel.addEventListener('signal', (evt) => {
      const signal = evt.detail
      const signalStr = JSON.stringify(signal)

      // Send response signal
      const response: ConnectSignal = {
        type: 'ConnectSignal',
        src: request.dst,
        dst: request.src,
        signal: signalStr
      }
      signallingChannel.send(uint8ArrayFromString(JSON.stringify(response)))
    })
    channel.addEventListener('error', (evt) => {
      const err = evt.detail

      log.error('incoming connection errored with', err)
      void channel.close().catch(err => {
        log.error(err)
      })
    })
    channel.addEventListener('ready', async () => {
      const maConn = toMultiaddrConnection(channel, {
        remoteAddr: multiaddr(`${this.relayMultiAddr?.decapsulateCode(421).toString()}/p2p/${request.src}`)
      })
      log('new inbound connection %s', maConn.remoteAddr)

      // TODO keep track of connections?
      // this.connections.push(maConn)

      // const untrackConn = () => {
      //   this.connections = this.connections.filter(c => c !== maConn)
      //   this.channels = this.channels.filter(c => c !== channel)
      // }

      // channel.addEventListener('close', untrackConn, {
      //   once: true
      // })

      try {
        assert(this.upgrader)
        await this.upgrader.upgradeInbound(maConn)
      } catch (err) {
        log.error('inbound connection failed to upgrade', err)
        return await maConn.close()
      }
      log('inbound connection %s upgraded', maConn.remoteAddr)

      // TODO: Create a separate listener for peers?
      // this.dispatchEvent(new CustomEvent('connection', { detail: maConn }))
    })

    channel.handleSignal(incSignal)
  }

  /**
   * Creates a WebrtcDirect listener. The provided `handler` function will be called
   * anytime a new incoming Connection has been successfully upgraded via
   * `upgrader.upgradeInbound`.
   */
  createListener (options: CreateListenerOptions): Listener {
    return createListener({
      ...options,
      receiverOptions: this.receiverOptions,
      wrtc: this.wrtc,
      signallingEnabled: this.enableSignalling
    })
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

      return mafmt.WebRTCDirect.matches(ma.decapsulateCode(CODE_P2P))
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
