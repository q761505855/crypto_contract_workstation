import type { Period, SymbolInfo } from '@klinecharts/pro'

export type CandleKind = 'trade' | 'mark'

export interface MarketSymbol {
  symbol: string
  baseAsset: string
  quoteAsset: string
  contractType: 'PERPETUAL'
  status: 'TRADING'
  onboardDate: number
  pricePrecision: number
  quantityPrecision: number
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
  source: 'binance'
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

export function toSymbolInfo(symbol: MarketSymbol): SymbolInfo {
  return {
    exchange: 'BINANCE',
    market: 'USDT-M PERPETUAL',
    name: `${symbol.baseAsset} / ${symbol.quoteAsset} Perpetual`,
    shortName: symbol.symbol,
    ticker: symbol.symbol,
    priceCurrency: symbol.quoteAsset,
    type: 'PERPETUAL',
    pricePrecision: symbol.pricePrecision,
    volumePrecision: symbol.quantityPrecision,
  }
}
