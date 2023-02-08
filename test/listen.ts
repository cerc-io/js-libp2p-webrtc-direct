/* eslint-env mocha */

import { expect } from 'aegir/chai'
import { multiaddr } from '@multiformats/multiaddr'
import { mockRegistrar, mockUpgrader } from '@libp2p/interface-mocks'
import { isBrowser } from 'wherearewe'
import { pipe } from 'it-pipe'
import { pEvent } from 'p-event'
import type { Transport } from '@libp2p/interface-transport'
import type { Connection } from '@libp2p/interface-connection'
import type { PeerId } from '@libp2p/interface-peer-id'
import defer from 'p-defer'

import { P2P_WEBRTC_STAR_ID } from '../src/constants.js'
import {
  ECHO_PROTOCOL,
  PEER_ID_1,
  REMOTE_MULTIADDR_IP4_PEER
} from './constants.js'

export default (create: (peerIdArg?: PeerId) => Promise<Transport>) => {
  describe('listen', function () {
    this.timeout(20 * 1000)

    if (isBrowser) {
      return
    }

    let wd: Transport

    const ma = multiaddr('/ip4/127.0.0.1/tcp/20123/http/p2p-webrtc-direct')

    before(async () => {
      wd = await create()
    })

    it('listen, check for promise', async () => {
      const listener = wd.createListener({
        upgrader: mockUpgrader()
      })

      await listener.listen(ma)
      await listener.close()
    })

    it('listen, check for listening event', (done) => {
      const listener = wd.createListener({
        upgrader: mockUpgrader()
      })

      listener.addEventListener('listening', () => {
        void listener.close()
          .then(done, done)
      }, {
        once: true
      })
      void listener.listen(ma)
    })

    it('listen, check for the close event', (done) => {
      const listener = wd.createListener({
        upgrader: mockUpgrader()
      })
      void listener.listen(ma).then(async () => {
        listener.addEventListener('close', () => done(), {
          once: true
        })

        await listener.close()
      })
    })

    it('listen in 0.0.0.0', async () => {
      const listener = wd.createListener({
        upgrader: mockUpgrader()
      })

      await listener.listen(multiaddr('/ip4/0.0.0.0/tcp/48322'))
      await listener.close()
    })

    it('listen in port 0', async () => {
      const listener = wd.createListener({
        upgrader: mockUpgrader()
      })

      await listener.listen(multiaddr('/ip4/127.0.0.1/tcp/0'))
      await listener.close()
    })

    it('listen on IPv6 addr', async () => {
      const listener = wd.createListener({
        upgrader: mockUpgrader()
      })

      await listener.listen(multiaddr('/ip6/::1/tcp/48322'))
      await listener.close()
    })

    it('getAddrs', async () => {
      const listener = wd.createListener({
        upgrader: mockUpgrader()
      })

      await listener.listen(ma)

      const addrs = listener.getAddrs()
      expect(addrs[0]).to.deep.equal(ma)

      await listener.close()
    })

    it('should untrack conn after being closed', async function () {
      const ma1 = multiaddr('/ip4/127.0.0.1/tcp/12346/http/p2p-webrtc-direct')
      const registrar = mockRegistrar()
      void registrar.handle(ECHO_PROTOCOL, ({ stream }) => {
        void pipe(
          stream,
          stream
        )
      })
      const upgrader = mockUpgrader({
        registrar
      })

      const wd1 = await create()
      const listener1 = wd1.createListener({
        upgrader,
        handler: (conn) => {
          void conn.newStream([ECHO_PROTOCOL])
            .then((stream) => {
              void pipe(stream, stream)
            })
        }
      })

      await listener1.listen(ma1)
      expect(listener1).to.have.nested.property('server.connections').that.has.lengthOf(0)

      const conn = await wd.dial(ma1, {
        upgrader
      })

      // wait for listener to know of the connect
      await pEvent(listener1, 'connection')

      expect(listener1).to.have.nested.property('server.connections').that.has.lengthOf(1)

      await conn.close()

      // wait for listener to know of the disconnect
      await new Promise((resolve) => {
        setTimeout(resolve, 1000)
      })

      expect(listener1).to.have.nested.property('server.connections').that.has.lengthOf(0)

      await listener1.close()
    })

    it('should have remoteAddress in listener connection', async function () {
      const ma1 = multiaddr('/ip4/127.0.0.1/tcp/12346/http/p2p-webrtc-direct')
      const registrar = mockRegistrar()
      void registrar.handle(ECHO_PROTOCOL, ({ stream }) => {
        void pipe(
          stream,
          stream
        )
      })
      const upgrader = mockUpgrader({
        registrar
      })

      const wd1 = await create()
      const listener1 = wd1.createListener({
        handler: (conn) => {
          expect(conn.remoteAddr).to.exist()

          void conn.newStream([ECHO_PROTOCOL])
            .then((stream) => {
              void pipe(stream, stream)
            })
        },
        upgrader
      })

      await listener1.listen(ma1)
      const conn = await wd.dial(ma1, {
        upgrader
      })
      expect(conn.remoteAddr).to.exist()

      await conn.close()
      await listener1.close()
    })
  })

  describe('listen using signalling channel', function () {
    this.timeout(20 * 1000)

    const registrar = mockRegistrar()
    const upgrader = mockUpgrader({ registrar })
    let wd: Transport
    let conn: Connection

    const listenMultiaddr = multiaddr(`${REMOTE_MULTIADDR_IP4_PEER.toString()}/${P2P_WEBRTC_STAR_ID}`)
    const dialAddress1 = multiaddr(`${listenMultiaddr.toString()}/p2p/${PEER_ID_1.toString()}`)

    beforeEach(async () => {
      wd = await create()
    })

    afterEach(async () => {
      await conn.close()
    })

    it('listen, check for promise', async () => {
      const listener = wd.createListener({ upgrader })

      await listener.listen(listenMultiaddr)
      conn = await wd.dial(REMOTE_MULTIADDR_IP4_PEER, { upgrader })

      await listener.close()
    })

    it('listen, check for listening event', async () => {
      const listener = wd.createListener({ upgrader })

      const eventPromise = defer()

      listener.addEventListener('listening', () => {
        void listener.close()
          .then(eventPromise.resolve)
      }, {
        once: true
      })

      await listener.listen(listenMultiaddr)
      await wd.dial(REMOTE_MULTIADDR_IP4_PEER, { upgrader })

      await eventPromise.promise
    })

    it('listen, check for the close event', async () => {
      const listener = wd.createListener({ upgrader })

      const eventPromise = defer()

      void listener.listen(listenMultiaddr).then(async () => {
        listener.addEventListener('close', () => eventPromise.resolve(), {
          once: true
        })
        await listener.close()
      })
      conn = await wd.dial(REMOTE_MULTIADDR_IP4_PEER, { upgrader })

      await eventPromise.promise
    })

    it('getAddrs', async () => {
      const listener = wd.createListener({ upgrader: mockUpgrader() })

      await listener.listen(listenMultiaddr)
      conn = await wd.dial(REMOTE_MULTIADDR_IP4_PEER, { upgrader })

      const addrs = listener.getAddrs()
      expect(addrs[0]).to.deep.equal(listenMultiaddr)

      await listener.close()
    })

    it('should untrack conn after being closed', async function () {
      const registrar = mockRegistrar()
      void registrar.handle(ECHO_PROTOCOL, ({ stream }) => {
        void pipe(
          stream,
          stream
        )
      })
      const upgrader = mockUpgrader({ registrar })

      const listener = wd.createListener({ upgrader })

      await listener.listen(listenMultiaddr)
      await wd.dial(REMOTE_MULTIADDR_IP4_PEER, { upgrader })

      // Wait for peer to join signalling network
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const wd1 = await create(PEER_ID_1)
      const listener1 = wd1.createListener({ upgrader })

      await listener1.listen(listenMultiaddr)
      conn = await wd1.dial(REMOTE_MULTIADDR_IP4_PEER, { upgrader })

      // Wait for peer to join signalling network
      await new Promise((resolve) => setTimeout(resolve, 2000))

      expect(listener1).to.have.nested.property('server.channels').that.has.lengthOf(0)

      // Dial and wait for listener to know of the connect
      const connToNewPeer = await wd.dial(dialAddress1, { upgrader })
      await pEvent(listener1, 'connection')

      expect(listener1).to.have.nested.property('server.channels').that.has.lengthOf(1)

      // Close conn and wait for listener to know of the disconnect
      await connToNewPeer.close()
      await new Promise((resolve) => setTimeout(resolve, 1000))

      expect(listener1).to.have.nested.property('server.channels').that.has.lengthOf(0)

      await listener.close()
      await listener1.close()
    })

    it('should have remoteAddress in listener connection', async function () {
      const registrar = mockRegistrar()
      void registrar.handle(ECHO_PROTOCOL, ({ stream }) => {
        void pipe(
          stream,
          stream
        )
      })
      const upgrader = mockUpgrader({ registrar })

      const listener = wd.createListener({ upgrader })

      await listener.listen(listenMultiaddr)
      await wd.dial(REMOTE_MULTIADDR_IP4_PEER, { upgrader })

      // Wait for peer to join signalling network
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const wd1 = await create(PEER_ID_1)
      const listener1 = wd1.createListener({
        handler: (conn) => {
          expect(conn.remoteAddr).to.exist()
        },
        upgrader
      })

      await listener1.listen(listenMultiaddr)
      conn = await wd1.dial(REMOTE_MULTIADDR_IP4_PEER, { upgrader })

      // Wait for peer to join signalling network
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const connToNewPeer = await wd.dial(dialAddress1, { upgrader })
      expect(connToNewPeer.remoteAddr).to.exist()

      await connToNewPeer.close()
      await listener.close()
      await listener1.close()
    })
  })
}
