import { findMissingRanges } from './gaps'
import { alignOpenTime, nextOpenTime, previousOpenTime, shiftOpenTime } from './intervals'
import type {
  CandleKind,
  DownloadProgress,
  MarketCandle,
  MarketSymbol,
  SeriesSummary,
} from './models'
import { BinanceRestClient } from './rest-client'
import type { MarketDataStore } from '../storage/market-data-store'
import { MinuteHistory, type HistoryServices, type PrepareHistoryOptions } from './minute-history'

export interface LoadCandlesOptions {
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
  onWarning?: (message: string) => void
  onStatus?: (message: string) => void
}

export interface ReplayLoadOptions extends LoadCandlesOptions {
  prefetchTo?: number
}

interface ReplayBatch {
  from: number
  to: number
  ready: Promise<void>
}

export class MarketDataService {
  private symbols: MarketSymbol[] | null = null
  private symbolsRequest: Promise<MarketSymbol[]> | null = null
  private readonly seriesQueues = new Map<string, Promise<void>>()
  private readonly replayBatches = new Map<string, ReplayBatch[]>()
  private readonly replayFailures = new Map<string, string>()
  private readonly minuteHistory?: MinuteHistory

  constructor(
    private readonly client: BinanceRestClient,
    private readonly store: MarketDataStore,
    history?: HistoryServices,
  ) {
    if (history) this.minuteHistory = new MinuteHistory(client, store, history)
  }

  usesMinuteHistory(): boolean { return this.minuteHistory !== undefined }

  async prepareHistory(symbol: string, from: number, to: number, options: PrepareHistoryOptions = {}): Promise<{ from: number; to: number }> {
    if (!this.minuteHistory) throw new Error('分钟历史归档服务未初始化')
    return this.minuteHistory.prepare(symbol, from, to, options)
  }

  getPendingUploadCount(): number { return this.minuteHistory?.getPendingUploadCount() ?? 0 }
  async retryPendingUploads(): Promise<void> { await this.minuteHistory?.retryPendingUploads() }

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

    if (this.symbolsRequest !== null) {
      return (await this.symbolsRequest).map((symbol) => ({ ...symbol }))
    }
    const request = this.loadSymbols(options.signal)
    this.symbolsRequest = request
    try {
      return await request
    } finally {
      if (this.symbolsRequest === request) this.symbolsRequest = null
    }
  }

  private async loadSymbols(signal?: AbortSignal): Promise<MarketSymbol[]> {
    try {
      const remote = await this.client.getExchangeSymbols(signal)
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
    if (kind !== 'trade') throw new Error('仅支持普通价格 K 线')
    if (this.minuteHistory) return this.minuteHistory.load(kind, symbol, timeframe, from, to, options)
    const key = `${kind}:${symbol.toUpperCase()}:${timeframe}`
    return this.queueSeries(key, () => this.loadSeries(
      kind, symbol, timeframe, from, to, options,
    ))
  }

  async loadCachedCandles(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
    from: number,
    to: number,
  ): Promise<MarketCandle[]> {
    if (kind !== 'trade') throw new Error('仅支持普通价格 K 线')
    if (this.minuteHistory) return this.minuteHistory.cached(kind, symbol, timeframe, from, to)
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error('本地行情读取时间必须为有效时间戳')
    }
    if (Math.max(0, from) > to) return []
    return (await this.store.getCandles(
      kind, symbol.toUpperCase(), timeframe, Math.max(0, from), to,
    ))
      .filter((candle) => candle.isClosed)
      .sort((left, right) => left.openTime - right.openTime)
  }

  resetReplayRequests(): void {
    this.replayBatches.clear()
    this.replayFailures.clear()
  }

  async loadReplayCandles(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
    from: number,
    to: number,
    options: ReplayLoadOptions = {},
  ): Promise<MarketCandle[]> {
    const cached = await this.loadCachedCandles(kind, symbol, timeframe, from, to)
    const latestClosed = previousOpenTime(alignOpenTime(Date.now(), timeframe, 'floor'), timeframe)
    const requestedTo = Math.min(to, latestClosed)
    const gaps = findMissingRanges(cached, timeframe, Math.max(0, from), requestedTo)
    if (gaps.length === 0) return cached
    const key = `${kind}:${symbol.toUpperCase()}:${timeframe}`
    const previousFailure = this.replayFailures.get(key)
    if (previousFailure !== undefined) {
      options.onWarning?.(previousFailure)
      return cached
    }
    if (this.minuteHistory) {
      // Canonical minutes already prepare Git/Binance data month by month.
      // REST page-sized replay batches would repeatedly revisit the same month.
      try {
        await this.loadCandles(kind,symbol,timeframe,from,Math.min(requestedTo,options.prefetchTo ?? Infinity), {
          ...options,
          onWarning: message => {
            this.replayFailures.set(key,message)
            options.onWarning?.(message)
          },
        })
      } catch (reason) {
        const message = `回放按月准备未完成：${reason instanceof Error ? reason.message : String(reason)}`
        this.replayFailures.set(key,message)
        options.onWarning?.(message)
      }
      return this.loadCachedCandles(kind,symbol,timeframe,from,to)
    }
    const batches = this.replayBatches.get(key) ?? []
    this.replayBatches.set(key, batches)
    fill: for (const gap of gaps) {
      let cursor = gap.from
      while (cursor <= gap.to) {
        options.signal?.throwIfAborted()
        const existing = batches.find((batch) => cursor >= batch.from && cursor <= batch.to)
        if (existing !== undefined) {
          await existing.ready
          if (this.replayFailures.has(key)) break fill
          cursor = nextOpenTime(existing.to, timeframe)
          continue
        }
        // Fill a page ahead, rather than issuing a one-candle request on every
        // step. Keep both successful and failed attempts for this replay run.
        const batchFrom = cursor
        const batchTo = Math.min(
          shiftOpenTime(batchFrom, timeframe, 498),
          latestClosed,
          options.prefetchTo ?? Infinity,
        )
        if (batchTo < batchFrom) break
        const batch: ReplayBatch = { from: batchFrom, to: alignOpenTime(batchTo, timeframe, 'floor'), ready: Promise.resolve() }
        batches.push(batch)
        batch.ready = (async () => {
          try {
            await this.loadCandles(kind, symbol, timeframe, batch.from, batch.to, {
              ...options,
              onWarning: (message) => {
                this.replayFailures.set(key, message)
                options.onWarning?.(message)
              },
            })
          } catch (reason) {
            const message = `批量补缺已停止，不会逐根重试：${reason instanceof Error ? reason.message : String(reason)}`
            this.replayFailures.set(key, message)
            options.onWarning?.(message)
          }
        })()
        await batch.ready
        if (this.replayFailures.has(key)) break fill
        cursor = nextOpenTime(batch.to, timeframe)
      }
    }
    return this.loadCachedCandles(kind, symbol, timeframe, from, to)
  }

  private async loadSeries(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
    from: number,
    to: number,
    options: LoadCandlesOptions,
  ): Promise<MarketCandle[]> {
    options.signal?.throwIfAborted()
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error('行情请求时间必须为有效时间戳')
    }
    const normalizedSymbol = symbol.toUpperCase()
    const symbols = this.symbols ?? await this.store.getSymbols()
    const onboardDate = symbols.find((item) => item.symbol === normalizedSymbol)?.onboardDate
    from = Math.max(0, from, onboardDate === undefined
      ? 0
      : alignOpenTime(onboardDate, timeframe, 'floor'))
    if (from > to) return []
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
    const downloadRanges = missingRanges.length > 1 &&
      shiftOpenTime(missingRanges[0].from, timeframe, 498) >= missingRanges.at(-1)!.to
      ? [{ from: missingRanges[0].from, to: missingRanges.at(-1)!.to }]
      : missingRanges

    try {
      for (const range of downloadRanges) {
        const downloaded = await this.client.downloadRange(
          kind,
          normalizedSymbol,
          timeframe,
          range.from,
          range.to,
          { ...options, onPage: (candles) => this.store.putCandles(kind, candles) },
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
    if (kind !== 'trade') throw new Error('仅支持普通价格 K 线')
    const normalizedSymbol = symbol.toUpperCase()
    if (this.minuteHistory) return this.minuteHistory.load(kind, normalizedSymbol, timeframe, from, to)
    return this.queueSeries(`${kind}:${normalizedSymbol}:${timeframe}`, async () => {
      const downloaded = await this.client.downloadRange(
        kind, normalizedSymbol, timeframe, Math.max(0, from), to,
        { onPage: (candles) => this.store.putCandles(kind, candles) },
      )
      await this.store.putCandles(kind, downloaded)
      return downloaded
    })
  }

  private queueSeries<T>(key: string, action: () => Promise<T>): Promise<T> {
    const result = (this.seriesQueues.get(key) ?? Promise.resolve()).then(action)
    const settled = result.then(() => undefined, () => undefined)
    this.seriesQueues.set(key, settled)
    return result.finally(() => {
      if (this.seriesQueues.get(key) === settled) this.seriesQueues.delete(key)
    })
  }

  async inspectSeries(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
  ): Promise<SeriesSummary> {
    if (kind !== 'trade') throw new Error('仅支持普通价格 K 线')
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
    if (kind !== 'trade') throw new Error('仅支持普通价格 K 线')
    if (!candle.isClosed) {
      return
    }
    await this.store.putCandles(kind, [candle])
  }
}
