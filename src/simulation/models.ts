import type { ReplayTradingConfig } from '../replay/models'

export type PositionSide = 'long' | 'short'
export type TradeSide = 'buy' | 'sell'
export type TradeAction =
  | 'open'
  | 'add'
  | 'reduce'
  | 'close'
  | 'take_profit'
  | 'stop_loss'
  | 'liquidation'
export type TradeReason =
  | 'manual'
  | 'take_profit'
  | 'stop_loss'
  | 'liquidation'

export interface SimulationAccount {
  initialBalance: string
  walletBalance: string
  equity: string
  availableBalance: string
  usedMargin: string
  realizedPnl: string
  unrealizedPnl: string
  totalFees: string
  totalLiquidationFees: string
}

export interface SimulationPosition {
  symbol: string
  side: PositionSide
  quantity: string
  entryPrice: string
  lastPrice: string
  notional: string
  leverage: number
  isolatedMargin: string
  maintenanceMarginRate: string
  liquidationPrice: string
  takeProfitPrice: string | null
  stopLossPrice: string | null
  unrealizedPnl: string
  openedAt: number
  updatedAt: number
  riskActiveAfterTime: number
  takeProfitActiveAfterTime: number | null
  stopLossActiveAfterTime: number | null
}

export interface SimulationTrade {
  tradeId: string
  sessionId: string
  timestamp: number
  symbol: string
  side: TradeSide
  positionSide: PositionSide
  action: TradeAction
  quantity: string
  price: string
  notional: string
  fee: string
  liquidationFee: string
  slippage: string
  realizedPnl: string
  reason: TradeReason
}

export type LedgerEntryType =
  | 'initial_balance'
  | 'trading_fee'
  | 'realized_pnl'
  | 'liquidation_fee'

export interface SimulationLedgerEntry {
  entryId: string
  sessionId: string
  timestamp: number
  type: LedgerEntryType
  amount: string
  balanceAfter: string
  tradeId: string | null
}

export interface SimulationStats {
  totalReturn: string
  totalReturnRate: string
  totalTrades: number
  completedPositions: number
  wins: number
  losses: number
  winRate: string
  largestWin: string
  largestLoss: string
  liquidations: number
}

export interface SimulationState {
  schemaVersion: 1
  sessionId: string
  symbol: string
  config: ReplayTradingConfig
  account: SimulationAccount
  position: SimulationPosition | null
  trades: SimulationTrade[]
  ledger: SimulationLedgerEntry[]
  stats: SimulationStats
  warning: string | null
  updatedAt: number
}

/** Migrate old saved positions at the boundary; canonical snapshots contain ordinary prices only. */
export function normalizeSimulationStatePrices(state: SimulationState): SimulationState {
  const result = structuredClone(state)
  if (result.position !== null) {
    const position = result.position as SimulationPosition & { markPrice?: string }
    const lastPrice = position.lastPrice ?? position.markPrice
    if (typeof lastPrice !== 'string' || !Number.isFinite(Number(lastPrice)) || Number(lastPrice) <= 0) {
      throw new Error('模拟持仓缺少有效成交价格')
    }
    position.lastPrice = lastPrice
    delete position.markPrice
  }
  if (result.warning !== null && /缺少.*标记价格/.test(result.warning)) result.warning = null
  return result
}

export interface OrderSizeInput {
  margin?: string
  quantity?: string
}

export interface OrderPreview {
  quantity: string
  fillPrice: string
  notional: string
  requiredMargin: string
  fee: string
  estimatedLiquidationPrice: string
}

export interface CandleProcessResult {
  exitAction: TradeAction | null
  warning: string | null
}
