export interface JoinRequest {
  type: 'JoinRequest'
  peerId: string
}

export interface ConnectRequest {
  type: 'ConnectRequest'
  src: string
  dst: string
  signal: string
}

export interface ConnectResponse {
  type: 'ConnectResponse'
  src: string
  dst: string
  signal: string
}

export type SignallingMessage = JoinRequest | ConnectRequest | ConnectResponse;
