import { logger } from '@libp2p/logger'
import { EventEmitter, CustomEvent } from '@libp2p/interfaces/events'
import type { MultiaddrConnection, Connection } from '@libp2p/interface-connection'
import type { Listener, CreateListenerOptions, ConnectionHandler, ListenerEvents, Upgrader } from '@libp2p/interface-transport'
import type { WebRTCReceiverInit, WRTC } from '@cerc-io/webrtc-peer'
import type { Multiaddr } from '@multiformats/multiaddr'
import errCode from 'err-code'
import { pEvent } from 'p-event'

import { P2P_WEBRTC_STAR_ID } from './constants.js'
import { WebRTCDirectSigServer, WebRTCDirectServer } from './server.js'

const log = logger('libp2p:webrtc-direct:listener')

interface WebRTCDirectListenerOptions extends CreateListenerOptions {
  receiverOptions?: WebRTCReceiverInit
  wrtc?: WRTC
  signallingEnabled: boolean
}

export class WebRTCDirectListener extends EventEmitter<ListenerEvents> implements Listener {
  server?: WebRTCDirectServer | WebRTCDirectSigServer

  private multiaddr?: Multiaddr
  private readonly wrtc?: WRTC
  private readonly receiverOptions?: WebRTCReceiverInit
  private readonly handler?: ConnectionHandler
  private readonly upgrader: Upgrader
  private readonly signallingEnabled: boolean

  constructor (upgrader: Upgrader, signallingEnabled: boolean, wrtc?: WRTC, receiverOptions?: WebRTCReceiverInit, handler?: ConnectionHandler) {
    super()

    this.upgrader = upgrader
    this.wrtc = wrtc
    this.receiverOptions = receiverOptions
    this.handler = handler
    this.signallingEnabled = signallingEnabled
  }

  async listen (multiaddr: Multiaddr) {
    // Should only be used if not already listening
    if (this.multiaddr != null) {
      throw errCode(new Error('listener already in use'), 'ERR_ALREADY_LISTENING')
    }

    const disPatchListeningEvent = () => {
      // Set this.multiaddr only when emitting listening event
      this.multiaddr = multiaddr
      this.dispatchEvent(new CustomEvent('listening'))
    }

    // Peer nodes use a multiaddr containing webrtc-star id to listen using a signalling channel
    // If signalling is enabled and listen multiaddr contains webrtc-star id, use WebRTCDirectSigServer
    if (this.signallingEnabled && multiaddr.toString().includes(P2P_WEBRTC_STAR_ID)) {
      this.server = new WebRTCDirectSigServer(multiaddr, this.wrtc, this.receiverOptions)
      this.server.addEventListener('listening', disPatchListeningEvent)
    } else {
      this.server = new WebRTCDirectServer(multiaddr, this.signallingEnabled, this.wrtc, this.receiverOptions)
      this.server.addEventListener('listening', disPatchListeningEvent)

      // Wait for listening event in case of WebRTCDirectServer (listening on host:port)
      // In case of WebRTCDirectSigServer (listening through signalling channel),
      // the listening event is fired later on server initialization (peer has a signalling channel opened)
      await pEvent(this.server, 'listening')
    }

    this.server.addEventListener('connection', (evt) => {
      void this.onConnection(evt.detail).catch(err => {
        log.error(err)
      })
    })
  }

  async onConnection (maConn: MultiaddrConnection) {
    let connection: Connection

    try {
      connection = await this.upgrader.upgradeInbound(maConn)
    } catch (err) {
      log.error('inbound connection failed to upgrade', err)
      return await maConn.close()
    }
    log('inbound connection %s upgraded', maConn.remoteAddr)

    if (this.handler != null) {
      this.handler(connection)
    }

    this.dispatchEvent(new CustomEvent<Connection>('connection', { detail: connection }))
  }

  async close () {
    if (this.server != null) {
      await this.server.close()
    }

    this.dispatchEvent(new CustomEvent('close'))
  }

  registerSignallingChannel (signallingChannel: RTCDataChannel) {
    this.server?.registerSignallingChannel(signallingChannel)
  }

  deRegisterSignallingChannel () {
    if (!(this.server instanceof WebRTCDirectSigServer)) {
      return
    }

    this.server.deRegisterSignallingChannel()

    // Unset this.multiaddr as this listener becomes inactive if signalling channel is closed
    // Dispatch 'close' event so that node's announce addresses get updated (through getAddrs())
    this.multiaddr = undefined
    this.dispatchEvent(new CustomEvent('close'))
  }

  getAddrs () {
    if (this.multiaddr != null) {
      return [this.multiaddr]
    }

    return []
  }
}

export function createListener (options: WebRTCDirectListenerOptions) {
  return new WebRTCDirectListener(options.upgrader, options.signallingEnabled, options.wrtc, options.receiverOptions, options.handler)
}
