import type { KLineData } from 'klinecharts'
import { alignOpenTime, nextOpenTime } from '../market-data/intervals'
import { isChartColor } from './colors'

export const PIVOT_TYPES = ['Traditional', 'Fibonacci', 'Woodie', 'Classic', 'DM', 'Camarilla'] as const
export const PIVOT_ANCHORS = [
  'Auto', 'Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly',
  'Biyearly', 'Triyearly', 'Quinquennially', 'Decennially',
] as const
export const PIVOT_LEVELS = ['P', 'R1', 'S1', 'R2', 'S2', 'R3', 'S3', 'R4', 'S4', 'R5', 'S5'] as const
export type PivotType = typeof PIVOT_TYPES[number]
export type PivotAnchor = Exclude<typeof PIVOT_ANCHORS[number], 'Auto'>
export type PivotLevel = typeof PIVOT_LEVELS[number]
export type PivotLevels = Partial<Record<PivotLevel, number>>
export type PivotColors = Record<'P' | 'R' | 'S', string>
export const PIVOT_COLORS: PivotColors = { P: '#fb8c00', R: '#ef5350', S: '#26a69a' }
export const PREVIOUS_PIVOT_COLORS: PivotColors = { P: '#a78bfa', R: '#f59e0b', S: '#38bdf8' }

export function pivotGroup(level: PivotLevel): keyof PivotColors { return level[0] as keyof PivotColors }

export const PIVOTS_DEFAULT_PARAMS = [
  'Traditional', 'Auto', 15, true, true, true, 'Left', 1,
  ...PIVOT_LEVELS.flatMap(() => [true, '#fb8c00']),
  PIVOT_COLORS.P, PIVOT_COLORS.R, PIVOT_COLORS.S, false,
  PREVIOUS_PIVOT_COLORS.P, PREVIOUS_PIVOT_COLORS.R, PREVIOUS_PIVOT_COLORS.S,
]

export interface PivotSettings {
  type: PivotType
  anchor: typeof PIVOT_ANCHORS[number]
  history: number
  dailyBased: boolean
  labels: boolean
  prices: boolean
  labelPosition: 'Left' | 'Right'
  width: number
  showPrevious: boolean
  previousColors: PivotColors
  levels: Record<PivotLevel, { visible: boolean; color: string }>
}

/** Preserve legacy switches and hidden colors; collapse legacy colors via P/R1/S1. */
export function validatePivotParams(params: unknown[], previous?: unknown[]): (string | number | boolean)[] {
  const fail = () => { throw new Error('PIVOTS.calcParams 无效') }
  const color = isChartColor
  if (params.length !== 30 && params.length !== 37) fail()
  if (!PIVOT_TYPES.includes(params[0] as PivotType) || !PIVOT_ANCHORS.includes(params[1] as PivotSettings['anchor']) ||
      !Number.isInteger(params[2]) || Number(params[2]) < 1 || Number(params[2]) > 200 ||
      !Number.isInteger(params[7]) || Number(params[7]) < 1 || Number(params[7]) > 100 ||
      !['Left', 'Right'].includes(params[6] as string) || [3, 4, 5].some(i => typeof params[i] !== 'boolean') ||
      PIVOT_LEVELS.some((_, i) => typeof params[8 + i * 2] !== 'boolean' || !color(params[9 + i * 2]))) fail()
  if (params.length === 37 && (typeof params[33] !== 'boolean' || [30, 31, 32, 34, 35, 36].some(i => !color(params[i])))) fail()
  const result = [...params] as (string | number | boolean)[]
  if (result.length === 30) {
    result.push(...(['P', 'R', 'S'] as const).map((group, i) =>
      params[9 + i * 2] === '#fb8c00' ? PIVOT_COLORS[group] : params[9 + i * 2] as string),
    ...(previous?.length === 37 ? validatePivotParams(previous).slice(33) :
      [false, PREVIOUS_PIVOT_COLORS.P, PREVIOUS_PIVOT_COLORS.R, PREVIOUS_PIVOT_COLORS.S]))
  }
  return result
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max ? value : fallback
}

export function pivotSettings(params: unknown[] = PIVOTS_DEFAULT_PARAMS): PivotSettings {
  return {
    type: PIVOT_TYPES.includes(params[0] as PivotType) ? params[0] as PivotType : 'Traditional',
    anchor: PIVOT_ANCHORS.includes(params[1] as PivotSettings['anchor']) ? params[1] as PivotSettings['anchor'] : 'Auto',
    history: boundedInteger(params[2], 15, 200),
    dailyBased: params[3] !== false,
    labels: params[4] !== false,
    prices: params[5] !== false,
    labelPosition: params[6] === 'Right' ? 'Right' : 'Left',
    width: boundedInteger(params[7], 1, 100),
    showPrevious: params[33] === true,
    previousColors: Object.fromEntries((['P', 'R', 'S'] as const).map((group, i) => [group,
      isChartColor(params[34 + i]) ? params[34 + i] : PREVIOUS_PIVOT_COLORS[group],
    ])) as PivotColors,
    levels: Object.fromEntries(PIVOT_LEVELS.map((level, index) => {
      const group = pivotGroup(level)
      const groupIndex = ['P', 'R', 'S'].indexOf(group)
      const color = params[30 + groupIndex] ?? params[9 + groupIndex * 2]
      return [level, {
        visible: params[8 + index * 2] !== false,
        color: isChartColor(color) ? color : PIVOT_COLORS[group],
      }]
    })) as PivotSettings['levels'],
  }
}

/** Auto follows the supplied Pine v6 script (weekly/monthly charts use yearly pivots). */
export function resolvePivotAnchor(anchor: PivotSettings['anchor'], chartTimeframe: string): PivotAnchor {
  if (anchor !== 'Auto') return anchor
  if (/m$/.test(chartTimeframe)) return Number.parseInt(chartTimeframe) <= 15 ? 'Daily' : 'Weekly'
  if (/h$/.test(chartTimeframe)) return 'Weekly'
  if (/d$/.test(chartTimeframe)) return 'Monthly'
  return 'Yearly'
}

const anchorYears: Partial<Record<PivotAnchor, number>> = {
  Yearly: 1, Biyearly: 2, Triyearly: 3, Quinquennially: 5, Decennially: 10,
}

export function pivotPeriodStart(timestamp: number, anchor: PivotAnchor): number {
  if (anchor === 'Daily') return alignOpenTime(timestamp, '1d', 'floor')
  if (anchor === 'Weekly') return alignOpenTime(timestamp, '1w', 'floor')
  const date = new Date(timestamp)
  const years = anchorYears[anchor]
  if (years !== undefined) return Date.UTC(Math.floor(date.getUTCFullYear() / years) * years, 0, 1)
  return Date.UTC(date.getUTCFullYear(), anchor === 'Quarterly' ? Math.floor(date.getUTCMonth() / 3) * 3 : date.getUTCMonth(), 1)
}

export function shiftPivotPeriod(start: number, anchor: PivotAnchor, steps: number): number {
  if (anchor === 'Daily' || anchor === 'Weekly') return start + steps * 86_400_000 * (anchor === 'Weekly' ? 7 : 1)
  const date = new Date(start)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + steps * (anchorYears[anchor] !== undefined ? anchorYears[anchor]! * 12 : anchor === 'Quarterly' ? 3 : 1), 1)
}

export function pivotSourceTimeframe(anchor: PivotAnchor): string {
  return anchor === 'Daily' ? '1d' : anchor === 'Weekly' ? '1w' : '1M'
}

/** Formulas for TradingView's six standard pivot families. */
export function calculatePivotLevels(type: PivotType, previous: Pick<KLineData, 'open' | 'high' | 'low' | 'close'>, currentOpen: number): PivotLevels {
  const { open, high: h, low: l, close: c } = previous
  const range = h - l
  const p = type === 'Woodie' ? (h + l + 2 * currentOpen) / 4 : (h + l + c) / 3
  if (type === 'DM') {
    const x = c === open ? h + l + 2 * c : c > open ? 2 * h + l + c : h + 2 * l + c
    return { P: x / 4, R1: x / 2 - l, S1: x / 2 - h }
  }
  if (type === 'Fibonacci') {
    return { P: p, R1: p + range * 0.382, S1: p - range * 0.382, R2: p + range * 0.618, S2: p - range * 0.618, R3: p + range, S3: p - range }
  }
  if (type === 'Camarilla') {
    const r5 = l === 0 ? undefined : h / l * c
    return {
      P: p, R1: c + range * 1.1 / 12, S1: c - range * 1.1 / 12,
      R2: c + range * 1.1 / 6, S2: c - range * 1.1 / 6,
      R3: c + range * 1.1 / 4, S3: c - range * 1.1 / 4,
      R4: c + range * 1.1 / 2, S4: c - range * 1.1 / 2,
      ...(r5 === undefined ? {} : { R5: r5, S5: 2 * c - r5 }),
    }
  }
  const levels: PivotLevels = { P: p, R1: 2 * p - l, S1: 2 * p - h, R2: p + range, S2: p - range }
  if (type === 'Traditional') return {
    ...levels, R3: 2 * p + h - 2 * l, S3: 2 * p - 2 * h + l,
    R4: 3 * p + h - 3 * l, S4: 3 * p - 3 * h + l,
    R5: 4 * p + h - 4 * l, S5: 4 * p - 4 * h + l,
  }
  if (type === 'Woodie') {
    const r3 = h + 2 * (p - l), s3 = l - 2 * (h - p)
    return { ...levels, R3: r3, S3: s3, R4: r3 + range, S4: s3 - range }
  }
  return { ...levels, R3: p + 2 * range, S3: p - 2 * range, R4: p + 3 * range, S4: p - 3 * range }
}

interface PivotBucket extends KLineData { complete: boolean; endTime: number }
export interface PivotSegment {
  start: number
  end: number
  levels: PivotLevels
  previous?: PivotLevels
}
export type PivotValue = PivotLevels & Partial<Record<`previous${PivotLevel}`, number>> & {
  segment?: PivotSegment
  projection?: PivotSegment
  message?: string
}

function buckets(candles: KLineData[], timeframe: string, anchor: PivotAnchor): Map<number, PivotBucket> {
  const result = new Map<number, PivotBucket>()
  let expected = 0
  for (const candle of candles) {
    const start = pivotPeriodStart(candle.timestamp, anchor)
    const end = nextOpenTime(candle.timestamp, timeframe)
    const current = result.get(start)
    if (current === undefined) {
      result.set(start, { ...candle, complete: candle.timestamp === start, endTime: end })
    } else {
      current.high = Math.max(current.high, candle.high)
      current.low = Math.min(current.low, candle.low)
      current.close = candle.close
      current.complete &&= candle.timestamp === expected
      current.endTime = end
    }
    expected = end
    // A bucket is usable only after its final source candle, with no gaps.
    if (end > shiftPivotPeriod(start, anchor, 1)) result.get(start)!.complete = false
  }
  for (const [start, bucket] of result) {
    bucket.complete &&= bucket.endTime === shiftPivotPeriod(start, anchor, 1)
  }
  return result
}

/** All displayed levels use the preceding complete bucket, never its successor's HLC. */
export function calculatePivots(
  candles: KLineData[],
  chartTimeframe: string,
  settings: PivotSettings,
  source: KLineData[] = candles,
  sourceTimeframe = chartTimeframe,
  confirmedUntil = 0,
): PivotValue[] {
  if (candles.length === 0) return []
  const anchor = resolvePivotAnchor(settings.anchor, chartTimeframe)
  const first = candles[0].timestamp
  const firstStart = pivotPeriodStart(first, anchor)
  if (nextOpenTime(first, chartTimeframe) - first > shiftPivotPeriod(firstStart, anchor, 1) - firstStart) {
    return candles.map(() => ({ message: '枢轴周期不能小于图表周期' }))
  }
  const grouped = buckets(source, sourceTimeframe, anchor)
  const segments = new Map<number, PivotSegment>()
  const filterLevels = (levels: PivotLevels): PivotLevels => Object.fromEntries(
    Object.entries(levels).filter(([key, value]) => settings.levels[key as PivotLevel].visible && Number.isFinite(value)),
  )
  for (const candle of candles) {
    const start = pivotPeriodStart(candle.timestamp, anchor)
    if (segments.has(start)) continue
    const previous = grouped.get(shiftPivotPeriod(start, anchor, -1))
    const current = grouped.get(start)
    if (!previous?.complete || (settings.type === 'Woodie' && current?.timestamp !== start)) continue
    segments.set(start, {
      start, end: shiftPivotPeriod(start, anchor, 1),
      levels: filterLevels(calculatePivotLevels(settings.type, previous, current?.open ?? candle.open)),
    })
  }
  const last = candles.at(-1)!
  const lastStart = pivotPeriodStart(last.timestamp, anchor)
  const lastEnd = nextOpenTime(last.timestamp, chartTimeframe)
  const completed = grouped.get(lastStart)
  let projection: PivotSegment | undefined
  if (settings.type !== 'Woodie' && completed?.complete && lastEnd <= confirmedUntil && lastEnd === shiftPivotPeriod(lastStart, anchor, 1)) {
    projection = { start: lastEnd, end: shiftPivotPeriod(lastEnd, anchor, 1), levels: filterLevels(calculatePivotLevels(settings.type, completed, 0)) }
  }
  // Extend only the immediately preceding period's already-known levels into the
  // current period. These use one more completed source bucket, never current HLC.
  if (settings.showPrevious) {
    const target = projection ?? segments.get(lastStart)
    if (target) {
      const older = grouped.get(shiftPivotPeriod(target.start, anchor, -2))
      const previousOpen = grouped.get(shiftPivotPeriod(target.start, anchor, -1))
      if (older?.complete && (settings.type !== 'Woodie' || previousOpen)) {
        target.previous = filterLevels(calculatePivotLevels(settings.type, older, previousOpen?.open ?? 0))
      }
    }
  }
  const levelCount = Math.max(1, Object.keys(calculatePivotLevels(settings.type, { open: 1, high: 2, low: 1, close: 1.5 }, 1)).filter((key) => settings.levels[key as PivotLevel].visible).length)
  const limit = Math.min(settings.history, Math.floor(500 / levelCount) - (settings.showPrevious ? 1 : 0))
  const retainCount = Math.max(0, limit - (projection ? 1 : 0))
  const retained = new Set(retainCount > 0 ? [...segments.keys()].slice(-retainCount) : [])
  const result: PivotValue[] = candles.map((candle) => {
    const start = pivotPeriodStart(candle.timestamp, anchor)
    const segment = segments.get(start)
    return segment && retained.has(start) ? {
      ...segment.levels, segment,
      ...Object.fromEntries(Object.entries(segment.previous ?? {}).map(([key, value]) => [`previous${key}`, value])),
    } : {}
  })
  if (projection) {
    result.at(-1)!.projection = projection
    Object.assign(result.at(-1)!, Object.fromEntries(Object.entries(projection.previous ?? {}).map(([key, value]) => [`previous${key}`, value])))
  }
  if (segments.size === 0 && !projection) result.at(-1)!.message = '历史不足或有缺口：需上一完整枢轴周期的数据'
  return result
}
