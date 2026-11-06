import type {
  ChartProOptions,
  Datafeed,
  Period,
  SymbolInfo,
} from '@klinecharts/pro'
import type { ChartIndicatorPreferences } from './indicator-preferences'
import type { CandleType } from 'klinecharts'
import { readCandleType } from './candle-preferences'

export const DEFAULT_SYMBOL: SymbolInfo = Object.freeze({
  exchange: 'BINANCE',
  market: 'USDT-M PERPETUAL',
  name: 'Bitcoin / Tether USDT Perpetual',
  shortName: 'BTCUSDT',
  ticker: 'BTCUSDT',
  priceCurrency: 'USDT',
  type: 'PERPETUAL',
  pricePrecision: 2,
  volumePrecision: 3,
})

export const SUPPORTED_PERIODS: readonly Period[] = Object.freeze([
  { multiplier: 1, timespan: 'minute', text: '1m' },
  { multiplier: 3, timespan: 'minute', text: '3m' },
  { multiplier: 5, timespan: 'minute', text: '5m' },
  { multiplier: 15, timespan: 'minute', text: '15m' },
  { multiplier: 30, timespan: 'minute', text: '30m' },
  { multiplier: 1, timespan: 'hour', text: '1h' },
  { multiplier: 2, timespan: 'hour', text: '2h' },
  { multiplier: 4, timespan: 'hour', text: '4h' },
  { multiplier: 6, timespan: 'hour', text: '6h' },
  { multiplier: 8, timespan: 'hour', text: '8h' },
  { multiplier: 12, timespan: 'hour', text: '12h' },
  { multiplier: 1, timespan: 'day', text: '1d' },
  { multiplier: 3, timespan: 'day', text: '3d' },
  { multiplier: 1, timespan: 'week', text: '1w' },
  { multiplier: 1, timespan: 'month', text: '1M' },
])

export const DEFAULT_MAIN_INDICATORS = Object.freeze(['MA'])
export const DEFAULT_SUB_INDICATORS = Object.freeze(['VOL', 'MACD'])

export function createChartOptions(
  container: HTMLElement,
  datafeed: Datafeed,
  symbol: SymbolInfo = DEFAULT_SYMBOL,
  period: Period = SUPPORTED_PERIODS[3],
  indicatorPreferences: ChartIndicatorPreferences | null = null,
): ChartProOptions {
  return {
    container,
    datafeed,
    drawingBarVisible: !(typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px), (max-width: 1023px) and (max-height: 520px)').matches),
    styles: {
      candle: { type: readCandleType() as CandleType, tooltip: { offsetLeft: 24 } },
      indicator: { tooltip: { offsetLeft: 24 } },
    },
    locale: 'zh-CN',
    mainIndicators:
      indicatorPreferences?.main.map((indicator) => indicator.name) ??
      [...DEFAULT_MAIN_INDICATORS],
    period,
    periods: [...SUPPORTED_PERIODS],
    subIndicators:
      indicatorPreferences?.sub.flatMap((pane) =>
        pane.indicators.map((indicator) => indicator.name),
      ) ?? [...DEFAULT_SUB_INDICATORS],
    symbol: { ...symbol },
    theme: 'dark',
    timezone: 'Asia/Shanghai',
  }
}
