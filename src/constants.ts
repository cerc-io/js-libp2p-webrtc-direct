
// p2p multi-address code
export const CODE_P2P = 421
export const CODE_CIRCUIT = 290

// Use a supported protocol id in multiaddr to listen through signalling channel
// Need to use one of the supported protocol names (list: https://github.com/multiformats/multiaddr/blob/master/protocols.csv) for the multiaddr to be valid
export const P2P_WEBRTC_STAR_ID = 'p2p-webrtc-star'

// Time to wait for a connection to close gracefully before destroying it
// manually
export const CLOSE_TIMEOUT = 2000

// TTL for time cache of seen signalling channel messages in relay nodes
export const SEEN_CACHE_TTL = 30 * 1000 // 30 seconds

// Interval (ms) to check if channel is closed
export const CHANNEL_CLOSED_TIMEOUT = 5 * 1000 // 5 seconds
