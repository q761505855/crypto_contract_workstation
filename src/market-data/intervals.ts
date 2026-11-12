import type { Period } from '@klinecharts/pro'

const THREE_DAYS = 3 * 86_400_000
// Binance's USD-M 3d series changed its UTC open grid in August 2023.
// The last old bar and the first new bar overlap by one day.
const LAST_OLD_THREE_DAY_OPEN = Date.UTC(2023, 7, 14)
const FIRST_NEW_THREE_DAY_OPEN = Date.UTC(2023, 7, 16)
export const LEGACY_THREE_DAY_TIMEFRAME = '3d-legacy'

const FIXED_INTERVALS = Object.freeze({
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 3_600_000,
  '2h': 2 * 3_600_000,
  '4h': 4 * 3_600_000,
  '6h': 6 * 3_600_000,
  '8h': 8 * 3_600_000,
  '12h': 12 * 3_600_000,
  '1d': 86_400_000,
  '3d': THREE_DAYS,
})

type FixedTimeframe = keyof typeof FIXED_INTERVALS
export type MarketTimeframe = FixedTimeframe | '1w' | '1M'

const WEEK_INTERVAL = 7 * 86_400_000
const MONDAY_UTC_ANCHOR = Date.UTC(1970, 0, 5)

export const SUPPORTED_TIMEFRAMES = Object.freeze([
  ...Object.keys(FIXED_INTERVALS),
  '1w',
  '1M',
])

export function periodToTimeframe(period: Period): string {
  if (!SUPPORTED_TIMEFRAMES.includes(period.text)) {
    throw new Error(`不支持的周期：${period.text}`)
  }
  return period.text
}

export function usesNativeKlines(timeframe: string): boolean {
  return timeframe === '3d' || timeframe === '1w' || timeframe === '1M'
}

export function nextOpenTime(openTime: number, timeframe: string): number {
  if (timeframe === '3d' && openTime === LAST_OLD_THREE_DAY_OPEN) return FIRST_NEW_THREE_DAY_OPEN
  if (timeframe === LEGACY_THREE_DAY_TIMEFRAME) return openTime + THREE_DAYS
  if (timeframe === '1M') {
    const date = new Date(openTime)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  }
  if (timeframe === '1w') {
    return openTime + WEEK_INTERVAL
  }
  const interval = FIXED_INTERVALS[timeframe as FixedTimeframe]
  if (interval === undefined) {
    throw new Error(`不支持的周期：${timeframe}`)
  }
  return openTime + interval
}

export function previousOpenTime(openTime: number, timeframe: string): number {
  if (timeframe === '3d' && openTime === FIRST_NEW_THREE_DAY_OPEN) return LAST_OLD_THREE_DAY_OPEN
  if (timeframe === LEGACY_THREE_DAY_TIMEFRAME) return openTime - THREE_DAYS
  if (timeframe === '1M') {
    const date = new Date(openTime)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)
  }
  if (timeframe === '1w') {
    return openTime - WEEK_INTERVAL
  }
  const interval = FIXED_INTERVALS[timeframe as FixedTimeframe]
  if (interval === undefined) {
    throw new Error(`不支持的周期：${timeframe}`)
  }
  return openTime - interval
}

export function alignOpenTime(
  timestamp: number,
  timeframe: string,
  direction: 'floor' | 'ceil',
): number {
  let floor: number
  if (timeframe === '1M') {
    const date = new Date(timestamp)
    floor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  } else if (timeframe === '1w') {
    floor =
      Math.floor((timestamp - MONDAY_UTC_ANCHOR) / WEEK_INTERVAL) *
        WEEK_INTERVAL +
      MONDAY_UTC_ANCHOR
  } else if (timeframe === '3d') {
    const anchor = timestamp < FIRST_NEW_THREE_DAY_OPEN ? LAST_OLD_THREE_DAY_OPEN : FIRST_NEW_THREE_DAY_OPEN
    floor = Math.floor((timestamp - anchor) / THREE_DAYS) * THREE_DAYS + anchor
  } else {
    const interval = timeframe === LEGACY_THREE_DAY_TIMEFRAME ? THREE_DAYS : FIXED_INTERVALS[timeframe as FixedTimeframe]
    if (interval === undefined) {
      throw new Error(`不支持的周期：${timeframe}`)
    }
    floor = Math.floor(timestamp / interval) * interval
  }
  if (direction === 'floor' || floor === timestamp) {
    return floor
  }
  return nextOpenTime(floor, timeframe)
}

/** Exclusive end of prices in the bar, even when consecutive opens overlap. */
export function klineCloseBoundary(openTime: number, timeframe: string): number {
  return timeframe === '3d' ? openTime + THREE_DAYS : nextOpenTime(openTime, timeframe)
}

export function lastClosedOpenTime(visibleUntil: number, timeframe: string): number {
  let open = alignOpenTime(visibleUntil - 1, timeframe, 'floor')
  while (klineCloseBoundary(open, timeframe) > visibleUntil) open = previousOpenTime(open, timeframe)
  return open
}

export function shiftOpenTime(
  openTime: number,
  timeframe: string,
  steps: number,
): number {
  let result = openTime
  const move = steps >= 0 ? nextOpenTime : previousOpenTime
  for (let index = 0; index < Math.abs(steps); index += 1) {
    result = move(result, timeframe)
  }
  return result
}

/** Shift an arbitrary cursor by one period, preserving its offset within the day. */
export function shiftTimeByPeriod(timestamp: number, timeframe: MarketTimeframe, direction: 1 | -1): number {
  if (timeframe !== '1M') {
    return timestamp + direction * (timeframe === '1w' ? WEEK_INTERVAL : FIXED_INTERVALS[timeframe])
  }
  const date = new Date(timestamp)
  const day = date.getUTCDate()
  date.setUTCMonth(date.getUTCMonth() + direction, 1)
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, lastDay))
  return date.getTime()
}
