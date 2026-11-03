import type {
  Datafeed,
  DatafeedSubscribeCallback,
  Period,
  SymbolInfo,
} from '@klinecharts/pro'
import type { KLineData } from 'klinecharts'
import {
  alignOpenTime,
  periodToTimeframe,
  shiftOpenTime,
} from './intervals'
import type { MarketSelection } from './models'
import { toSymbolInfo } from './models'
import type { MarketDataService } from './market-data-service'
import type { LiveMarketStatus } from './live-models'
import { INITIAL_LIVE_STATUS } from './live-models'
import {
  BinanceLiveStream,
  type LiveStreamSubscriptionInput,
} from './live-stream'

const MAX_CHART_CANDLES = 499

interface LiveStreamPort {
  subscribe(input: LiveStreamSubscriptionInput): () => void
}

interface LiveSubscription {
  symbol: SymbolInfo
  period: Period
  callback: DatafeedSubscribeCallback
  stop: (() => void) | null
}

export class BinanceDatafeed implements Datafeed {
  private onSelectionChange?: (selection: MarketSelection) => void
  private onWarning?: (message: string) => void
  private onLiveStatus?: (status: LiveMarketStatus) => void
  private liveEnabled = false
  private liveStatus: LiveMarketStatus = { ...INITIAL_LIVE_STATUS }
  private readonly liveSubscriptions = new Map<string, LiveSubscription>()

  constructor(
    private readonly service: MarketDataService,
    private readonly liveStream: LiveStreamPort = new BinanceLiveStream(service),
  ) {}

  setSelectionListener(
    listener?: (selection: MarketSelection) => void,
  ): void {
    this.onSelectionChange = listener
  }

  setWarningListener(listener?: (message: string) => void): void {
    this.onWarning = listener
  }

  setLiveStatusListener(
    listener?: (status: LiveMarketStatus) => void,
  ): void {
    this.onLiveStatus = listener
    listener?.({ ...this.liveStatus })
  }

  setLiveEnabled(enabled: boolean): void {
    if (this.liveEnabled === enabled) return
    this.liveEnabled = enabled
    for (const subscription of this.liveSubscriptions.values()) {
      if (enabled) {
        this.startLiveSubscription(subscription)
      } else {
        subscription.stop?.()
        subscription.stop = null
      }
    }
    if (!enabled) {
      this.publishLiveStatus({ ...INITIAL_LIVE_STATUS })
    }
  }

  async searchSymbols(search = ''): Promise<SymbolInfo[]> {
    const normalized = search.trim().toUpperCase()
    try {
      const symbols = await this.service.getSymbols()
      return symbols
        .filter(
          (symbol) =>
            symbol.symbol.includes(normalized) ||
            symbol.baseAsset.includes(normalized),
        )
        .map(toSymbolInfo)
    } catch (error) {
      this.onWarning?.(
        error instanceof Error ? error.message : String(error),
      )
      return []
    }
  }

  async getHistoryKLineData(
    symbol: SymbolInfo,
    period: Period,
    from: number,
    to: number,
    notifySelection = true,
  ): Promise<KLineData[]> {
    const timeframe = periodToTimeframe(period)
    if (notifySelection) this.onSelectionChange?.({ symbol, period })
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < 0) return []
    const alignedTo = alignOpenTime(to, timeframe, 'floor')
    const cappedFrom = shiftOpenTime(
      alignedTo,
      timeframe,
      -(MAX_CHART_CANDLES - 1),
    )
    const effectiveFrom = Math.max(0, from, cappedFrom)
    if (effectiveFrom > to) return []
    try {
      const candles = await this.service.loadCandles(
        'trade',
        symbol.ticker,
        timeframe,
        effectiveFrom,
        to,
        { onWarning: this.onWarning },
      )
      return candles.map((candle) => ({
        timestamp: candle.openTime,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number(candle.volume),
        turnover: Number(candle.quoteVolume),
      }))
    } catch (error) {
      this.onWarning?.(
        error instanceof Error ? error.message : String(error),
      )
      return []
    }
  }

  subscribe(
    symbol: SymbolInfo,
    period: Period,
    callback: DatafeedSubscribeCallback,
  ): void {
    const key = this.subscriptionKey(symbol, period)
    this.liveSubscriptions.get(key)?.stop?.()
    const subscription: LiveSubscription = {
      symbol,
      period,
      callback,
      stop: null,
    }
    this.liveSubscriptions.set(key, subscription)
    if (this.liveEnabled) {
      this.startLiveSubscription(subscription)
    }
  }

  unsubscribe(symbol: SymbolInfo, period: Period): void {
    const key = this.subscriptionKey(symbol, period)
    const subscription = this.liveSubscriptions.get(key)
    subscription?.stop?.()
    this.liveSubscriptions.delete(key)
  }

  private startLiveSubscription(subscription: LiveSubscription): void {
    subscription.stop?.()
    subscription.stop = this.liveStream.subscribe({
      symbol: subscription.symbol.ticker,
      timeframe: periodToTimeframe(subscription.period),
      onKline: subscription.callback,
      onStatus: (status) => {
        this.publishLiveStatus(status)
        if (status.warning.length > 0) {
          this.onWarning?.(status.warning)
        }
      },
    })
  }

  private publishLiveStatus(status: LiveMarketStatus): void {
    this.liveStatus = { ...status }
    this.onLiveStatus?.({ ...status })
  }

  private subscriptionKey(symbol: SymbolInfo, period: Period): string {
    return `${symbol.ticker.toUpperCase()}:${period.text}`
  }
}
