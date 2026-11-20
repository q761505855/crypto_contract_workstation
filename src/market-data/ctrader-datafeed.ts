import type { Datafeed, DatafeedSubscribeCallback, Period, SymbolInfo } from '@klinecharts/pro'
import type { KLineData } from 'klinecharts'
import { CTRADER_TIMEFRAMES, alignOpenTime, shiftOpenTime } from './intervals'
import { INITIAL_LIVE_STATUS, type LiveMarketStatus } from './live-models'
import { toSymbolInfo, type MarketCandle, type MarketSelection } from './models'
import type { CTraderMarketService } from './ctrader-market'
import { toChartCandle } from './chart-candle'

const HISTORY_CANDLES = 499
const NEWER_HISTORY_MAX_WINDOWS = 12

interface ChartSubscription {
  symbol: SymbolInfo
  period: Period
  callback: DatafeedSubscribeCallback
  stop?: () => void
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
  private newerHistoryCursor?: { key: string; after: number; from: number }
  private readonly subscriptions = new Map<string, ChartSubscription>()

  constructor(private readonly service: CTraderMarketService) {}

  createChartView(): CTraderDatafeed {
    return new CTraderDatafeed(this.service)
  }

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
  ): Promise<KLineData[]> {
    signal?.throwIfAborted()
    const timeframe = CTRADER_TIMEFRAMES.find(value => value === period.text)
    if (!timeframe || !Number.isFinite(from) || !Number.isFinite(to)) return []
    const end = Math.min(to, Date.now())
    const start = Math.max(0, from, shiftOpenTime(alignOpenTime(end, timeframe, 'floor'), timeframe, 1 - HISTORY_CANDLES))
    if (start > end) return []
    const sequence = notifySelection ? ++this.historySequence : this.historySequence
    if (notifySelection) this.onSelection?.({ symbol, period })
    const publish = (message: string) => {
      if (notifySelection && sequence === this.historySequence && !signal?.aborted) this.onWarning?.(message)
    }
    try {
      let candles = await this.service.loadCandles('trade', symbol.ticker, timeframe, start, end, { signal })
      if (notifySelection && candles.length === 0 && end >= Date.now() - 60_000) {
        candles = await this.service.loadRecentCandles(symbol.ticker, timeframe, end, { signal })
      }
      signal?.throwIfAborted()
      if (notifySelection && sequence !== this.historySequence) return []
      if (notifySelection && end >= Date.now() - 60_000) {
        const last = candles.at(-1)
        this.historyCandle = last?.isClosed === false ? last : undefined
      }
      publish('')
      return candles.map(toChartCandle)
    } catch (reason) {
      signal?.throwIfAborted()
      publish(reason instanceof Error ? reason.message : 'cTrader 行情读取失败。')
      return []
    }
  }

  async getOlderHistory(symbol: SymbolInfo, period: Period, before: number, signal?: AbortSignal) {
    const candles = await this.service.loadRecentCandles(symbol.ticker, period.text, before - 1, { signal })
    signal?.throwIfAborted()
    return { candles: candles.map(toChartCandle), hasMore: candles.length > 0 && candles[0].openTime > 0 }
  }

  async getNewerHistory(symbol: SymbolInfo, period: Period, after: number, signal?: AbortSignal) {
    const timeframe = CTRADER_TIMEFRAMES.find(value => value === period.text)
    if (!timeframe || !Number.isFinite(after)) return { candles: [], hasMore: false }
    if (this.liveEnabled) return { candles: [], hasMore: true }
    const key = this.selectionKey(symbol, period)
    const cursor = this.newerHistoryCursor
    const latest = Date.now()
    let from = cursor?.key === key && cursor.after === after ? cursor.from : after + 1
    for (let window = 0; window < NEWER_HISTORY_MAX_WINDOWS && from <= latest; window++) {
      const to = Math.min(latest, shiftOpenTime(from, timeframe, HISTORY_CANDLES) - 1)
      const candles = await this.service.loadCandles('trade', symbol.ticker, timeframe, from, to, { signal })
      signal?.throwIfAborted()
      if (this.liveEnabled) return { candles: [], hasMore: true }
      if (candles.length > 0) {
        this.newerHistoryCursor = undefined
        return { candles: candles.map(toChartCandle), hasMore: to < latest }
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
        if (active()) subscription.callback(toChartCandle(candle))
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
    if (recovered) this.onReconnect?.()
  }

  private selectionKey(symbol: SymbolInfo, period: Period): string {
    return `${symbol.ticker.toUpperCase()}:${period.text}`
  }
}
