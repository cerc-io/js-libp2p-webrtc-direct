/* eslint-env mocha */

import { expect } from 'aegir/chai'
import { multiaddr } from '@multiformats/multiaddr'
import { pipe } from 'it-pipe'
import all from 'it-all'
import { fromString } from 'uint8arrays/from-string'
import { mockRegistrar, mockUpgrader } from '@libp2p/interface-mocks'
import type { Transport, Upgrader } from '@libp2p/interface-transport'
import type { Connection } from '@libp2p/interface-connection'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { Uint8ArrayList } from 'uint8arraylist'
import type { Source } from 'it-stream-types'
import { pEvent } from 'p-event'
import { TimeoutController } from 'timeout-abort-controller'

import { P2P_WEBRTC_STAR_ID } from '../src/constants.js'
import {
  ECHO_PROTOCOL,
  REMOTE_MULTIADDR_IP4,
  REMOTE_MULTIADDR_IP6,
  REMOTE_MULTIADDR_IP4_PEER,
  PEER_ID_1
} from './constants.js'

async function * toBytes (source: Source<Uint8ArrayList>) {
  for await (const list of source) {
    yield * list
  }
}

export default (create: (peerIdArg?: PeerId) => Promise<Transport>) => {
  describe('dial', function () {
    this.timeout(30 * 1000)

    let upgrader: Upgrader

    beforeEach(() => {
      const registrar = mockRegistrar()
      void registrar.handle(ECHO_PROTOCOL, ({ stream }) => {
        void pipe(
          stream,
          stream
        )
      })
      upgrader = mockUpgrader({
        registrar
      })
    })

    it('dial on IPv4', async () => {
      const wd = await create()
      const conn = await wd.dial(REMOTE_MULTIADDR_IP4, { upgrader })
      const stream = await conn.newStream(ECHO_PROTOCOL)
      const data = fromString('some data')

      const values = await pipe(
        [data],
        stream,
        toBytes,
        async (source) => await all(source)
      )

      expect(values).to.deep.equal([data])
      await conn.close()
    })

    it('dials the same server twice', async () => {
      const wd = await create()
      const conn1 = await wd.dial(REMOTE_MULTIADDR_IP4, { upgrader })
      const conn2 = await wd.dial(REMOTE_MULTIADDR_IP4, { upgrader })

      const values = await Promise.all(
        [conn1, conn2].map(async conn => {
          const stream = await conn1.newStream(ECHO_PROTOCOL)
          const data = fromString('some data ' + conn.id)

          const values = await pipe(
            [data],
            stream,
            toBytes,
            async (source) => await all(source)
          )

          return values
        })
      )

      expect(values).to.deep.equal([[
        fromString('some data ' + conn1.id)
      ], [
        fromString('some data ' + conn2.id)
      ]])

      await conn1.close()
      await conn2.close()
    })

    it('dial offline / non-existent node on IPv4, check callback', async () => {
      const wd = await create()
      const maOffline = multiaddr('/ip4/127.0.0.1/tcp/55555/http/p2p-webrtc-direct')

      await expect(wd.dial(maOffline, { upgrader })).to.eventually.be.rejected()
    })

    it('dial on IPv6', async () => {
      const wd = await create()
      const conn = await wd.dial(REMOTE_MULTIADDR_IP6, { upgrader })
      const stream = await conn.newStream(['/echo/1.0.0'])
      const data = fromString('some data')

      const values = await pipe(
        [data],
        stream,
        toBytes,
        async (source) => await all(source)
      )

      expect(values).to.deep.equal([data])
      await conn.close()
    })
  })

  describe('dial using signalling channel', function () {
    this.timeout(30 * 1000)

    const registrar = mockRegistrar()
    void registrar.handle(ECHO_PROTOCOL, ({ stream }) => {
      void pipe(
        stream,
        stream
      )
    })
    const upgrader = mockUpgrader({ registrar })

    let wd: Transport
    let conn: Connection
    let conn1: Connection

    const listenMultiaddr = multiaddr(`${REMOTE_MULTIADDR_IP4_PEER.toString()}/${P2P_WEBRTC_STAR_ID}`)
    const dialAddress1 = multiaddr(`${listenMultiaddr.toString()}/p2p/${PEER_ID_1.toString()}`)

    beforeEach(async () => {
      wd = await create()
    })

    afterEach(async () => {
      await conn.close()
      await conn1.close()
    })

    it('dial on IPv4', async () => {
      const listener = wd.createListener({ upgrader })
      await listener.listen(listenMultiaddr)

      conn = await wd.dial(REMOTE_MULTIADDR_IP4_PEER, { upgrader })

      // Wait for peer to join signalling network
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const wd1 = await create(PEER_ID_1)
      const listener1 = wd1.createListener({ upgrader })
      await listener1.listen(listenMultiaddr)

      conn1 = await wd1.dial(REMOTE_MULTIADDR_IP4_PEER, { upgrader })

      // Wait for peer to join signalling network
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Dial and wait for listener to know of the connect
      const connToNewPeer = await wd.dial(dialAddress1, { upgrader })
      await pEvent(listener1, 'connection')

      const stream = await connToNewPeer.newStream(ECHO_PROTOCOL)
      const data = fromString('some data')

      const values = await pipe(
        [data],
        stream,
        toBytes,
        async (source) => await all(source)
      )

      expect(values).to.deep.equal([data])

      await connToNewPeer.close()
    })

    it('dials the same peer twice', async () => {
      const listener = wd.createListener({ upgrader })
      await listener.listen(listenMultiaddr)

      conn = await wd.dial(REMOTE_MULTIADDR_IP4_PEER, { upgrader })

      // Wait for peer to join signalling network
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const wd1 = await create(PEER_ID_1)
      const listener1 = wd1.createListener({ upgrader })
      await listener1.listen(listenMultiaddr)

      conn1 = await wd1.dial(REMOTE_MULTIADDR_IP4_PEER, { upgrader })

      // Wait for peer to join signalling network
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Dial and wait for listener to know of the connect
      const conn1ToNewPeer = await wd.dial(dialAddress1, { upgrader })
      const conn2ToNewPeer = await wd.dial(dialAddress1, { upgrader })

      const values = await Promise.all(
        [conn1ToNewPeer, conn2ToNewPeer].map(async connToNewPeer => {
          const stream = await connToNewPeer.newStream(ECHO_PROTOCOL)
          const data = fromString('some data ' + connToNewPeer.id)

          const values = await pipe(
            [data],
            stream,
            toBytes,
            async (source) => await all(source)
          )

          return values
        })
      )

      expect(values).to.deep.equal([[
        fromString('some data ' + conn1ToNewPeer.id)
      ], [
        fromString('some data ' + conn2ToNewPeer.id)
      ]])

      await conn1ToNewPeer.close()
      await conn2ToNewPeer.close()
    })

    it('dial offline / non-existent node on IPv4, check callback', async () => {
      const listener = wd.createListener({ upgrader })
      await listener.listen(listenMultiaddr)

      conn = await wd.dial(REMOTE_MULTIADDR_IP4_PEER, { upgrader })

      // Wait for peer to join signalling network
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const dialTimeout = 5000 // 5 sec
      const timeoutController = new TimeoutController(dialTimeout)

      // Expect an attempt to dial to another non-existent peer to fail
      await expect(wd.dial(dialAddress1, { upgrader, signal: timeoutController.signal })).to.eventually.be.rejected()
    })
  })
}
