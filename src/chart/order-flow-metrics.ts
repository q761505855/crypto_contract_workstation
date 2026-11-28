import type { KLineData } from 'klinecharts'
import { BYBIT_DAY_MS, type BybitTrade } from '../market-data/bybit/trades'
import { nextOpenTime } from '../market-data/intervals'
import { cashTradeEnd } from './new-york-cash'
import { tradeBubblePrice, tradeBubbles, type TradeBar, type TradeBubble } from './order-flow-bars'
import { VolumeProfileLevels, type VolumeProfileCalculation } from './order-flow'
import type { orderFlowSettings } from './order-flow-preferences'

type FootprintSettings = ReturnType<typeof orderFlowSettings<'footprint'>>
type FootprintLevel = { buy: number; sell: number; volume: number }

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
  return footprintRowsFromLevels(footprintTradeLevels(tradeBubbles(bar), settings, precision, priceOf), settings, precision, targetRows)
}

export function footprintTradeLevels(trades: Iterable<TradeBubble>, settings: FootprintSettings, precision: number,
  priceOf: (trade: BybitTrade) => number): Map<number, FootprintLevel> {
  const tickSize = 10 ** -precision
  const totals = new Map<number, FootprintLevel>()
  const countTrades = settings.input === 'count'
  for (const { trade } of trades) {
    const amount = trade.price * trade.size
    if (!(amount >= settings.minNotional && (settings.maxNotional === 0 || amount <= settings.maxNotional))) continue
    const tick = Math.round(priceOf(trade) / tickSize)
    let level = totals.get(tick)
    if (!level) totals.set(tick, level = { buy: 0, sell: 0, volume: 0 })
    level[trade.side] += countTrades ? 1 : trade.size
    level.volume += trade.size
  }
  return totals
}

export function mergeFootprintLevels(chunks: Iterable<Float64Array>): Map<number, FootprintLevel> {
  const levels = new Map<number, FootprintLevel>()
  for (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length; offset += 4) {
      const tick = chunk[offset]
      let level = levels.get(tick)
      if (!level) levels.set(tick, level = { buy: 0, sell: 0, volume: 0 })
      level.buy += chunk[offset + 1]
      level.sell += chunk[offset + 2]
      level.volume += chunk[offset + 3]
    }
  }
  return levels
}

export function footprintRowsFromLevels(totals: ReadonlyMap<number, FootprintLevel>, settings: FootprintSettings, precision: number,
  targetRows: number): FootprintRow[] {
  let low = Infinity
  let high = -Infinity
  for (const tick of totals.keys()) {
    low = Math.min(low, tick)
    high = Math.max(high, tick)
  }
  if (low > high) return []
  const tickSize = 10 ** -precision
  const span = high - low + 1
  const step = settings.grouping === 'manual' ? settings.ticksPerRow : Math.ceil(span / targetRows)
  const buckets = new Map<number, { row: FootprintRow; volume: number }>()
  for (const [tick, level] of totals) {
    const start = Math.floor(tick / step) * step
    let bucket = buckets.get(start)
    if (!bucket) {
      const row: FootprintRow = {
        low: (start - 0.5) * tickSize, high: (start + step - 0.5) * tickSize,
        buy: 0, sell: 0, poc: false, askImbalance: false, bidImbalance: false,
      }
      bucket = { row, volume: 0 }
      buckets.set(start, bucket)
    }
    bucket.row.buy += level.buy
    bucket.row.sell += level.sell
    bucket.volume += level.volume
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

export interface CvdCandle { open: number; high: number; low: number; close: number }

const deltaRanges = new WeakMap<readonly TradeBubble[], Map<number, Omit<CvdCandle, 'open'> & { until: number }>>()

function tradeDeltaCandle(bar: TradeBar, open: number): CvdCandle {
  let close = open
  let high = open
  let low = open
  for (const { points, from, until } of bar.pointRanges) {
    let ranges = deltaRanges.get(points)
    if (!ranges) {
      ranges = new Map()
      deltaRanges.set(points, ranges)
    }
    let range = ranges.get(from)
    if (!range || range.until > until) {
      range = { until: from, close: 0, high: 0, low: 0 }
      ranges.set(from, range)
    }
    // A forming candle extends the same trade range as new ticks become visible.
    for (let index = range.until; index < until; index++) {
      const { trade } = points[index]
      range.close += trade.side === 'buy' ? trade.size : -trade.size
      range.high = Math.max(range.high, range.close)
      range.low = Math.min(range.low, range.close)
    }
    range.until = until
    high = Math.max(high, close + range.high)
    low = Math.min(low, close + range.low)
    close += range.close
  }
  return { open, high, low, close }
}

export function cumulativeVolumeDelta(candles: readonly Pick<KLineData, 'timestamp'>[],
  read: (timestamp: number) => TradeBar | undefined, daily: boolean,
  dayOf = (timestamp: number) => Math.floor(timestamp / BYBIT_DAY_MS)): Map<number, CvdCandle> {
  const values = new Map<number, CvdCandle>()
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
    const candle = tradeDeltaCandle(bar, delta)
    delta = candle.close
    values.set(timestamp, candle)
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
  cursor: number, read: TradeRead, projected: boolean, cashOnly = false): { values: Map<number, VwapPoint>; partial: boolean } {
  const values = new Map<number, VwapPoint>()
  let day = -Infinity
  let end = 0
  let weighted = 0
  let volume = 0
  let partial = false
  for (const { timestamp, open } of candles) {
    const barEnd = Math.min(cursor, nextOpenTime(timestamp, timeframe) * 1000)
    const until = cashOnly ? cashTradeEnd(timestamp, barEnd) : barEnd
    if (until === undefined || until <= timestamp * 1000) continue
    const currentDay = tradeDay(until)
    if (currentDay !== day) {
      day = currentDay
      end = day
      volume = 0
      weighted = 0
    }
    // Native prices can include trades in gaps between candles. Projected prices need the containing candle's open.
    const start = projected ? Math.max(end, timestamp, day) : end
    partial ||= !cashOnly && start > end
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

const priceLevels = new WeakMap<TradeBar, { projection?: number; levels: VolumeProfileLevels }>()

export function tradeBarProfileLevels(bar: TradeBar, open: number, projected: boolean,
  fromUs?: number, untilUs?: number): VolumeProfileLevels {
  const wholeBar = fromUs === undefined && untilUs === undefined
  const projection = projected ? open : undefined
  const cached = wholeBar ? priceLevels.get(bar) : undefined
  if (cached && cached.projection === projection) return cached.levels
  const levels = new VolumeProfileLevels()
  for (const { trade } of tradeBubbles(bar, fromUs, untilUs)) {
    levels.add(tradeBubblePrice(trade, bar, open, projected), trade.side === 'buy' ? trade.size : -trade.size)
  }
  if (wholeBar) priceLevels.set(bar, { projection, levels })
  return levels
}

export function visibleVolumeProfile(bars: readonly PricedBar[], projected: boolean, referencePrice: number | undefined, settings: VolumeProfileCalculation) {
  const levels = new VolumeProfileLevels()
  for (const { bar, open } of bars) levels.merge(tradeBarProfileLevels(bar, open, projected))
  return levels.profile(referencePrice, settings)
}
