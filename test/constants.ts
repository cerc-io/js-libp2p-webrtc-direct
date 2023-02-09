import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'

export const ECHO_PROTOCOL = '/echo/1.0.0'

export const REMOTE_MULTIADDR_IP4 = multiaddr('/ip4/127.0.0.1/tcp/12345/http/p2p-webrtc-direct')
export const REMOTE_MULTIADDR_IP6 = multiaddr('/ip6/::1/tcp/12346/http/p2p-webrtc-direct')

export const PEER_ID = peerIdFromString('QmWeo5ZWjC7mVDNsbBub6WfcuT3MktVuKF7MMBXKrTMCsE')
export const PEER_ID_1 = peerIdFromString('QmP7kBSdTjivW1e8zMnjUHkHCYFzVMuN14ycqyoRz3aJor')
export const SIG_PEER_ID = peerIdFromString('QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSooo2a')
export const REMOTE_MULTIADDR_IP4_PEER = multiaddr(`${REMOTE_MULTIADDR_IP4.toString()}/p2p/${SIG_PEER_ID.toString()}`)
