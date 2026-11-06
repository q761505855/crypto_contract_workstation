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
  schemaVersion: 2
  sessionId: string
  symbol: string
  config: ReplayTradingConfig
  account: SimulationAccount
  positions: SimulationPosition[]
  trades: SimulationTrade[]
  ledger: SimulationLedgerEntry[]
  stats: SimulationStats
  warning: string | null
  updatedAt: number
}

/** Version 1 is accepted only at storage/import boundaries. */
export interface LegacySimulationState extends Omit<SimulationState, 'schemaVersion' | 'positions'> {
  schemaVersion: 1
  position: SimulationPosition | null
}

export type StoredSimulationState = SimulationState | LegacySimulationState

/** Upgrade single positions and legacy prices without mutating the saved input. */
export function normalizeSimulationStatePrices(state: StoredSimulationState): SimulationState {
  if (state.schemaVersion !== 1 && state.schemaVersion !== 2) throw new Error('模拟状态版本不受支持')
  const saved = structuredClone(state)
  const positions = saved.schemaVersion === 1
    ? saved.position === null ? [] : [saved.position]
    : saved.positions
  if (!Array.isArray(positions) || positions.length > 2 ||
      new Set(positions.map(position => position.side)).size !== positions.length) {
    throw new Error('模拟持仓必须是不同方向的最多两个仓位')
  }
  for (const value of positions) {
    if (!['long', 'short'].includes(value.side)) throw new Error('模拟持仓方向无效')
    const position = value as SimulationPosition & { markPrice?: string }
    const lastPrice = position.lastPrice ?? position.markPrice
    if (typeof lastPrice !== 'string' || !Number.isFinite(Number(lastPrice)) || Number(lastPrice) <= 0) {
      throw new Error('模拟持仓缺少有效成交价格')
    }
    position.lastPrice = lastPrice
    delete position.markPrice
  }
  const { position: _legacy, ...fields } = saved as StoredSimulationState & { position?: SimulationPosition | null }
  const result: SimulationState = { ...fields, schemaVersion: 2, positions }
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
