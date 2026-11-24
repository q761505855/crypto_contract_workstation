import { tradeThresholdValue, type BigTradeMode, type BigTradeThreshold, type BigTradeUnits } from './order-flow'
import { displayedTradeBubbles, type TradeBar, type TradeBubble } from './order-flow-bars'
import { MAX_VISIBLE_BUBBLES } from './order-flow-preferences'

export type BubbleFilter = BigTradeThreshold & BigTradeUnits
export type DisplayedTradeBubble = TradeBubble & { amount: number }

export function filteredTradeBubbles(bar: TradeBar, mode: BigTradeMode, filter: BubbleFilter): Iterable<DisplayedTradeBubble> {
  return filterTradeBubbles(displayedTradeBubbles(bar, mode, filter.unit === 'notional' ? filter.minimum : 0), filter)
}

export function* filterTradeBubbles(points: Iterable<TradeBubble>, filter: BubbleFilter): Iterable<DisplayedTradeBubble> {
  const { unit, minimum, maximum } = filter
  for (const point of points) {
    const amount = tradeThresholdValue(point.trade, unit, filter)
    if (amount === undefined || !Number.isFinite(amount)) continue
    // Summing normalized quantities and dividing by the lot or contract size can round at a threshold.
    const tolerance = unit === 'notional' ? 0 : amount * Number.EPSILON * 8
    if (amount + tolerance >= minimum && (maximum === 0 || amount - tolerance <= maximum)) yield { ...point, amount }
  }
}

export function selectVisibleTradeBubbles(bars: ReadonlyMap<number, TradeBar>, mode: BigTradeMode,
  filter: BubbleFilter, maximumCount: number, prepared?: (bar: TradeBar) => readonly DisplayedTradeBubble[] | undefined) {
  function* visible(): Iterable<[number, Iterable<DisplayedTradeBubble>]> {
    for (const [timestamp, bar] of bars) {
      if (bar.firstPrice !== undefined) yield [timestamp, prepared?.(bar) ?? filteredTradeBubbles(bar, mode, filter)]
    }
  }
  return limitTradeBubbles(visible(), maximumCount)
}

export function limitTradeBubbles(bars: Iterable<[number, Iterable<DisplayedTradeBubble>]>, maximumCount: number): ReadonlyMap<number, readonly DisplayedTradeBubble[]> {
  function* candidates() {
    for (const [timestamp, bubbles] of bars) {
      for (const point of bubbles) yield { timestamp, point, amount: point.amount }
    }
  }
  const points = new Map<number, DisplayedTradeBubble[]>()
  for (const { timestamp, point } of largestTradeAmounts(candidates(), maximumCount)) {
    const candle = points.get(timestamp)
    if (candle) candle.push(point)
    else points.set(timestamp, [point])
  }
  return points
}

export function largestTradeAmounts<T extends { amount: number }>(items: Iterable<T>, maximumCount: number): T[] {
  const limit = Number.isFinite(maximumCount) ? Math.max(1, Math.min(MAX_VISIBLE_BUBBLES, Math.floor(maximumCount))) : MAX_VISIBLE_BUBBLES
  const candidates: { item: T; order: number }[] = []
  let order = 0
  let smallest = -Infinity
  const trim = () => {
    if (candidates.length <= limit) return
    candidates.sort((a, b) => b.item.amount - a.item.amount || a.order - b.order)
    candidates.length = limit
    smallest = candidates[limit - 1].item.amount
  }
  for (const item of items) {
    if (item.amount <= smallest) continue
    candidates.push({ item, order: order++ })
    // Keep at most two batches in memory, even when millions of trades qualify.
    if (candidates.length === 2 * limit) trim()
  }
  trim()
  return candidates.sort((a, b) => a.order - b.order).map(candidate => candidate.item)
}
