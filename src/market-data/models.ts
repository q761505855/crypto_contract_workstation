import type { Period, SymbolInfo } from '@klinecharts/pro'

/** `mark` identifies legacy IndexedDB records only; active market services accept `trade`. */
export type CandleKind = 'trade' | 'mark'

export interface MarketSymbol {
  symbol: string
  baseAsset: string
  quoteAsset: string
  contractType: 'PERPETUAL' | 'CFD'
  status: 'TRADING'
  onboardDate: number
  pricePrecision: number
  quantityPrecision: number
  description?: string
}

export interface MarketCandle {
  symbol: string
  timeframe: string
  openTime: number
  closeTime: number
  open: string
  high: string
  low: string
  close: string
  volume: string
  quoteVolume: string
  tradeCount: number
  isClosed: boolean
  source: 'binance' | 'ctrader'
  /** Quote tick count reported by cTrader. It is not exchange trade volume. */
  tickVolume?: number
}

export interface MarketSelection {
  symbol: SymbolInfo
  period: Period
}

export interface MissingRange {
  from: number
  to: number
}

export interface SeriesSummary {
  count: number
  firstOpenTime: number | null
  lastOpenTime: number | null
  gaps: MissingRange[]
}

export interface DownloadProgress {
  kind: CandleKind
  received: number
  stored: number
  page: number
}

export const EMPTY_SERIES_SUMMARY: SeriesSummary = Object.freeze({
  count: 0,
  firstOpenTime: null,
  lastOpenTime: null,
  gaps: [],
})

export function normalizeMarketTicker(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  const ticker = value.trim().toUpperCase()
  if (ticker.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(ticker)) return ticker
}

export function toSymbolInfo(symbol: MarketSymbol): SymbolInfo {
  const isCTrader = symbol.contractType === 'CFD'
  return {
    exchange: isCTrader ? 'CTRADER' : 'BINANCE',
    market: isCTrader ? 'IC Markets Demo' : 'USDT-M PERPETUAL',
    name: isCTrader ? symbol.description ?? symbol.symbol : `${symbol.baseAsset} / ${symbol.quoteAsset} Perpetual`,
    shortName: symbol.symbol,
    ticker: symbol.symbol,
    priceCurrency: symbol.quoteAsset,
    type: symbol.contractType,
    pricePrecision: symbol.pricePrecision,
    volumePrecision: isCTrader ? 0 : symbol.quantityPrecision,
  }
}
