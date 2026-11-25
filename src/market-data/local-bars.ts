import { alignOpenTime } from './intervals'

export interface LocalBar {
  openTime: number
  tradeCount: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number
}

export function aggregateLocalBars(rows: Iterable<LocalBar>, timeframe: string): LocalBar[] {
  const groups = new Map<number, LocalBar>()
  for (const row of rows) {
    const openTime = alignOpenTime(row.openTime, timeframe, 'floor')
    const bar = groups.get(openTime)
    if (!bar) {
      groups.set(openTime, { ...row, openTime })
      continue
    }
    bar.high = Math.max(bar.high, row.high)
    bar.low = Math.min(bar.low, row.low)
    bar.close = row.close
    bar.volume += row.volume
    bar.quoteVolume += row.quoteVolume
    bar.tradeCount += row.tradeCount
  }
  return [...groups.values()]
}
