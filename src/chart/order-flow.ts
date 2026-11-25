import type { BybitTrade } from '../market-data/bybit/trades'
import { isChartColor } from './colors'

export const VOLUME_PROFILE_TOOL = 'tradeVolumeProfile'
export const BIG_TRADES = 'BIG_TRADES'
export type BigTradeMode = 'aggregate' | 'volume'

export const bigTradeThresholdUnits = { notional: 'USDT', quantity: '枚 / 标的单位', contracts: '张', lots: '手' } as const
export type BigTradeThresholdUnit = keyof typeof bigTradeThresholdUnits

export interface BigTradeUnits {
  contractValue?: number
  lotSize?: number
  projectToCandle?: boolean
}

export interface BigTradeThreshold {
  unit: BigTradeThresholdUnit
  minimum: number
  maximum: number
}

export function tradeThresholdValue(trade: BybitTrade, unit: BigTradeThresholdUnit, units: BigTradeUnits): number | undefined {
  switch (unit) {
    case 'notional': return trade.venue === 'CME' ? undefined : trade.price * trade.size
    case 'quantity': return trade.size
    case 'contracts': return trade.venue === 'CME' ? trade.size
      : trade.venue === 'OKX' && units.contractValue ? trade.size / units.contractValue : undefined
    case 'lots': return units.lotSize && (trade.venue === 'OKX' || !units.projectToCandle) ? trade.size / units.lotSize : undefined
  }
}

export function bigTradeMode(styles: unknown): BigTradeMode {
  return (styles as { bubbleMode?: unknown } | null | undefined)?.bubbleMode === 'aggregate' ? 'aggregate' : 'volume'
}
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
  if ('bubbleMode' in styles && styles.bubbleMode !== 'aggregate' && styles.bubbleMode !== 'volume') {
    throw new Error('BIG_TRADES.styles.bubbleMode 必须是 aggregate 或 volume')
  }
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

export type VolumeProfileBounds = Pick<VolumeProfileRow, 'low' | 'high'>
export type VolumeProfilePrices = Pick<VolumeProfile, 'poc' | 'vah' | 'val'>

export function volumeProfilePrices(rows: readonly VolumeProfileRow[], valueArea: number): VolumeProfilePrices | undefined {
  const volume = rows.map(row => row.buy + row.sell)
  const total = volume.reduce((sum, value) => sum + value, 0)
  if (!total) return
  const peak = volume.indexOf(Math.max(...volume))
  let lower = peak
  let higher = peak
  let area = volume[peak]
  while (area < total * valueArea / 100 && (lower > 0 || higher < rows.length - 1)) {
    if ((volume[higher + 1] ?? -1) > (volume[lower - 1] ?? -1)) area += volume[++higher]
    else area += volume[--lower]
  }
  return { poc: (rows[peak].low + rows[peak].high) / 2, vah: rows[higher].high, val: rows[lower].low }
}

export function volumeProfilePriceLines(prices: VolumeProfilePrices, settings: {
  showPoc: boolean; showValueArea: boolean; pocColor: string; levelColor: string
}, pixelAt: (value: number) => number) {
  const lines = [
    ...(settings.showPoc ? [{ name: 'POC', value: prices.poc, color: settings.pocColor, solid: true }] : []),
    ...(settings.showValueArea ? [
      { name: 'VAH', value: prices.vah, color: settings.levelColor, solid: false },
      { name: 'VAL', value: prices.val, color: settings.levelColor, solid: false },
    ] : []),
  ]
  return lines.map(line => ({ ...line, y: pixelAt(line.value) })).sort((a, b) => a.y - b.y)
}

export function volumeProfileBarColor(row: VolumeProfileBounds, prices: VolumeProfilePrices | undefined,
  settings: { showValueArea: boolean; valueAreaColor: string; volumeColor: string }): string {
  const inside = prices && (row.low === row.high
    ? row.low >= prices.val && row.high <= prices.vah : row.low < prices.vah && row.high > prices.val)
  return settings.showValueArea && inside ? settings.valueAreaColor : settings.volumeColor
}

function profileBin(price: number, low: number, high: number, rows: number): number {
  if (price < low || price > high) return -1
  return Math.min(rows - 1, Math.floor((price - low) / (high - low) * rows))
}

export class VolumeProfileAccumulator {
  private readonly rows: VolumeProfileRow[]

  constructor(private readonly low: number, private readonly high: number, count = 48) {
    const width = (high - low) / count
    this.rows = Array.from({ length: count }, (_, index) => ({
      low: low + index * width, high: index === count - 1 ? high : low + (index + 1) * width, buy: 0, sell: 0,
    }))
  }

  add(trade: BybitTrade, price = trade.price): void {
    this.addLevel(price, trade.side === 'buy' ? trade.size : 0, trade.side === 'sell' ? trade.size : 0)
  }

  addLevel(price: number, buy: number, sell: number): void {
    const index = profileBin(price, this.low, this.high, this.rows.length)
    if (index < 0) return
    this.rows[index].buy += buy
    this.rows[index].sell += sell
  }

  profile(valueArea = 70): VolumeProfile | undefined {
    const prices = volumeProfilePrices(this.rows, valueArea)
    if (prices) return { rows: this.rows.map(row => ({ ...row })), ...prices }
  }
}

/** Keep price-level totals so new extremes and display settings can re-bin existing trades. */
export class VolumeProfileLevels {
  private readonly prices = new Map<number, { buy: number; sell: number }>()
  private low = Infinity
  private high = -Infinity

  add(price: number, signedSize: number): void {
    this.addLevel(price, Math.max(0, signedSize), Math.max(0, -signedSize))
  }

  private addLevel(price: number, buy: number, sell: number): void {
    let level = this.prices.get(price)
    if (!level) {
      this.prices.set(price, level = { buy: 0, sell: 0 })
      this.low = Math.min(this.low, price)
      this.high = Math.max(this.high, price)
    }
    level.buy += buy
    level.sell += sell
  }

  merge(other: VolumeProfileLevels): void {
    for (const [price, { buy, sell }] of other.prices) this.addLevel(price, buy, sell)
  }

  entries(): IterableIterator<[number, Readonly<Pick<VolumeProfileRow, 'buy' | 'sell'>>]> {
    return this.prices.entries()
  }

  addPacked(values: Float64Array): void {
    for (let index = 0; index < values.length; index += 3) this.addLevel(values[index], values[index + 1], values[index + 2])
  }

  pack(): Float64Array<ArrayBuffer> {
    const values = new Float64Array(this.prices.size * 3)
    let index = 0
    for (const [price, { buy, sell }] of this.prices) {
      values[index++] = price
      values[index++] = buy
      values[index++] = sell
    }
    return values
  }

  profile(rows: number, valueArea: number): VolumeProfile | undefined {
    if (!this.prices.size) return
    if (this.low === this.high) {
      const price = this.low
      return { rows: [{ low: price, high: price, ...this.prices.get(price)! }], poc: price, vah: price, val: price }
    }
    const binned = new VolumeProfileAccumulator(this.low, this.high, rows)
    for (const [price, { buy, sell }] of this.prices) binned.addLevel(price, buy, sell)
    return binned.profile(valueArea)
  }
}

export function volumeProfileBounds(profile?: VolumeProfile): VolumeProfileBounds | undefined {
  if (profile?.rows.length) return { low: profile.rows[0].low, high: profile.rows.at(-1)!.high }
}

export function volumeProfileCenter(profile?: VolumeProfile, bounds = volumeProfileBounds(profile)): number | undefined {
  if (bounds) return bounds.low + (bounds.high - bounds.low) / 2
}

export function bigTradeMinimum(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Big Trades 最低成交额必须为非负有限数')
  }
  return value
}
