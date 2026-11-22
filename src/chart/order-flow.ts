import type { BybitTrade } from '../market-data/bybit/trades'
import { isChartColor } from './colors'

export const VOLUME_PROFILE_TOOL = 'tradeVolumeProfile'
export const BIG_TRADES = 'BIG_TRADES'
export const DEFAULT_BIG_TRADE_NOTIONAL = 25_000
const DEFAULT_BIG_TRADE_COLORS = ['#49d4ae6b', '#ff827e6b', '#49d4aee6', '#ff827ee6'] as const

export function bigTradeColors(styles: unknown) {
  const colors = (styles as { bubbleColors?: { color: string }[] } | null | undefined)?.bubbleColors
  return {
    buy: { fill: colors?.[0]?.color ?? DEFAULT_BIG_TRADE_COLORS[0], outline: colors?.[2]?.color ?? DEFAULT_BIG_TRADE_COLORS[2] },
    sell: { fill: colors?.[1]?.color ?? DEFAULT_BIG_TRADE_COLORS[1], outline: colors?.[3]?.color ?? DEFAULT_BIG_TRADE_COLORS[3] },
  }
}

export function validateBigTradeStyles(styles: unknown): void {
  if (styles === null) return
  if (typeof styles !== 'object' || Array.isArray(styles)) throw new Error('BIG_TRADES.styles 无效')
  if ('bubbleColors' in styles) {
    const colors = styles.bubbleColors
    if (!Array.isArray(colors) || colors.length !== DEFAULT_BIG_TRADE_COLORS.length ||
        ![...colors].every(entry => entry && isChartColor(entry.color))) {
      throw new Error('BIG_TRADES.styles.bubbleColors 必须包含四个有效的气泡颜色')
    }
  }
}

export interface VolumeProfileRow {
  low: number
  high: number
  buy: number
  sell: number
}

export interface VolumeProfile {
  rows: VolumeProfileRow[]
  poc: number
  vah: number
  val: number
}

export class VolumeProfileAccumulator {
  private readonly rows: VolumeProfileRow[]

  constructor(private readonly low: number, private readonly high: number, count = 48) {
    const width = (high - low) / count
    this.rows = Array.from({ length: count }, (_, index) => ({
      low: low + index * width, high: low + (index + 1) * width, buy: 0, sell: 0,
    }))
  }

  add(trade: BybitTrade, price = trade.price): void {
    if (price < this.low || price > this.high) return
    const index = Math.min(this.rows.length - 1, Math.floor(
      (price - this.low) / (this.high - this.low) * this.rows.length,
    ))
    this.rows[index][trade.side] += trade.size
  }

  profile(): VolumeProfile | undefined {
    const volume = this.rows.map(row => row.buy + row.sell)
    const total = volume.reduce((sum, value) => sum + value, 0)
    if (!total) return undefined
    const peak = volume.indexOf(Math.max(...volume))
    let lower = peak
    let higher = peak
    let area = volume[peak]
    while (area < total * 0.7 && (lower > 0 || higher < this.rows.length - 1)) {
      if ((volume[higher + 1] ?? -1) > (volume[lower - 1] ?? -1)) area += volume[++higher]
      else area += volume[--lower]
    }
    return {
      rows: this.rows.map(row => ({ ...row })),
      poc: (this.rows[peak].low + this.rows[peak].high) / 2,
      vah: this.rows[higher].high,
      val: this.rows[lower].low,
    }
  }
}

export function bigTradeMinimum(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Big Trades 最低成交额必须为非负有限数')
  }
  return value
}
