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
export type VolumeProfileCalculation = { rowSizePercent: number; valueArea: number }

export function volumeProfileDisplayType<T extends string>(type: T, showDelta: boolean): T | 'volume' {
  return !showDelta && (type === 'delta' || type === 'volumeDelta') ? 'volume' : type
}

// The same trades may be summed in different chunks by the archive workers and the chart.
function compareProfileVolume(a: number, b: number): number {
  const difference = a - b
  return Math.abs(difference) <= Math.max(a, b) * 1e-12 ? 0 : difference
}

function volumeProfileRange(rows: readonly VolumeProfileRow[], valueArea: number) {
  const volume = rows.map(row => row.buy + row.sell)
  const peak = volume.reduce((best, value, index) => compareProfileVolume(value, volume[best]) > 0 ? index : best, 0)
  if (valueArea === 100) return { peak, lower: 0, higher: rows.length - 1 }
  let lower = peak
  let higher = peak
  let area = volume[peak]
  const target = volume.reduce((sum, value) => sum + value, 0) * valueArea / 100
  while (compareProfileVolume(area, target) < 0 && (lower > 0 || higher < rows.length - 1)) {
    if (lower === 0 || (higher < rows.length - 1 && compareProfileVolume(volume[higher + 1], volume[lower - 1]) > 0)) area += volume[++higher]
    else area += volume[--lower]
  }
  return { peak, lower, higher }
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
  const inside = prices && row.low <= prices.vah && (row.low === row.high ? row.high >= prices.val : row.high > prices.val)
  return settings.showValueArea && inside ? settings.valueAreaColor : settings.volumeColor
}

export function paintVolumeProfileRows(
  profile: VolumeProfile,
  type: 'volumeDelta' | 'volume' | 'bidAsk' | 'delta',
  colors: Parameters<typeof volumeProfileBarColor>[2] & { bidColor: string; askColor: string },
  { axisX, barWidth, paneHeight, pixelAt }: { axisX: number; barWidth: number; paneHeight: number; pixelAt(price: number): number },
  paint: (x: number, y: number, width: number, height: number, color: string) => void,
  paintValue?: (row: VolumeProfileRow, top: number, height: number) => void,
): void {
  let maxVolume = 0
  let maxDelta = 0
  let maxSide = 0
  for (const { buy, sell } of profile.rows) {
    maxVolume = Math.max(maxVolume, buy + sell)
    maxDelta = Math.max(maxDelta, Math.abs(buy - sell))
    maxSide = Math.max(maxSide, buy, sell)
  }
  for (const row of profile.rows) {
    const { buy, sell } = row
    const volume = buy + sell
    if (!volume) continue
    const first = pixelAt(row.high)
    const last = pixelAt(row.low)
    if (Math.max(first, last) < 0 || Math.min(first, last) >= paneHeight) continue
    const top = Math.max(0, Math.min(first, last))
    const height = Math.max(1, Math.min(paneHeight, Math.max(first, last)) - top - 0.7)
    const delta = buy - sell
    if (type === 'volume' || type === 'volumeDelta') {
      paint(axisX, top, volume / maxVolume * barWidth, height, volumeProfileBarColor(row, profile, colors))
    }
    if ((type === 'delta' || type === 'volumeDelta') && delta !== 0) {
      const width = Math.abs(delta) / maxDelta * barWidth
      const left = type === 'volumeDelta' || delta < 0 ? axisX - width : axisX
      paint(left, top, width, height, delta > 0 ? colors.askColor : colors.bidColor)
    }
    if (type === 'bidAsk') {
      const sellWidth = sell / maxSide * barWidth
      if (sell) paint(axisX - sellWidth, top, sellWidth, height, colors.bidColor)
      if (buy) paint(axisX, top, buy / maxSide * barWidth, height, colors.askColor)
    }
    paintValue?.(row, top, height)
  }
}

/** Keep exact prices so the same trades can be regrouped whenever the reference price moves. */
export class VolumeProfileLevels {
  private readonly prices = new Map<number, { buy: number; sell: number }>()

  add(price: number, signedSize: number): void {
    this.addLevel(price, Math.max(0, signedSize), Math.max(0, -signedSize))
  }

  private addLevel(price: number, buy: number, sell: number): void {
    if (!(buy + sell > 0)) return
    let level = this.prices.get(price)
    if (!level) this.prices.set(price, level = { buy: 0, sell: 0 })
    level.buy += buy
    level.sell += sell
  }

  merge(other: VolumeProfileLevels): void {
    for (const [price, { buy, sell }] of other.prices) this.addLevel(price, buy, sell)
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

  profile(referencePrice: number | undefined, { rowSizePercent, valueArea }: VolumeProfileCalculation): VolumeProfile | undefined {
    const width = Math.abs(referencePrice ?? 0) * rowSizePercent / 100
    if (!this.prices.size || !Number.isFinite(width) || width <= 0) return
    const groups = new Map<number, VolumeProfileRow & { peak: number; peakVolume: number }>()
    for (const [price, { buy, sell }] of this.prices) {
      const units = price / width
      // Prices on a boundary belong to the upper bucket despite division roundoff.
      const index = Math.floor(units + Math.abs(units) * Number.EPSILON * 2)
      const group = groups.get(index)
      if (!group) {
        groups.set(index, { low: price, high: price, buy, sell, peak: price, peakVolume: buy + sell })
        continue
      }
      group.buy += buy
      group.sell += sell
      group.low = Math.min(group.low, price)
      group.high = Math.max(group.high, price)
      const volume = compareProfileVolume(buy + sell, group.peakVolume)
      if (volume > 0 || (volume === 0 && price < group.peak)) {
        group.peak = price
        group.peakVolume = buy + sell
      }
    }
    const sorted = [...groups].sort(([a], [b]) => a - b)
    const first = sorted[0][1].low
    const last = sorted[sorted.length - 1][1].high
    const rows = sorted.map(([index, { low, high, buy, sell }]) => ({
      low: Math.min(low, Math.max(index * width, first)),
      high: Math.max(high, Math.min((index + 1) * width, last)),
      buy, sell,
    }))
    const range = volumeProfileRange(rows, valueArea)
    return {
      rows,
      poc: sorted[range.peak][1].peak,
      vah: sorted[range.higher][1].high,
      val: sorted[range.lower][1].low,
    }
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
