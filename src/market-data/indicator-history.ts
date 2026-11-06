import type { Datafeed, Period, SymbolInfo } from '@klinecharts/pro'
import type { KLineData } from 'klinecharts'

export function readChartHistory(
  feed: Datafeed,
  symbol: SymbolInfo,
  period: Period,
  from: number,
  to: number,
  notifySelection = true,
  signal?: AbortSignal,
): Promise<KLineData[]> {
  const read: (
    symbol: SymbolInfo, period: Period, from: number, to: number,
    notifySelection?: boolean, signal?: AbortSignal,
  ) => Promise<KLineData[]> = feed.getHistoryKLineData.bind(feed)
  if (signal) return read(symbol, period, from, to, notifySelection, signal)
  return notifySelection ? read(symbol, period, from, to) : read(symbol, period, from, to, false)
}

/** Indicator reads share cache/replay guards without changing chart selection. */
export function readIndicatorHistory(feed: Datafeed, symbol: SymbolInfo, period: Period, from: number, to: number, signal?: AbortSignal): Promise<KLineData[]> {
  return readChartHistory(feed, symbol, period, from, to, false, signal)
}
