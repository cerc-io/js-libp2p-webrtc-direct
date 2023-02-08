/* eslint-env mocha */

import { expect } from 'aegir/chai'
import { multiaddr } from '@multiformats/multiaddr'

import { P2P_WEBRTC_STAR_ID, WebRTCDirectNodeType, webRTCDirect } from '../src/index.js'
import { PEER_ID, PEER_ID_1, REMOTE_MULTIADDR_IP4, REMOTE_MULTIADDR_IP4_PEER, SIG_PEER_ID } from './constants.js'

describe('filter', () => {
  // Peer listen address (using primary relay peer id)
  const peerSigListenAddr = `${REMOTE_MULTIADDR_IP4_PEER.toString()}/${P2P_WEBRTC_STAR_ID}`
  // Invalid peer listen address (not using primary relay peer id)
  const peerSigInvalidListenAddr = `${REMOTE_MULTIADDR_IP4.toString()}/p2p/${PEER_ID_1.toString()}/${P2P_WEBRTC_STAR_ID}`

  // Peer dial (through signalling channel) address
  const peerSigDialAddr = `${REMOTE_MULTIADDR_IP4_PEER.toString()}/${P2P_WEBRTC_STAR_ID}/p2p/${PEER_ID_1.toString()}`
  // Invalid peer dial (through signalling channel) address (not having 'p2p-webrtc-direct')
  const peerInvalidSigDialAddr = `/ip4/127.0.0.1/tcp/9090/ipfs/${SIG_PEER_ID.toString()}/${P2P_WEBRTC_STAR_ID}/p2p/${PEER_ID_1.toString()}`

  it('filter a single addr for this transport', () => {
    const wd = webRTCDirect()({
      peerId: PEER_ID
    })
    const ma = multiaddr('/ip4/127.0.0.1/tcp/9090/http/p2p-webrtc-direct')

    const filtered = wd.filter([ma])
    expect(filtered.length).to.equal(1)
  })

  it('filters non valid webrtc-direct multiaddrs (signalling disabled)', () => {
    const wd = webRTCDirect()({
      peerId: PEER_ID
    })
    const maArr = [
      multiaddr('/ip4/1.2.3.4/tcp/3456/http/p2p-webrtc-direct'),
      multiaddr('/ip4/127.0.0.1/tcp/9090/ws'),
      multiaddr('/ip4/127.0.0.1/tcp/9090/ws/p2p-webrtc-direct/ipfs/QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSoooo2'),
      multiaddr('/ip4/127.0.0.1/tcp/9090/ipfs/QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSoooo4'),
      multiaddr('/ip4/127.0.0.1/tcp/9090/ipfs/QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSoooo4' +
        '/p2p-circuit/ipfs/QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSoooo5'),
      multiaddr(peerSigListenAddr),
      multiaddr(peerSigDialAddr)
    ]

    const filtered = wd.filter(maArr)
    expect(filtered.length).to.equal(1)
  })

  it('filters non valid webrtc-direct multiaddrs (signalling enabled)', () => {
    const wd = webRTCDirect({
      enableSignalling: true,
      nodeType: WebRTCDirectNodeType.Peer,
      relayPeerId: SIG_PEER_ID.toString()
    })({
      peerId: PEER_ID
    })
    const maArr = [
      multiaddr('/ip4/1.2.3.4/tcp/3456/http/p2p-webrtc-direct'),
      multiaddr('/ip4/127.0.0.1/tcp/9090/ws'),
      multiaddr('/ip4/127.0.0.1/tcp/9090/ws/p2p-webrtc-direct/ipfs/QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSoooo2'),
      multiaddr('/ip4/127.0.0.1/tcp/9090/ipfs/QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSoooo4'),
      multiaddr('/ip4/127.0.0.1/tcp/9090/ipfs/QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSoooo4' +
        '/p2p-circuit/ipfs/QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSoooo5'),
      multiaddr(peerSigListenAddr),
      multiaddr(peerSigInvalidListenAddr),
      multiaddr(peerSigDialAddr),
      multiaddr(peerInvalidSigDialAddr)
    ]

    const expectedAddrs = [
      multiaddr('/ip4/1.2.3.4/tcp/3456/http/p2p-webrtc-direct'),
      multiaddr(peerSigListenAddr),
      multiaddr(peerSigDialAddr)
    ]
    const filtered = wd.filter(maArr)

    expect(filtered).to.eql(expectedAddrs)
  })
})
