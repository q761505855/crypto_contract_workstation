import type { KLineData } from 'klinecharts'
import { BYBIT_DAY_MS, type BybitTrade } from '../market-data/bybit/trades'
import { nextOpenTime } from '../market-data/intervals'
import { tradeBubblePrice, tradeBubbles, type TradeBar, type TradeBubble } from './order-flow-bars'
import type { VolumeProfileRow } from './order-flow'
import { orderFlowFields, type orderFlowSettings } from './order-flow-preferences'

type FootprintSettings = ReturnType<typeof orderFlowSettings<'footprint'>>

export interface FootprintRow {
  low: number
  high: number
  buy: number
  sell: number
  poc: boolean
  askImbalance: boolean
  bidImbalance: boolean
}

export function calculateFootprint(bar: TradeBar, settings: FootprintSettings, precision: number,
  priceOf: (trade: BybitTrade) => number, targetRows = settings.targetRows): FootprintRow[] {
  const tickSize = 10 ** -precision
  const tickOf = (trade: BybitTrade) => Math.round(priceOf(trade) / tickSize)
  const included = (trade: BybitTrade) => {
    const amount = trade.price * trade.size
    return amount >= settings.minNotional && (settings.maxNotional === 0 || amount <= settings.maxNotional)
  }
  let low = Infinity
  let high = -Infinity
  for (const { trade } of tradeBubbles(bar)) {
    if (!included(trade)) continue
    const tick = tickOf(trade)
    low = Math.min(low, tick)
    high = Math.max(high, tick)
  }
  if (low > high) return []
  const span = high - low + 1
  const step = settings.grouping === 'manual' ? settings.ticksPerRow : Math.ceil(span / targetRows)
  const buckets = new Map<number, { row: FootprintRow; volume: number }>()
  for (const { trade } of tradeBubbles(bar)) {
    if (!included(trade)) continue
    const start = Math.floor(tickOf(trade) / step) * step
    let bucket = buckets.get(start)
    if (!bucket) {
      const row: FootprintRow = {
        low: (start - 0.5) * tickSize, high: (start + step - 0.5) * tickSize,
        buy: 0, sell: 0, poc: false, askImbalance: false, bidImbalance: false,
      }
      bucket = { row, volume: 0 }
      buckets.set(start, bucket)
    }
    bucket.row[trade.side] += settings.input === 'count' ? 1 : trade.size
    bucket.volume += trade.size
  }
  const ordered = [...buckets].sort(([a], [b]) => a - b)
  const peak = ordered.reduce((best, [, bucket]) => bucket.volume > best.volume ? bucket : best, ordered[0][1])
  peak.row.poc = true
  for (const [start, { row }] of ordered) {
    const bidBelow = buckets.get(start - step)?.row.sell ?? 0
    const askAbove = buckets.get(start + step)?.row.buy ?? 0
    row.askImbalance = bidBelow > 0 && row.buy >= bidBelow * settings.imbalanceRatio
    row.bidImbalance = askAbove > 0 && row.sell >= askAbove * settings.imbalanceRatio
  }
  return ordered.map(([, { row }]) => row)
}

const signedVolumes = new WeakMap<readonly TradeBubble[], number[]>()

function tradeDelta(bar: TradeBar): number {
  let delta = 0
  for (const { points, from, until } of bar.pointRanges) {
    let sums = signedVolumes.get(points)
    if (!sums) {
      sums = [0]
      signedVolumes.set(points, sums)
    }
    for (let index = sums.length - 1; index < until; index++) {
      const { trade } = points[index]
      sums.push(sums[index] + (trade.side === 'buy' ? trade.size : -trade.size))
    }
    delta += sums[until] - sums[from]
  }
  return delta
}

export function cumulativeVolumeDelta(candles: readonly Pick<KLineData, 'timestamp'>[],
  read: (timestamp: number) => TradeBar | undefined, daily: boolean,
  dayOf = (timestamp: number) => Math.floor(timestamp / BYBIT_DAY_MS)): Map<number, number> {
  const values = new Map<number, number>()
  let delta = 0
  let lastDay: number | undefined
  for (const { timestamp } of candles) {
    const day = dayOf(timestamp)
    if (daily && day !== lastDay) delta = 0
    lastDay = day
    const bar = read(timestamp)
    if (!bar?.complete) {
      delta = 0
      continue
    }
    delta += tradeDelta(bar)
    values.set(timestamp, delta)
  }
  return values
}

export interface VwapPoint { price: number; day: number }

export const tradeDay = (untilUs: number): number => Math.floor((untilUs - 1) / (BYBIT_DAY_MS * 1000)) * BYBIT_DAY_MS

type FlowCandle = Pick<KLineData, 'timestamp' | 'open'>
type PricedBar = { bar: TradeBar; open: number }
type TradeRead = (start: number, untilUs: number) => TradeBar | undefined

const weightedBars = new WeakMap<TradeBar, { scale: number; volume: number; weighted: number }>()

function weightedTrades(bar: TradeBar, scale: number): { volume: number; weighted: number } {
  const cached = weightedBars.get(bar)
  if (cached?.scale === scale) return cached
  const totals = { scale, volume: 0, weighted: 0 }
  for (const { trade } of tradeBubbles(bar)) {
    totals.volume += trade.size
    totals.weighted += trade.price * (trade.venue ? 1 : scale) * trade.size
  }
  weightedBars.set(bar, totals)
  return totals
}

export function dailyTradeVwap(candles: readonly FlowCandle[], timeframe: string,
  cursor: number, read: TradeRead, projected: boolean): { values: Map<number, VwapPoint>; partial: boolean } {
  const values = new Map<number, VwapPoint>()
  let day = -Infinity
  let end = 0
  let weighted = 0
  let volume = 0
  let partial = false
  for (const { timestamp, open } of candles) {
    const until = Math.min(cursor, nextOpenTime(timestamp, timeframe) * 1000)
    if (until <= timestamp * 1000) continue
    const currentDay = tradeDay(until)
    if (currentDay !== day) {
      day = currentDay
      end = day
      volume = 0
      weighted = 0
    }
    // Native prices can include trades in gaps between candles. Projected prices need the containing candle's open.
    const start = projected ? Math.max(end, timestamp, day) : end
    partial ||= start > end
    const bar = read(start, until)
    end = until / 1000
    partial ||= !bar?.complete
    if (bar) {
      const anchor = projected ? (start === timestamp ? bar : read(timestamp, until))?.firstBybitPrice : undefined
      const totals = weightedTrades(bar, anchor ? open / anchor : 1)
      weighted += totals.weighted
      volume += totals.volume
    }
    if (volume > 0) values.set(timestamp, { price: weighted / volume, day })
  }
  return { values, partial }
}

type SideVolumes = Pick<VolumeProfileRow, 'buy' | 'sell'>
const priceLevels = new WeakMap<TradeBar, { projection?: number; precision: number; levels: ReadonlyMap<number, SideVolumes> }>()

export function visibleVolumeProfile(bars: readonly PricedBar[], projected: boolean, precision: number,
  targetRows = orderFlowFields.visibleProfile.rows.fallback): VolumeProfileRow[] {
  const tickSize = 10 ** -precision
  const levels: ReadonlyMap<number, SideVolumes>[] = []
  let low = Infinity
  let high = -Infinity
  for (const { bar, open } of bars) {
    const projection = projected ? open : undefined
    let cached = priceLevels.get(bar)
    if (!cached || cached.projection !== projection || cached.precision !== precision) {
      const totals = new Map<number, SideVolumes>()
      for (const { trade } of tradeBubbles(bar)) {
        const tick = Math.round(tradeBubblePrice(trade, bar, open, projected) / tickSize)
        let level = totals.get(tick)
        if (!level) totals.set(tick, level = { buy: 0, sell: 0 })
        level[trade.side] += trade.size
      }
      cached = { projection, precision, levels: totals }
      priceLevels.set(bar, cached)
    }
    levels.push(cached.levels)
    for (const tick of cached.levels.keys()) {
      low = Math.min(low, tick)
      high = Math.max(high, tick)
    }
  }
  if (low > high) return []

  const step = Math.ceil((high - low + 1) / targetRows)
  const rows = new Map<number, VolumeProfileRow>()
  for (const totals of levels) {
    for (const [tick, { buy, sell }] of totals) {
      const start = low + Math.floor((tick - low) / step) * step
      let row = rows.get(start)
      if (!row) rows.set(start, row = {
        low: (start - 0.5) * tickSize, high: (Math.min(high + 1, start + step) - 0.5) * tickSize, buy: 0, sell: 0,
      })
      row.buy += buy
      row.sell += sell
    }
  }
  return [...rows].sort(([a], [b]) => a - b).map(([, row]) => row)
}
