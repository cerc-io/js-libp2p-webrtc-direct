// JoinRequest is made by a peer once as soon as it opens a signalling channel to the relay node
export interface JoinRequest {
  type: 'JoinRequest'
  peerId: string
}

// ConnectRequest is made on dial by a peer to another peer
// listening through a signalling channel to the same primary relay node;
// src and dst are used by the relay node to route the messages
export interface ConnectRequest {
  type: 'ConnectRequest'
  src: string
  dst: string
  signal: string
}

// ConnectResponse is made by a peer to another peer on a ConnectRequest to establish a direct webrtc connection
export interface ConnectResponse {
  type: 'ConnectResponse'
  src: string
  dst: string
  signal: string
}

export type SignallingMessage = JoinRequest | ConnectRequest | ConnectResponse;
