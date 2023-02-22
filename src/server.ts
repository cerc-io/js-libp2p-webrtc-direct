import assert from 'assert'
import { logger } from '@libp2p/logger'
import { base58btc } from 'multiformats/bases/base58'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { Multiaddr, multiaddr } from '@multiformats/multiaddr'
import type { IncomingMessage, ServerResponse } from 'http'
import { EventEmitter, CustomEvent } from '@libp2p/interfaces/events'
import type { MultiaddrConnection } from '@libp2p/interface-connection'
import { ipPortToMultiaddr } from '@libp2p/utils/ip-port-to-multiaddr'
import { toMultiaddrConnection } from './socket-to-conn.js'
import { Signal, WebRTCReceiver, WebRTCReceiverInit, WRTC } from '@cerc-io/webrtc-peer'
import defer, { DeferredPromise } from 'p-defer'
import Cache from 'timed-cache'
import { sha256 } from 'multiformats/hashes/sha2'

import { http } from './http-server.js'
import { ConnectRequest, ConnectResponse, SignallingChannelType, SignallingMessage } from './signal-message.js'
import { SEEN_CACHE_TTL } from './constants.js'
import { setChannelClosingInterval } from './helpers.js'

const log = logger('libp2p:webrtc-direct:listener')
const debugLog = logger('laconic:webrtc-direct:debug')

interface WebRTCDirectServerEvents {
  'error': CustomEvent<Error>
  'listening': CustomEvent
  'connection': CustomEvent<MultiaddrConnection>
}

export class WebRTCDirectSigServer extends EventEmitter<WebRTCDirectServerEvents> {
  private readonly wrtc?: WRTC
  private readonly receiverOptions?: WebRTCReceiverInit
  private channels: WebRTCReceiver[]

  private readonly multiAddr: Multiaddr
  private signallingChannel?: RTCDataChannel

  constructor (multiaddr: Multiaddr, wrtc?: WRTC, receiverOptions?: WebRTCReceiverInit) {
    super()

    this.multiAddr = multiaddr
    this.channels = []
    this.wrtc = wrtc
    this.receiverOptions = receiverOptions
  }

  // Start listening using the signalling channel
  registerSignallingChannel (signallingChannel: RTCDataChannel) {
    this.signallingChannel = signallingChannel

    const handleMessage = (evt: MessageEvent) => {
      const msgUint8Array = new Uint8Array(evt.data)

      // Parse incoming message into a SignallingMessage object
      const msg: SignallingMessage = JSON.parse(uint8ArrayToString(msgUint8Array))

      // Handle connect requests forwarded over signalling channel; ignore everything else
      if (msg.type === 'ConnectRequest') {
        this.processRequest(msg)
      }
    }

    signallingChannel.addEventListener('message', handleMessage)

    signallingChannel.addEventListener('close', () => {
      // Remove message handler if channel closes
      log('stopping listening as signalling channel closed')
      signallingChannel.removeEventListener('message', handleMessage)
    }, { once: true })

    this.dispatchEvent(new CustomEvent('listening'))
    log('Listening using a signalling channel')
  }

  processRequest (request: ConnectRequest) {
    assert(this.signallingChannel)
    const signallingChannel = this.signallingChannel

    const incSignal: Signal = JSON.parse(request.signal)

    if (incSignal.type !== 'offer') {
      // offers contain candidates so only respond to the offer
      return
    }

    const channel = new WebRTCReceiver({
      wrtc: this.wrtc,
      ...this.receiverOptions
    })
    this.channels.push(channel)

    channel.addEventListener('signal', (evt) => {
      const signal = evt.detail
      const signalStr = JSON.stringify(signal)

      // Send response signal
      const response: ConnectResponse = {
        type: 'ConnectResponse',
        src: request.dst,
        dst: request.src,
        signal: signalStr
      }

      try {
        signallingChannel.send(uint8ArrayFromString(JSON.stringify(response)))
      } catch (err: any) {
        debugLog('processRequest signalling channel send failed', err)
        debugLog('signallingChannel.readyState', signallingChannel.readyState)
      }
    })
    channel.addEventListener('error', (evt) => {
      const err = evt.detail

      log.error('incoming connection errored with', err)
      void channel.close().catch(err => {
        log.error(err)
      })
    })
    channel.addEventListener('ready', () => {
      const maConn = toMultiaddrConnection(channel, {
        // Form the multiaddr for this peer by appending it's peer id to the listening multiaddr
        remoteAddr: multiaddr(`${this.multiAddr.toString()}/p2p/${request.dst}`)
      })
      log('new inbound connection %s', maConn.remoteAddr)

      const untrackConn = () => {
        this.channels = this.channels.filter(c => c !== channel)
      }
      channel.addEventListener('close', untrackConn, {
        once: true
      })

      this.dispatchEvent(new CustomEvent('connection', { detail: maConn }))
    })

    channel.handleSignal(incSignal)
  }

  deRegisterSignallingChannel () {
    this.signallingChannel = undefined
  }

  async close () {
    await Promise.all(
      this.channels.map(async (channel) => await channel.close())
    )
  }
}

export class WebRTCDirectServer extends EventEmitter<WebRTCDirectServerEvents> {
  private readonly server: http.Server
  private readonly wrtc?: WRTC
  private readonly receiverOptions?: WebRTCReceiverInit
  private connections: MultiaddrConnection[]
  private channels: WebRTCReceiver[]

  private readonly signallingEnabled: boolean
  // Keep track of signalling channels formed to peers by their peer id
  // to forward signalling messages
  private readonly peerSignallingChannelMap: Map<string, RTCDataChannel> = new Map()

  // Keep track of signalling channels formed to relay peers to forward signalling messages
  // where the destination peer isn't connected
  private relaySignallingChannels: RTCDataChannel[] = []

  // Keep a time-cache of signalling messages to avoid already seen messages
  seenCache: Cache<boolean> = new Cache({ defaultTtl: SEEN_CACHE_TTL })

  constructor (multiaddr: Multiaddr, signallingEnabled: boolean, wrtc?: WRTC, receiverOptions?: WebRTCReceiverInit) {
    super()

    this.signallingEnabled = signallingEnabled
    this.connections = []
    this.channels = []
    this.wrtc = wrtc
    this.receiverOptions = receiverOptions
    this.server = http.createServer()

    this.server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      void this.processRequest(req, res).catch(err => {
        log.error(err)
      })
    })

    this.server.on('error', (err) => this.dispatchEvent(new CustomEvent<Error>('error', { detail: err })))

    const lOpts = multiaddr.toOptions()

    this.server.on('listening', (err: Error) => {
      if (err != null) {
        this.dispatchEvent(new CustomEvent<Error>('error', { detail: err }))

        return
      }

      this.dispatchEvent(new CustomEvent('listening'))
      log('Listening on %s %s', lOpts.port, lOpts.host)
    })

    this.server.listen(lOpts)
  }

  // Register a signalling channel created when dialling to another relay node
  // (called from dialer)
  // (need to keep track in the listener to be able to forward signalling messages to all connected relay peers)
  registerSignallingChannel (signallingChannel: RTCDataChannel) {
    // Keep track of the signalling channel from another relay node
    this.relaySignallingChannels.push(signallingChannel)

    const handleMessage = (evt: MessageEvent) => {
      void (async () => {
        const msgUint8Array = new Uint8Array(evt.data)
        const msg: SignallingMessage = JSON.parse(uint8ArrayToString(msgUint8Array))

        if (msg.type === 'JoinRequest') {
          throw new Error('Unexpected JoinRequest over relay signalling channel')
        }

        await this._handlePeerSignallingMessage(signallingChannel, msgUint8Array, msg.dst)
      })()
    }

    signallingChannel.addEventListener('message', handleMessage)

    const untrackChannel = () => {
      log('Deregistering closed relay signalling channel')
      signallingChannel.removeEventListener('message', handleMessage)

      this.relaySignallingChannels = this.relaySignallingChannels.filter(c => c !== signallingChannel)
    }

    const closingInterval = setChannelClosingInterval(signallingChannel, untrackChannel)

    signallingChannel.addEventListener('close', () => {
      clearInterval(closingInterval)
      untrackChannel()
    }, { once: true })
  }

  async processRequest (req: IncomingMessage, res: ServerResponse) {
    const remoteAddress = req?.socket?.remoteAddress
    const remotePort = req?.socket.remotePort
    const remoteHost = req.headers.host
    const requestUrl = req.url

    if (remoteAddress == null || remotePort == null || requestUrl == null || remoteHost == null) {
      const err = new Error('Invalid listener request. Specify request\'s url, remoteAddress, remotePort.')
      log.error(err)
      res.writeHead(500)
      res.end(err)
      return
    }
    res.setHeader('Content-Type', 'text/plain')
    res.setHeader('Access-Control-Allow-Origin', '*')

    const url = new URL(requestUrl, `http://${remoteHost}`)
    const incSignalStr = url.searchParams.get('signal')
    let signallingChannelType = url.searchParams.get('signalling_channel')

    if (incSignalStr == null) {
      const err = new Error('Invalid listener request. Signal not found.')
      log.error(err)
      res.writeHead(500)
      res.end(err)
      return
    }

    if (signallingChannelType == null) {
      signallingChannelType = SignallingChannelType.None
    }

    const incSignalBuf = base58btc.decode(incSignalStr)
    const incSignal: Signal = JSON.parse(uint8ArrayToString(incSignalBuf))

    if (incSignal.type !== 'offer') {
      // offers contain candidates so only respond to the offer
      res.end()
      return
    }

    const channel = new WebRTCReceiver({
      wrtc: this.wrtc,
      ...this.receiverOptions
    })
    this.channels.push(channel)

    // Create a deferred promise on signalling channel as it might not be initialized yet
    const deferredSignallingChannel: DeferredPromise<void> = defer()

    channel.addEventListener('signal', (evt) => {
      const signal = evt.detail
      const signalStr = JSON.stringify(signal)
      const signalEncoded = base58btc.encode(uint8ArrayFromString(signalStr))

      res.end(signalEncoded)
    })
    channel.addEventListener('error', (evt) => {
      const err = evt.detail

      log.error('incoming connection errored with', err)
      res.end()
      void channel.close().catch(err => {
        log.error(err)
      })
    })
    channel.addEventListener('ready', () => {
      void (async () => {
        // 'ready' event is emitted when the main datachannel opens
        // Wait for signalling channel to be opened as well
        await deferredSignallingChannel.promise

        const maConn = toMultiaddrConnection(channel, {
          remoteAddr: ipPortToMultiaddr(remoteAddress, remotePort)
        })
        log('new inbound connection %s', maConn.remoteAddr)

        this.connections.push(maConn)

        const untrackConn = () => {
          this.connections = this.connections.filter(c => c !== maConn)
          this.channels = this.channels.filter(c => c !== channel)
        }

        channel.addEventListener('close', untrackConn, {
          once: true
        })

        this.dispatchEvent(new CustomEvent('connection', { detail: maConn }))
      })()
    })

    // Handle the signalling channel if signalling is enabled and specified in the request
    if (this.signallingEnabled) {
      switch (signallingChannelType) {
        case SignallingChannelType.None: {
          // Resolve immediately if signalling channel not requested
          deferredSignallingChannel.resolve()
          break
        }

        case SignallingChannelType.Peer:
        case SignallingChannelType.Relay: {
          // Handle signalling-channel event on channel
          await this._registerSignallingChannelHandler(channel, deferredSignallingChannel, signallingChannelType)
          break
        }

        default:
          throw new Error(`Invalid signalling channel type in the listener request: ${signallingChannelType}`)
      }
    } else {
      // Resolve immediately if signalling not enabled
      deferredSignallingChannel.resolve()
    }

    channel.handleSignal(incSignal)
  }

  async _registerSignallingChannelHandler (channel: WebRTCReceiver, deferredSignallingChannel: DeferredPromise<void>, type: SignallingChannelType) {
    const handleSignallingChannel = (evt: CustomEvent<RTCDataChannel>) => {
      const signallingChannel = evt.detail

      const trackRelaySignallingChannel = () => {
        this.relaySignallingChannels.push(signallingChannel)

        const untrackChannel = () => {
          this.relaySignallingChannels = this.relaySignallingChannels.filter(s => s !== signallingChannel)
        }
        const closingInterval = setChannelClosingInterval(signallingChannel, untrackChannel)

        signallingChannel.addEventListener('close', () => {
          clearInterval(closingInterval)
          untrackChannel()
        }, { once: true })
        signallingChannel.addEventListener('error', untrackChannel)
      }

      const trackPeerSignallingChannel = (peerId: string) => {
        this.peerSignallingChannelMap.set(peerId, signallingChannel)

        // Remove the channel entry from peerSignallingChannelMap for peer
        // if channel closes or runs into an error
        const untrackChannel = () => {
          this.peerSignallingChannelMap.delete(peerId)
        }
        const closingInterval = setChannelClosingInterval(signallingChannel, untrackChannel)

        signallingChannel.addEventListener('close', () => {
          clearInterval(closingInterval)
          untrackChannel()
        }, { once: true })
        signallingChannel.addEventListener('error', untrackChannel)
      }

      signallingChannel.addEventListener('open', () => {
        // Keep track of the signalling channel from another relay node
        if (type === SignallingChannelType.Relay) {
          trackRelaySignallingChannel()
        }

        // Resolve deferredSignallingChannel promise when signalling channel opens
        deferredSignallingChannel.resolve()
      })

      // Handle signalling messages from peers
      signallingChannel.addEventListener('message', (evt: MessageEvent) => {
        void (async () => {
          const msgUint8Array = new Uint8Array(evt.data)
          const msg: SignallingMessage = JSON.parse(uint8ArrayToString(msgUint8Array))

          // Keep track of the signalling channel in a map on a JoinRequest from a peer
          // (made only once when the channel opens)
          if (msg.type === 'JoinRequest') {
            if (type === SignallingChannelType.Relay) {
              throw new Error('Unexpected JoinRequest over relay signalling channel')
            }

            // Keep track of the signalling channel from peer nodes
            trackPeerSignallingChannel(msg.peerId)
            return
          }

          await this._handlePeerSignallingMessage(signallingChannel, msgUint8Array, msg.dst)
        })()
      })
    }

    channel.addEventListener('signalling-channel', handleSignallingChannel)
  }

  async _handlePeerSignallingMessage (from: RTCDataChannel, msg: Uint8Array, dst: string) {
    // Check if the message has been already seen in the time-cache
    const isMsgSeen = await this._isMsgSeen(msg)
    if (isMsgSeen) {
      // Ignore if seen
      return
    }

    this._forwardSignallingMessage(from, msg, dst)
  }

  async _isMsgSeen (msg: Uint8Array) {
    const msgEncoded = await sha256.encode(msg)
    const msgIdStr = uint8ArrayToString(msgEncoded, 'base64')

    if (this.seenCache.get(msgIdStr) != null) {
      return true
    }

    this.seenCache.put(msgIdStr, true)
    return false
  }

  _forwardSignallingMessage (from: RTCDataChannel, msg: Uint8Array, dst: string) {
    const destPeerSignallingChannel = this.peerSignallingChannelMap.get(dst)

    // Forward peer signalling message to its destination if a signalling channel is present
    if (destPeerSignallingChannel != null) {
      try {
        destPeerSignallingChannel.send(msg)
      } catch (err: any) {
        debugLog('dest signalling channel send failed', err)
        debugLog('destPeerSignallingChannel.readyState', destPeerSignallingChannel.readyState)
      }
    } else {
      // Otherwise, forward the signalling message to all the connected relay nodes
      this.relaySignallingChannels.forEach(relaySignallingChannel => {
        // Skip the source
        if (relaySignallingChannel === from) {
          return
        }

        try {
          relaySignallingChannel.send(msg)
        } catch (err: any) {
          debugLog('relay signalling channel send failed', err)
          debugLog('relaySignallingChannel.readyState', relaySignallingChannel.readyState)
        }
      })
    }
  }

  async close () {
    await Promise.all(
      this.channels.map(async channel => await channel.close())
    )

    // Clear the (peer - signalling channel) mapping
    this.peerSignallingChannelMap.clear()

    // Reset the list of signalling channels to relay peers
    this.relaySignallingChannels = []

    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err != null) {
          reject(err)
        }

        resolve()
      })
    })
  }
}
