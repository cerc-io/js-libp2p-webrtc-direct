import { logger } from '@libp2p/logger'
import * as mafmt from '@multiformats/mafmt'
import { base58btc } from 'multiformats/bases/base58'
import assert from 'assert'
import { fetch } from 'native-fetch'
import { AbortError } from 'abortable-iterator'
import { toString } from 'uint8arrays/to-string'
import { fromString } from 'uint8arrays/from-string'
import { Signal, WebRTCInitiator, WebRTCInitiatorInit, WebRTCReceiverInit, WRTC } from '@cerc-io/webrtc-peer'
import { symbol } from '@libp2p/interface-transport'
import type { CreateListenerOptions, DialOptions, Listener, Transport, Upgrader } from '@libp2p/interface-transport'
import type { Multiaddr } from '@multiformats/multiaddr'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import type { PeerId } from '@libp2p/interface-peer-id'
import defer, { DeferredPromise } from 'p-defer'

import { CODE_CIRCUIT, CODE_P2P, P2P_WEBRTC_STAR_ID } from './constants.js'
import { toMultiaddrConnection } from './socket-to-conn.js'
import { createListener, WebRTCDirectListener } from './listener.js'
import { ConnectRequest, JoinRequest, SignallingChannelType, SignallingMessage } from './signal-message.js'

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

  private readonly enableSignalling: boolean
  private readonly relayPeerId?: String
  private signallingChannel?: RTCDataChannel
  private peerListener?: WebRTCDirectListener

  public peerId?: PeerId
  public upgrader?: Upgrader

  constructor (init: WebRTCDirectInit) {
    this.initiatorOptions = init?.initiatorOptions
    this.receiverOptions = init?.receiverOptions
    this.wrtc = init?.wrtc

    this.enableSignalling = init.enableSignalling

    // Peer nodes need to set the peer id of the relay node with which the signalling channel is to be established
    // No need to set in case of relay nodes
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

    if (this.enableSignalling) {
      socket = await this._dialWithSignallingEnabled(ma, options)
    } else {
      // Ensure that dial address doesn't include webrtc-star id
      if (ma.toString().includes(P2P_WEBRTC_STAR_ID)) {
        throw new Error('Cannot dial ma containing webrtc-star id if signalling not enabled or relayPeerId not set')
      }

      // Perform regular dial
      socket = await this._connect(ma, options)
    }

    const maConn = toMultiaddrConnection(socket, { remoteAddr: ma, signal: options.signal })
    log('new outbound connection %s', maConn.remoteAddr)
    const conn = await options.upgrader.upgradeOutbound(maConn)
    log('outbound connection %s upgraded', maConn.remoteAddr)

    return conn
  }

  async _dialWithSignallingEnabled (ma: Multiaddr, options: DialOptions) {
    // Dial using signalling channel if multiaddr being dialled contains webrtc-star id
    // (to peer nodes)
    if (ma.toString().includes(P2P_WEBRTC_STAR_ID)) {
      // Perform dial using signalling channel
      return this._dialUsingSignallingChannel(ma, options)
    }

    // Otherwise, perform regular dial
    // (to relay nodes)
    let signallingChannelType: SignallingChannelType;
    if (this.relayPeerId) {
      // Create peer signalling channel if dialling the primary relay node
      signallingChannelType = (ma.getPeerId() === this.relayPeerId)
      ? SignallingChannelType.Peer
      : SignallingChannelType.None;
    } else {
      // Create relay signalling channel if dialling from one relay node to another
      signallingChannelType = SignallingChannelType.Relay;
    }

    return this._connect(ma, options, signallingChannelType)
  }

  async _dialUsingSignallingChannel (ma: Multiaddr, options: DialOptions) {
    // Expect relayPeerId to be set
    if (!this.relayPeerId) {
      throw new Error('primary relay peer id not set')
    }

    // Expect signalling channel to exist and connect using signalling channel
    if (!this.signallingChannel) {
      throw new Error('signalling channel does not exist to primary relay node')
    }

    return this._connectUsingSignallingChannel(ma, options)
  }

  async _connect (ma: Multiaddr, options: DialOptions, signallingChannelType = SignallingChannelType.None) {
    console.log('_connect', signallingChannelType)
    if (options.signal?.aborted === true) {
      throw new AbortError()
    }

    const channelOptions = {
      initiator: true,
      trickle: false,
      ...this.initiatorOptions
    }

    // Use custom WebRTC implementation
    if (this.wrtc != null) {
      channelOptions.wrtc = this.wrtc
    }

    return new Promise<WebRTCInitiator>(async (resolve, reject) => {
      let connected: boolean

      const cOpts = ma.toOptions()
      log('Dialing %s:%s', cOpts.host, cOpts.port)

      const channel = new WebRTCInitiator(channelOptions)

      // Create a deferred promise on signalling channel
      const deferredSignallingChannel: DeferredPromise<void> = defer()

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
        // 'ready' event is emitted when the main datachannel opens
        // Wait for signalling channel to be opened as well
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

        const protoNames = ma.protoNames()
        let url: string

        // Use https in the request if specified as such in the multiaddr
        if (protoNames.includes('https')) {
          url = `https://${host}:${cOpts.port}`
        } else {
          url = `http://${host}:${cOpts.port}`
        }

        const path = `/?signal=${base58btc.encode(fromString(signalStr))}&signalling_channel=${signallingChannelType}`
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

      switch (signallingChannelType) {
        case SignallingChannelType.None: {
          // Resolve immediately if signalling channel is not being created
          // (signalling is not enabled or dialling to a secondary relay node)
          deferredSignallingChannel.resolve()
          break;
        }

        case SignallingChannelType.Peer:
        case SignallingChannelType.Relay: {
          // Handle the signalling channel if signalling channel is being created
          // (signalling is enabled;
          //  dialling to the primary relay node from a peer node or
          //  dialling to a relay node from a relay node)
          await this._registerSignallingChannelHandler(channel, deferredSignallingChannel, signallingChannelType)

          // Create signalling channel after handlers have been registered
          this._createSignallingChannel(channel)
          break;
        }
      }
    })
  }

  _createSignallingChannel (channel: WebRTCInitiator) {
    if (!channel.closed) {
      log('opening a new signalling channel')
      channel.createSignallingChannel()
    }
  }

  async _registerSignallingChannelHandler (channel: WebRTCInitiator, deferredSignallingChannel: DeferredPromise<void>, type: SignallingChannelType) {
    const handleSignallingChannel = (evt: CustomEvent<RTCDataChannel>) => {
      const signallingChannel = evt.detail

      signallingChannel.addEventListener('open', () => {
        console.log('signallingChannel open')
        // For signalling channels from peer to relay nodes
        if (type === SignallingChannelType.Peer) {
          // Set the signalling channel for this peer
          this.signallingChannel = signallingChannel

          // Send a JoinRequest message when it opens
          assert(this.peerId)
          const request: JoinRequest = {
            type: 'JoinRequest',
            peerId: this.peerId.toString()
          };

          const msg = uint8ArrayFromString(JSON.stringify(request))
          signallingChannel.send(msg)
        }

        // Register signalling channel with the listener
        // (this.peerListener is set in this.createListener which is called for the provided listen address)
        // (only single listen address supported for now)
        if (this.peerListener?.server) {
          this.peerListener.server.registerSignallingChannel(signallingChannel)
        }

        // Resolve deferredSignallingChannel promise
        deferredSignallingChannel.resolve()
      })

      signallingChannel.addEventListener('close', () => {
        log('signalling channel closed')

        // Unset the signalling channel for this peer
        delete this.signallingChannel

        // Open a new signalling channel if peer connection still exists
        this._createSignallingChannel(channel)
      })

      signallingChannel.addEventListener('error', (evt) => {
        // @ts-expect-error ChannelErrorEvent is just an Event in the types?
        if (evt.error?.message === 'Transport channel closed') {
          return signallingChannel.close()
        }

        // @ts-expect-error
        const err = evt.error instanceof Error ? evt.error : new Error(`signalling channel error: ${evt.error?.message} ${evt.error?.errorDetail}`)

        log.error('signalling channel error', err)

        // Open a new signalling channel if peer connection still exists
        this._createSignallingChannel(channel)
      })
    }

    channel.addEventListener('signalling-channel', handleSignallingChannel)
  }

  async _connectUsingSignallingChannel (ma: Multiaddr, options: DialOptions) {
    console.log('_connectUsingSignallingChannel')
    assert(this.peerId)
    const peerId = this.peerId

    if (options.signal?.aborted === true) {
      throw new AbortError()
    }

    const channelOptions = {
      initiator: true,
      trickle: false,
      ...this.initiatorOptions
    }

    // Use custom WebRTC implementation
    if (this.wrtc != null) {
      channelOptions.wrtc = this.wrtc
    }

    return await new Promise<WebRTCInitiator>((resolve, reject) => {
      let connected: boolean

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
          console.log('sending a connect request to', request.dst)
          signallingChannel.send(uint8ArrayFromString(JSON.stringify(request)));

          // Wait for response message over the signalling channel
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
                  console.log('got a connect response from', msg.src)
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

      // ma can be a listen multiaddr or another node's multiaddr that's being dialled

      // TODO Update desc
      // Additional check on the relay peer id for addresses having webrtc-star id
      // Eg. Listen address (/ip4/0.0.0.0/tcp/9090/http/p2p-webrtc-direct/p2p/12D3KooWRxmi5GXThHcLzadFGS7KWwMmYMsVpMjZpbgV6QQ1Cd68/p2p-webrtc-star)
      // Eg. Peer address (/ip4/0.0.0.0/tcp/9090/http/p2p-webrtc-direct/p2p/12D3KooWENbU4KTaLgfdQVC5Ths6EewQJjYo4AjtPx2ykRrooT51/p2p-webrtc-star/p2p/12D3KooWBdPEfKR3MdA4L9BhJJ1RcDFK3XCgJ4bLx4kAJow1i8fg)
      if (ma.protoNames().includes(P2P_WEBRTC_STAR_ID)) {
        // Reject if signalling not enabled
        if (!this.enableSignalling) {
          return false
        }

        // Match with webrtc-direct for listen addresses (/ip4/0.0.0.0/tcp/9090/http/p2p-webrtc-direct)
        if (mafmt.WebRTCDirect.matches(ma.decapsulateCode(CODE_P2P))) {
          // Ensure that the peer id in the listening multiaddr matches the primary relay peer id
          // i.e. Can only listen through connection to primary relay node
          return ma.getPeerId() === this.relayPeerId
        }

        // Decapsulate for peer addresses and then perform the same checks as above
        // Eg. Decapsulated multiaddr (/ip4/0.0.0.0/tcp/9090/http/p2p-webrtc-direct/p2p/12D3KooWENbU4KTaLgfdQVC5Ths6EewQJjYo4AjtPx2ykRrooT51/p2p-webrtc-star)
        const decapsulated = ma.decapsulateCode(CODE_P2P)
        return mafmt.WebRTCDirect.matches(decapsulated.decapsulateCode(CODE_P2P))
      }

      // Addresses without webrtc-star id
      // Eg. Relay node address (/ip4/0.0.0.0/tcp/9090/http/p2p-webrtc-direct/p2p/12D3KooWRxmi5GXThHcLzadFGS7KWwMmYMsVpMjZpbgV6QQ1Cd68)
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
