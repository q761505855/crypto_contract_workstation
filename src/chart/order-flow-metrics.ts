import type { KLineData } from 'klinecharts'
import { BYBIT_DAY_MS, type BybitTrade } from '../market-data/bybit/trades'
import { tradeBubbles, type TradeBar, type TradeBubble } from './order-flow-bars'
import type { orderFlowSettings } from './order-flow-preferences'

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
