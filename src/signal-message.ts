export interface JoinRequest {
  type: 'JoinRequest'
  peerId: string
}

export interface ConnectSignal {
  type: 'ConnectSignal'
  src: string
  dst: string
  signal: string
}

export type SignallingMessage = JoinRequest | ConnectSignal;
