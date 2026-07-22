import type {
  ChartProOptions,
  Datafeed,
  Period,
  SymbolInfo,
} from '@klinecharts/pro'

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
): ChartProOptions {
  return {
    container,
    datafeed,
    drawingBarVisible: true,
    locale: 'zh-CN',
    mainIndicators: [...DEFAULT_MAIN_INDICATORS],
    period: SUPPORTED_PERIODS[3],
    periods: [...SUPPORTED_PERIODS],
    subIndicators: [...DEFAULT_SUB_INDICATORS],
    symbol: { ...DEFAULT_SYMBOL },
    theme: 'dark',
    timezone: 'Asia/Shanghai',
  }
}
