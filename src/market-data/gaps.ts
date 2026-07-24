import { alignOpenTime, nextOpenTime, previousOpenTime } from './intervals'
import type { MarketCandle, MissingRange } from './models'

export function findMissingRanges(
  candles: readonly MarketCandle[],
  timeframe: string,
  from: number,
  to: number,
): MissingRange[] {
  const firstExpected = alignOpenTime(from, timeframe, 'ceil')
  const lastExpected = alignOpenTime(to, timeframe, 'floor')
  if (firstExpected > lastExpected) {
    return []
  }

  const openTimes = [
    ...new Set(
      candles
        .map((candle) => candle.openTime)
        .filter((openTime) => openTime >= firstExpected && openTime <= lastExpected),
    ),
  ].sort((left, right) => left - right)

  const gaps: MissingRange[] = []
  let cursor = firstExpected
  for (const openTime of openTimes) {
    if (openTime < cursor) {
      continue
    }
    if (openTime > cursor) {
      gaps.push({
        from: cursor,
        to: previousOpenTime(openTime, timeframe),
      })
    }
    cursor = nextOpenTime(openTime, timeframe)
  }
  if (cursor <= lastExpected) {
    gaps.push({ from: cursor, to: lastExpected })
  }
  return gaps
}
