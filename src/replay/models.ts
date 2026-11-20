import type { Period, SymbolInfo } from '@klinecharts/pro'
import { alignOpenTime, klineCloseBoundary, LEGACY_THREE_DAY_TIMEFRAME } from '../market-data/intervals'
import type { CTraderReplayStepPeriod } from './step-periods'
import type { CTraderTradingTerms } from '../simulation/ctrader-trading'

export type ReplaySpeed = 1 | 2 | 5 | 10
export type ReplayStatus = 'paused' | 'completed'

export interface ReplayTradingConfig {
  initialBalance: string
  leverage: number
  feeRate: string
  slippageRate: string
  maintenanceMarginRate: string
  liquidationFeeRate: string
  ctrader?: CTraderTradingTerms
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
  /** Exclusive visibility boundary of the last processed price. */
  visibleUntil?: number
  /** Missing on legacy Binance sessions. */
  marketSource?: 'ctrader' | 'binance'
  /** cTrader step that produced the current cursor. */
  cursorTimeframe?: CTraderReplayStepPeriod
  /** Zero-based quote order within currentTime when the cursor is on a Tick. */
  cursorTickIndex?: number
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
  initialBalance?: string
  slippageRate?: string
}

export interface ReplayContext {
  sessionId: string
  symbol: string
  timeframe: string
  currentTime: number
  visibleUntil?: number
  cursorTickIndex?: number
  endTime?: number
}

export function replayVisibleUntil(context: Pick<ReplayContext, 'currentTime' | 'timeframe' | 'visibleUntil'>): number {
  return context.visibleUntil ?? klineCloseBoundary(context.currentTime, context.timeframe)
}

export function replayConfirmedUntil(context: ReplayContext): number {
  // A native bar ending on the current Tick could include later quotes in that millisecond.
  return replayVisibleUntil(context) - Number(context.cursorTickIndex !== undefined)
}

export function compareReplayPositions(left: ReplayContext, right: ReplayContext): number {
  return replayVisibleUntil(left) - replayVisibleUntil(right) ||
    (left.cursorTickIndex ?? Number.MAX_SAFE_INTEGER) - (right.cursorTickIndex ?? Number.MAX_SAFE_INTEGER)
}

export function sessionVisibleUntil(session: ReplaySession): number {
  return replayVisibleUntil({ ...session, timeframe: replaySourceTimeframe(session) })
}

/** Keep older sessions on their original three-day grid so trades replay identically. */
export function replaySourceTimeframe(session: Pick<ReplaySession, 'period' | 'startTime'>): string {
  const timeframe = session.period.text
  return timeframe === '3d' && alignOpenTime(session.startTime, timeframe, 'floor') !== session.startTime
    ? LEGACY_THREE_DAY_TIMEFRAME : timeframe
}
