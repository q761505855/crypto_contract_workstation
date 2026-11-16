import { nextOpenTime, previousOpenTime } from '../market-data/intervals'

type CandleTime = { timestamp: number }

export function drawingIndexAt(candles: readonly CandleTime[], timestamp: number, period: string): number {
  const first = candles[0].timestamp
  const lastIndex = candles.length - 1
  const last = candles[lastIndex].timestamp
  if (timestamp < first) return (timestamp - first) / (first - previousOpenTime(first, period))
  if (timestamp >= last) return lastIndex + (timestamp - last) / (nextOpenTime(last, period) - last)
  let low = 0
  let high = lastIndex
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2)
    if (candles[mid].timestamp <= timestamp) low = mid
    else high = mid
  }
  return low + (timestamp - candles[low].timestamp) / (candles[high].timestamp - candles[low].timestamp)
}

export function drawingTimeAt(candles: readonly CandleTime[], index: number, period: string): number {
  const first = candles[0].timestamp
  const lastIndex = candles.length - 1
  const last = candles[lastIndex].timestamp
  if (index < 0) return Math.round(first + index * (first - previousOpenTime(first, period)))
  if (index >= lastIndex) return Math.round(last + (index - lastIndex) * (nextOpenTime(last, period) - last))
  const lower = Math.floor(index)
  const start = candles[lower].timestamp
  return Math.round(start + (index - lower) * (candles[lower + 1].timestamp - start))
}
