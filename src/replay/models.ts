import type { Period, SymbolInfo } from '@klinecharts/pro'
import { alignOpenTime, LEGACY_THREE_DAY_TIMEFRAME } from '../market-data/intervals'

export type ReplaySpeed = 1 | 2 | 5 | 10
export type ReplayStatus = 'paused' | 'completed'

export interface ReplayTradingConfig {
  initialBalance: string
  leverage: number
  feeRate: string
  slippageRate: string
  maintenanceMarginRate: string
  liquidationFeeRate: string
}

export const DEFAULT_TRADING_CONFIG: ReplayTradingConfig = Object.freeze({
  initialBalance: '10000',
  leverage: 10,
  feeRate: '0.0005',
  slippageRate: '0.0002',
  maintenanceMarginRate: '0.004',
  liquidationFeeRate: '0.005',
})

export interface ReplaySession {
  schemaVersion: 2
  id: string
  symbol: SymbolInfo
  period: Period
  startTime: number
  endTime: number
  currentTime: number
  currentIndex: number
  candleCount: number
  speed: ReplaySpeed
  status: ReplayStatus
  hasTrades: boolean
  active: boolean
  tradingConfig: ReplayTradingConfig
  createdAt: number
  updatedAt: number
}

export interface CreateReplaySessionInput {
  symbol: SymbolInfo
  period: Period
  startTime: number
  endTime?: number
  speed?: ReplaySpeed
  tradingConfig?: ReplayTradingConfig
}

export interface ReplayContext {
  sessionId: string
  symbol: string
  timeframe: string
  currentTime: number
  endTime?: number
}

/** Keep older sessions on their original three-day grid so trades replay identically. */
export function replaySourceTimeframe(session: Pick<ReplaySession, 'period' | 'startTime'>): string {
  const timeframe = session.period.text
  return timeframe === '3d' && alignOpenTime(session.startTime, timeframe, 'floor') !== session.startTime
    ? LEGACY_THREE_DAY_TIMEFRAME : timeframe
}
