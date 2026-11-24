import { VolumeProfileLevels, type BigTradeMode } from './order-flow'
import { aggregateTradeBubbles, type TradeBubble } from './order-flow-bars'
import { filterTradeBubbles, limitTradeBubbles, type BubbleFilter } from './order-flow-bubbles'
import { footprintTradeLevels } from './order-flow-metrics'
import type { orderFlowSettings } from './order-flow-preferences'

export const CANDLE_TRADE_STRIDE = 4
export type TradeColumns = Float64Array<ArrayBuffer>

export interface ProfileTask {
  kind: 'profile'
  values: TradeColumns
}

export interface FootprintTask {
  kind: 'footprint'
  values: TradeColumns
  open: number
  firstBybitPrice?: number
  projected: boolean
  precision: number
  settings: ReturnType<typeof orderFlowSettings<'footprint'>>
}

export interface BubbleTask {
  kind: 'bubbles'
  values: TradeColumns
  filter: BubbleFilter
  mode: BigTradeMode
  limit: number
  firstRow?: number
}

export interface BubbleResult { row: number; size: number; count?: number; amount: number }
export type OrderFlowTask = ProfileTask | FootprintTask | BubbleTask
export type OrderFlowTaskResult<T extends OrderFlowTask = OrderFlowTask> = T extends BubbleTask ? BubbleResult[] : TradeColumns
export type OrderFlowWorkerReply = { result: OrderFlowTaskResult } | { error: string }

function* unpackTrades(values: TradeColumns): Iterable<TradeBubble> {
  for (let i = 0; i < values.length; i += CANDLE_TRADE_STRIDE) {
    const size = values[i + 1]
    yield { trade: { id: String(i / CANDLE_TRADE_STRIDE), price: values[i], size: Math.abs(size),
      side: size > 0 ? 'buy' : 'sell', timeUs: values[i + 2], venue: values[i + 3] ? 'OKX' : undefined } }
  }
}

export function runOrderFlowTask<T extends OrderFlowTask>(task: T): OrderFlowTaskResult<T>
export function runOrderFlowTask(task: OrderFlowTask): OrderFlowTaskResult {
  if (task.kind === 'profile') {
    const levels = new VolumeProfileLevels()
    for (let i = 0; i < task.values.length; i += 2) levels.add(task.values[i], task.values[i + 1])
    return levels.pack()
  }
  const trades = unpackTrades(task.values)
  if (task.kind === 'footprint') {
    const levels = footprintTradeLevels(trades, task.settings, task.precision,
      trade => task.projected && !trade.venue && task.firstBybitPrice ? trade.price * task.open / task.firstBybitPrice : trade.price)
    const totals = new Float64Array(levels.size * 4)
    let offset = 0
    for (const [tick, { buy, sell, volume }] of levels) {
      totals[offset++] = tick
      totals[offset++] = buy
      totals[offset++] = sell
      totals[offset++] = volume
    }
    return totals
  }
  const points = task.mode === 'aggregate'
    ? aggregateTradeBubbles(trades, task.filter.unit === 'notional' ? task.filter.minimum : 0) : trades
  const selected = limitTradeBubbles([[0, filterTradeBubbles(points, task.filter)]], task.limit).get(0) ?? []
  return selected.map(({ trade, amount, count }) =>
    ({ row: (task.firstRow ?? 0) + Number(trade.id), size: trade.size, amount, count }))
}
