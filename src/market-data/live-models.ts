export type LiveConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'

export interface LiveMarketStatus {
  connection: LiveConnectionState
  lastMessageTime: number | null
  latencyMs: number | null
  candleClosed: boolean | null
  lastPrice: string | null
  markPrice: string | null
  reconnectAttempt: number
  warning: string
}

export const INITIAL_LIVE_STATUS: LiveMarketStatus = {
  connection: 'disconnected',
  lastMessageTime: null,
  latencyMs: null,
  candleClosed: null,
  lastPrice: null,
  markPrice: null,
  reconnectAttempt: 0,
  warning: '',
}
