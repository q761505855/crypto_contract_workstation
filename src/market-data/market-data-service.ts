import { findMissingRanges } from './gaps'
import type {
  CandleKind,
  DownloadProgress,
  MarketCandle,
  MarketSymbol,
  SeriesSummary,
} from './models'
import { BinanceRestClient } from './rest-client'
import type { MarketDataStore } from '../storage/market-data-store'

export interface LoadCandlesOptions {
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
  onWarning?: (message: string) => void
}

export class MarketDataService {
  private symbols: MarketSymbol[] | null = null

  constructor(
    private readonly client: BinanceRestClient,
    private readonly store: MarketDataStore,
  ) {}

  getBaseUrl(): string {
    return this.client.getBaseUrl()
  }

  setBaseUrl(baseUrl: string): void {
    this.client.setBaseUrl(baseUrl)
    this.symbols = null
  }

  async getSymbols(
    options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<MarketSymbol[]> {
    if (!options.forceRefresh && this.symbols !== null) {
      return this.symbols.map((symbol) => ({ ...symbol }))
    }

    try {
      const remote = await this.client.getExchangeSymbols(options.signal)
      await this.store.putSymbols(remote)
      this.symbols = remote
      return remote.map((symbol) => ({ ...symbol }))
    } catch (error) {
      const cached = await this.store.getSymbols()
      if (cached.length > 0) {
        this.symbols = cached
        return cached.map((symbol) => ({ ...symbol }))
      }
      throw error
    }
  }

  async loadCandles(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
    from: number,
    to: number,
    options: LoadCandlesOptions = {},
  ): Promise<MarketCandle[]> {
    const normalizedSymbol = symbol.toUpperCase()
    let cached = await this.store.getCandles(
      kind,
      normalizedSymbol,
      timeframe,
      from,
      to,
    )
    const missingRanges = findMissingRanges(
      cached.filter((candle) => candle.isClosed),
      timeframe,
      from,
      to,
    )

    try {
      for (const range of missingRanges) {
        const downloaded = await this.client.downloadRange(
          kind,
          normalizedSymbol,
          timeframe,
          range.from,
          range.to,
          options,
        )
        await this.store.putCandles(kind, downloaded)
      }
    } catch (error) {
      cached = await this.store.getCandles(
        kind,
        normalizedSymbol,
        timeframe,
        from,
        to,
      )
      if (cached.length === 0) {
        throw error
      }
      options.onWarning?.(
        `币安接口不可用，当前显示本地缓存：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    cached = await this.store.getCandles(
      kind,
      normalizedSymbol,
      timeframe,
      from,
      to,
    )
    return cached.sort((left, right) => left.openTime - right.openTime)
  }

  async refreshCandles(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
    from: number,
    to: number,
  ): Promise<MarketCandle[]> {
    const downloaded = await this.client.downloadRange(
      kind,
      symbol.toUpperCase(),
      timeframe,
      from,
      to,
    )
    await this.store.putCandles(kind, downloaded)
    return downloaded
  }

  async inspectSeries(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
  ): Promise<SeriesSummary> {
    return this.store.getSeriesSummary(kind, symbol, timeframe)
  }

  async deleteSeries(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
  ): Promise<void> {
    await this.store.deleteSeries(kind, symbol, timeframe)
  }

  async saveRealtimeCandle(
    kind: CandleKind,
    candle: MarketCandle,
  ): Promise<void> {
    if (!candle.isClosed) {
      return
    }
    await this.store.putCandles(kind, [candle])
  }
}
