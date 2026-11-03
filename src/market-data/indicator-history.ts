import type { Datafeed, Period, SymbolInfo } from '@klinecharts/pro'
import type { KLineData } from 'klinecharts'

/** Indicator reads share the normal cache/replay guards without changing chart selection. */
export function readIndicatorHistory(
  feed: Datafeed,
  symbol: SymbolInfo,
  period: Period,
  from: number,
  to: number,
): Promise<KLineData[]> {
  const read: (
    symbol: SymbolInfo, period: Period, from: number, to: number,
    notifySelection?: boolean,
  ) => Promise<KLineData[]> = feed.getHistoryKLineData.bind(feed)
  return read(symbol, period, from, to, false)
}
