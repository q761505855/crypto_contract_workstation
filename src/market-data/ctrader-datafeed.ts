import type { Datafeed, DatafeedSubscribeCallback, Period, SymbolInfo } from '@klinecharts/pro'
import type { KLineData } from 'klinecharts'
import { CTRADER_TIMEFRAMES, alignOpenTime, shiftOpenTime } from './intervals'
import { INITIAL_LIVE_STATUS, type LiveMarketStatus } from './live-models'
import { toSymbolInfo, type MarketCandle, type MarketSelection, type MarketSymbol } from './models'
import { toChartCandle } from './chart-candle'

const HISTORY_CANDLES = 499
const NEWER_HISTORY_MAX_WINDOWS = 12

interface ChartSubscription {
  symbol: SymbolInfo
  period: Period
  callback: DatafeedSubscribeCallback
  stop?: () => void
}

export interface ChartPriceMarket {
  historyBounds?(symbol: string, signal?: AbortSignal): Promise<{ from: number; to: number } | undefined>
  historyPageSize?(timeframe: string): number
  getSymbols(options?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<MarketSymbol[]>
  loadCandles(kind: 'trade', symbol: string, timeframe: string, start: number, end: number, options?: { signal?: AbortSignal }): Promise<MarketCandle[]>
  loadRecentCandles(symbol: string, timeframe: string, to: number, options: { signal?: AbortSignal }): Promise<MarketCandle[]>
  loadRecentCandlesPage(symbol: string, timeframe: string, to: number, options: { signal?: AbortSignal }):
    Promise<{ candles: MarketCandle[]; nextTo: number }>
  subscribe(input: { symbol: string; timeframe: string; getHistoryCandle: () => MarketCandle | undefined;
    onCandle: (candle: MarketCandle) => void; onStatus: (status: LiveMarketStatus) => void }): () => void
}

export class CTraderDatafeed implements Datafeed {
  private onLiveStatus?: (status: LiveMarketStatus) => void
  private onWarning?: (message: string) => void
  private onSelection?: (selection: MarketSelection) => void
  private onReconnect?: () => void
  private liveEnabled = false
  private hasConnected = false
  private status = INITIAL_LIVE_STATUS
  private historySequence = 0
  private historyCandle?: MarketCandle
  private latestLiveCandle?: MarketCandle
  private detachedHistoryKey?: string
  private initialArchiveOnly = false
  private olderHistoryCursor?: { key: string; before: number; to: number }
  private newerHistoryCursor?: { key: string; after: number; from: number }
  private readonly subscriptions = new Map<string, ChartSubscription>()

  constructor(private readonly service: ChartPriceMarket) {}

  createChartView(): CTraderDatafeed {
    return new CTraderDatafeed(this.service)
  }

  hasLiveTail(symbol: SymbolInfo, period: Period): boolean {
    return this.liveEnabled && this.detachedHistoryKey !== this.selectionKey(symbol, period)
  }

  isShowingLatestArchive(): boolean { return this.initialArchiveOnly }

  allowOlderArchives(): void { this.initialArchiveOnly = false }

  setSelectionListener(listener?: (selection: MarketSelection) => void): void {
    this.onSelection = listener
  }

  setWarningListener(listener?: (message: string) => void): void {
    this.onWarning = listener
  }

  setLiveStatusListener(listener?: (status: LiveMarketStatus) => void): void {
    this.onLiveStatus = listener
    listener?.(this.status)
  }

  setReconnectListener(listener?: () => void): void {
    this.onReconnect = listener
  }

  setLiveEnabled(enabled: boolean): void {
    if (this.liveEnabled === enabled) return
    this.liveEnabled = enabled
    for (const [key, subscription] of this.subscriptions) {
      if (enabled) this.startSubscription(key, subscription)
      else {
        subscription.stop?.()
        subscription.stop = undefined
      }
    }
    if (!enabled) {
      this.hasConnected = false
      this.latestLiveCandle = undefined
      this.publishStatus(INITIAL_LIVE_STATUS)
    }
  }

  async searchSymbols(search = ''): Promise<SymbolInfo[]> {
    const query = search.trim().toUpperCase()
    const symbols = await this.service.getSymbols()
    return symbols.filter(item => `${item.symbol} ${item.baseAsset} ${item.quoteAsset} ${item.description ?? ''}`.toUpperCase().includes(query)).map(toSymbolInfo)
  }

  async getHistoryKLineData(
    symbol: SymbolInfo, period: Period, from: number, to: number, notifySelection = true, signal?: AbortSignal,
    preferLatestArchive = true,
  ): Promise<KLineData[]> {
    signal?.throwIfAborted()
    const timeframe = CTRADER_TIMEFRAMES.find(value => value === period.text)
    if (!timeframe || !Number.isFinite(from) || !Number.isFinite(to)) return []
    const end = Math.min(to, Date.now())
    const pageSize = this.service.historyPageSize?.(timeframe) ?? HISTORY_CANDLES
    const start = Math.max(0, from, shiftOpenTime(alignOpenTime(end, timeframe, 'floor'), timeframe, 1 - pageSize))
    if (start > end) return []
    const sequence = notifySelection ? ++this.historySequence : this.historySequence
    if (notifySelection) {
      this.initialArchiveOnly = preferLatestArchive && !!this.service.historyBounds && end >= Date.now() - 60_000
      this.olderHistoryCursor = undefined
      this.newerHistoryCursor = undefined
      this.onSelection?.({ symbol, period })
    }
    const publish = (message: string) => {
      if (notifySelection && sequence === this.historySequence && !signal?.aborted) this.onWarning?.(message)
    }
    try {
      if (this.service.historyBounds) publish('正在读取并聚合本地逐笔成交…')
      let candles = notifySelection && this.initialArchiveOnly
        ? await this.service.loadRecentCandles(symbol.ticker, timeframe, end, { signal })
        : await this.service.loadCandles('trade', symbol.ticker, timeframe, start, end, { signal })
      if (!this.service.historyBounds && notifySelection && candles.length === 0 && end >= Date.now() - 60_000) {
        candles = await this.service.loadRecentCandles(symbol.ticker, timeframe, end, { signal })
      }
      signal?.throwIfAborted()
      if (notifySelection && sequence !== this.historySequence) return []
      if (notifySelection && !signal?.aborted) {
        if (end >= Date.now() - 60_000) {
          this.detachedHistoryKey = undefined
          candles = this.mergeLiveCandle(candles, symbol, period, start, end)
          const last = candles.at(-1)
          this.historyCandle = last?.isClosed === false ? last : undefined
        } else if (candles.length > 0) {
          this.detachedHistoryKey = this.selectionKey(symbol, period)
        }
      }
      publish('')
      return candles.map(toChartCandle)
    } catch (reason) {
      signal?.throwIfAborted()
      publish(reason instanceof Error ? reason.message : '行情读取失败。')
      return []
    }
  }

  async getOlderHistory(symbol: SymbolInfo, period: Period, before: number, signal?: AbortSignal) {
    signal?.throwIfAborted()
    // The chart asks for an older page automatically if the latest archive
    // does not fill the viewport. Keep paging open for a later manual pan.
    if (this.initialArchiveOnly) return { candles: [], hasMore: true }
    const key = this.selectionKey(symbol, period)
    const cursor = this.olderHistoryCursor
    const to = cursor?.key === key && cursor.before === before ? cursor.to : before - 1
    const sequence = this.historySequence
    const publish = (message: string) => {
      if (sequence === this.historySequence && !signal?.aborted) this.onWarning?.(message)
    }
    publish('正在加载更早的 K 线…')
    try {
      const { candles, nextTo } = await this.service.loadRecentCandlesPage(symbol.ticker, period.text, to, { signal })
      signal?.throwIfAborted()
      if (sequence !== this.historySequence) return { candles: [], hasMore: true }
      const hasMore = this.service.historyBounds || candles.length === 0 ? nextTo >= 0 : candles[0].openTime > 0
      this.olderHistoryCursor = candles.length === 0 && hasMore ? { key, before, to: nextTo } : undefined
      publish(!hasMore ? '已到最早历史数据' : candles.length === 0 ? '此区间无报价，继续向左查看' : '')
      return { candles: candles.map(toChartCandle), hasMore }
    } catch (reason) {
      if (signal?.aborted) {
        if (sequence === this.historySequence) this.onWarning?.('')
        throw reason
      }
      publish(reason instanceof Error ? reason.message : '更早的 K 线读取失败，可继续向左重试。')
      return { candles: [], hasMore: true }
    }
  }

  async getNewerHistory(symbol: SymbolInfo, period: Period, after: number, signal?: AbortSignal) {
    const timeframe = CTRADER_TIMEFRAMES.find(value => value === period.text)
    if (!timeframe || !Number.isFinite(after)) return { candles: [], hasMore: false }
    const key = this.selectionKey(symbol, period)
    if (this.liveEnabled && this.detachedHistoryKey !== key) return { candles: [], hasMore: true }
    const sequence = this.historySequence
    const cursor = this.newerHistoryCursor
    const bounds = this.service.historyBounds ? await this.service.historyBounds(symbol.ticker, signal) : undefined
    if (this.service.historyBounds && !bounds) return { candles: [], hasMore: false }
    const latest = bounds?.to ?? Date.now()
    let from = cursor?.key === key && cursor.after === after ? cursor.from : after + 1
    for (let window = 0; window < NEWER_HISTORY_MAX_WINDOWS && from <= latest; window++) {
      const to = Math.min(latest, shiftOpenTime(from, timeframe, this.service.historyPageSize?.(timeframe) ?? HISTORY_CANDLES) - 1)
      let candles = await this.service.loadCandles('trade', symbol.ticker, timeframe, from, to, { signal })
      signal?.throwIfAborted()
      if (sequence !== this.historySequence) return { candles: [], hasMore: true }
      const hasMore = to < latest
      if (!hasMore && this.detachedHistoryKey === key) {
        // Keep the live subscription connected during a distant history jump.
        // Rejoin its stream only once the intervening history is loaded.
        candles = this.mergeLiveCandle(candles, symbol, period, from, Date.now())
        this.detachedHistoryKey = undefined
      }
      if (candles.length > 0 || !hasMore) {
        this.newerHistoryCursor = undefined
        return { candles: candles.map(toChartCandle), hasMore }
      }
      from = to + 1
    }
    const hasMore = from <= latest
    this.newerHistoryCursor = hasMore ? { key, after, from } : undefined
    return { candles: [], hasMore }
  }

  subscribe(symbol: SymbolInfo, period: Period, callback: DatafeedSubscribeCallback): void {
    this.unsubscribe(symbol, period)
    const key = this.selectionKey(symbol, period)
    const subscription = { symbol, period, callback }
    this.subscriptions.set(key, subscription)
    if (this.liveEnabled) this.startSubscription(key, subscription)
  }

  unsubscribe(symbol: SymbolInfo, period: Period): void {
    const key = this.selectionKey(symbol, period)
    const subscription = this.subscriptions.get(key)
    this.subscriptions.delete(key)
    subscription?.stop?.()
  }

  private startSubscription(key: string, subscription: ChartSubscription): void {
    const active = () => this.liveEnabled && this.subscriptions.get(key) === subscription
    subscription.stop = this.service.subscribe({
      symbol: subscription.symbol.ticker,
      timeframe: subscription.period.text,
      getHistoryCandle: () => {
        const candle = this.historyCandle
        return candle && this.selectionKey(subscription.symbol, subscription.period) === `${candle.symbol.toUpperCase()}:${candle.timeframe}`
          ? candle : undefined
      },
      onCandle: candle => {
        if (!active()) return
        if (candle.openTime >= (this.latestLiveCandle?.openTime ?? -1) ||
            this.latestLiveCandle?.symbol !== candle.symbol || this.latestLiveCandle?.timeframe !== candle.timeframe) {
          this.latestLiveCandle = candle
        }
        if (this.detachedHistoryKey !== key) subscription.callback(toChartCandle(candle))
      },
      onStatus: status => {
        if (active()) this.publishStatus(status)
      },
    })
  }

  private publishStatus(status: LiveMarketStatus): void {
    const recovered = this.hasConnected && this.status.connection !== 'connected' && status.connection === 'connected'
    if (status.connection === 'connected') this.hasConnected = true
    this.status = status
    this.onLiveStatus?.(status)
    if (recovered && this.detachedHistoryKey === undefined) this.onReconnect?.()
  }

  private mergeLiveCandle(candles: MarketCandle[], symbol: SymbolInfo, period: Period, from: number, to: number): MarketCandle[] {
    const live = this.latestLiveCandle
    if (!live || this.selectionKey(symbol, period) !== `${live.symbol.toUpperCase()}:${live.timeframe}` ||
      live.openTime < from || live.openTime > to) return candles
    const last = candles.at(-1)
    if (last === undefined || live.openTime > last.openTime) return [...candles, live]
    if (live.openTime === last.openTime && !last.isClosed) return [...candles.slice(0, -1), live]
    return candles
  }

  private selectionKey(symbol: SymbolInfo, period: Period): string {
    return `${symbol.ticker.toUpperCase()}:${period.text}`
  }
}
