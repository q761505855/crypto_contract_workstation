import type { Period } from '@klinecharts/pro'

const FIXED_INTERVALS: Readonly<Record<string, number>> = Object.freeze({
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
  '3d': 3 * 86_400_000,
})

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

export function nextOpenTime(openTime: number, timeframe: string): number {
  if (timeframe === '1M') {
    const date = new Date(openTime)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  }
  if (timeframe === '1w') {
    return openTime + WEEK_INTERVAL
  }
  const interval = FIXED_INTERVALS[timeframe]
  if (interval === undefined) {
    throw new Error(`不支持的周期：${timeframe}`)
  }
  return openTime + interval
}

export function previousOpenTime(openTime: number, timeframe: string): number {
  if (timeframe === '1M') {
    const date = new Date(openTime)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)
  }
  if (timeframe === '1w') {
    return openTime - WEEK_INTERVAL
  }
  const interval = FIXED_INTERVALS[timeframe]
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
  } else {
    const interval = FIXED_INTERVALS[timeframe]
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
