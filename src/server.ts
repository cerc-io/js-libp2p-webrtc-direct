import assert from 'assert'
import { logger } from '@libp2p/logger'
import { base58btc } from 'multiformats/bases/base58'
import { toString } from 'uint8arrays/to-string'
import { fromString } from 'uint8arrays/from-string'
import { Multiaddr, multiaddr } from '@multiformats/multiaddr'
import type { IncomingMessage, ServerResponse } from 'http'
import { EventEmitter, CustomEvent } from '@libp2p/interfaces/events'
import type { MultiaddrConnection } from '@libp2p/interface-connection'
import { ipPortToMultiaddr } from '@libp2p/utils/ip-port-to-multiaddr'
import { toMultiaddrConnection } from './socket-to-conn.js'
import { Signal, WebRTCReceiver, WebRTCReceiverInit, WRTC } from '@libp2p/webrtc-peer'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import defer, { DeferredPromise } from 'p-defer'

import { http } from './http-server.js'
import type { ConnectRequest, ConnectResponse, SignallingMessage } from './signal-message.js'

const log = logger('libp2p:webrtc-direct:listener')

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

  init (signallingChannel: RTCDataChannel) {
    this.signallingChannel = signallingChannel

    const handleMessage = (evt: MessageEvent) => {
      const msgUint8Array = new Uint8Array(evt.data);

      // Parse incoming message into a SignallingMessage object
      const msg: SignallingMessage = JSON.parse(uint8ArrayToString(msgUint8Array))

      // Handle connect requests over signalling channel (forwarded by relay node); ignore everything else
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

  async processRequest (request: ConnectRequest) {
    assert(this.signallingChannel)
    const signallingChannel = this.signallingChannel

    const incSignal: Signal = JSON.parse(request.signal);

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
        remoteAddr: multiaddr(`${this.multiAddr.toString()}/p2p/${request.src}`)
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

  async close () {
    await Promise.all(
      this.channels.map(async channel => await channel.close())
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
  private readonly peerSignallingChannelMap: Map<string, RTCDataChannel> = new Map()

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

  // TODO: Ensure normal direct connections from other relay nodes
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
    const shouldCreateSignallingChannel = url.searchParams.get('signalling_channel') === 'true'

    if (incSignalStr == null) {
      const err = new Error('Invalid listener request. Signal not found.')
      log.error(err)
      res.writeHead(500)
      res.end(err)
      return
    }

    const incSignalBuf = base58btc.decode(incSignalStr)
    const incSignal: Signal = JSON.parse(toString(incSignalBuf))

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

    // Use a deferred promise on signalling channel as it might not be initialized yet
    const deferredSignallingChannel: DeferredPromise<void> = defer()

    channel.addEventListener('signal', (evt) => {
      const signal = evt.detail
      const signalStr = JSON.stringify(signal)
      const signalEncoded = base58btc.encode(fromString(signalStr))

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
    channel.addEventListener('ready', async () => {
      // Wait for signalling channel to be opened
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
    })

    if (this.signallingEnabled && shouldCreateSignallingChannel) {
      // Handle signalling-channel event on channel
      await this._registerSignallingChannelHandler(channel, deferredSignallingChannel)
    } else {
      // Resolve immediately if signalling not enabled
      deferredSignallingChannel.resolve()
    }

    channel.handleSignal(incSignal)
  }

  async _registerSignallingChannelHandler (channel: WebRTCReceiver, deferredSignallingChannel: DeferredPromise<void>) {
    const handleSignallingChannel = (evt: CustomEvent<RTCDataChannel>) => {
      const signallingChannel = evt.detail

      // Resolve deferredSignallingChannel promise when signalling channel opens
      signallingChannel.addEventListener('open', () => {
        deferredSignallingChannel.resolve()
      })

      // Handle signalling messages from peers
      signallingChannel.addEventListener('message', (evt: MessageEvent) => {
        const msgUint8Array = new Uint8Array(evt.data)
        const msg: SignallingMessage = JSON.parse(uint8ArrayToString(msgUint8Array))

        // Add signalling channel to map on a JoinRequest (made only once when channel opens)
        if (msg.type === 'JoinRequest') {
          this.peerSignallingChannelMap.set(msg.peerId, signallingChannel)

          // Remove the entry from peerSignallingChannelMap for peer if channel closes or runs into an error
          const handleChannelCloseOrError = () => {
            this.peerSignallingChannelMap.delete(msg.peerId)
          };

          signallingChannel.addEventListener('close', handleChannelCloseOrError)
          signallingChannel.addEventListener('error', handleChannelCloseOrError)

          return
        }

        // Forward peer signalling messages
        const destPeerSignallingChannel = this.peerSignallingChannelMap.get(msg.dst)
        if (destPeerSignallingChannel) {
          destPeerSignallingChannel.send(msgUint8Array);
        } else {
          log('signalling channel not open for peer %s', msg.dst)
        }
      })
    }

    channel.addEventListener('signalling-channel', handleSignallingChannel)
  }

  async close () {
    await Promise.all(
      this.channels.map(async channel => await channel.close())
    )

    this.peerSignallingChannelMap.clear()

    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err != null) {
          return reject(err)
        }

        resolve()
      })
    })
  }
}
