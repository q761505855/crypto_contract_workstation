import type { BybitTrade } from '../market-data/bybit/trades'

export const VOLUME_PROFILE_TOOL = 'tradeVolumeProfile'
export const BIG_TRADES = 'BIG_TRADES'
export const DEFAULT_BIG_TRADE_NOTIONAL = 25_000

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

  add(trade: BybitTrade): void {
    if (trade.price < this.low || trade.price > this.high) return
    const index = Math.min(this.rows.length - 1, Math.floor(
      (trade.price - this.low) / (this.high - this.low) * this.rows.length,
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
