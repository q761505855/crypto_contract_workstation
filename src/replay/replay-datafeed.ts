import type {
  Datafeed,
  DatafeedSubscribeCallback,
  Period,
  SymbolInfo,
} from '@klinecharts/pro'
import type { KLineData } from 'klinecharts'
import { shiftOpenTime } from '../market-data/intervals'
import type { MarketDataService } from '../market-data/market-data-service'
import type { MarketCandle, MarketSelection } from '../market-data/models'
import type { ReplayContext } from './models'

function toKLineData(candle: MarketCandle): KLineData {
  return {
    timestamp: candle.openTime,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume),
    turnover: Number(candle.quoteVolume),
  }
}

interface Subscription {
  symbol: SymbolInfo
  period: Period
  callback: DatafeedSubscribeCallback
}

function requiresRestart(
  before: ReplayContext | null,
  after: ReplayContext | null,
): boolean {
  if (before === null || after === null) return before !== after
  return (
    before.sessionId !== after.sessionId ||
    before.symbol !== after.symbol ||
    before.timeframe !== after.timeframe ||
    after.currentTime < before.currentTime
  )
}

export class ReplayDatafeed implements Datafeed {
  private context: ReplayContext | null = null
  private subscription: Subscription | null = null
  private onSelectionChange?: (selection: MarketSelection) => void
  private onWarning?: (message: string) => void

  constructor(
    private readonly base: Datafeed,
    private readonly service: MarketDataService,
  ) {
    const warningAware = base as Datafeed & {
      setWarningListener?: (listener?: (message: string) => void) => void
    }
    warningAware.setWarningListener?.((message) => this.onWarning?.(message))
  }

  setSelectionListener(
    listener?: (selection: MarketSelection) => void,
  ): void {
    this.onSelectionChange = listener
  }

  setWarningListener(listener?: (message: string) => void): void {
    this.onWarning = listener
  }

  getReplayContext(): ReplayContext | null {
    return this.context === null ? null : { ...this.context }
  }

  setReplayContext(context: ReplayContext | null): void {
    const previous = this.context
    this.context = context === null ? null : { ...context }
    const subscription = this.subscription
    if (subscription !== null) {
      if (previous === null && context !== null) {
        this.base.unsubscribe(subscription.symbol, subscription.period)
      } else if (previous !== null && context === null) {
        this.base.subscribe(
          subscription.symbol,
          subscription.period,
          subscription.callback,
        )
      }
    }
    if (
      context !== null &&
      (previous === null ||
        previous.sessionId !== context.sessionId ||
        context.currentTime > previous.currentTime)
    ) {
      void this.emitCurrentCandle(context)
    }
  }

  async searchSymbols(search = ''): Promise<SymbolInfo[]> {
    return this.base.searchSymbols(search)
  }

  async getHistoryKLineData(
    symbol: SymbolInfo,
    period: Period,
    from: number,
    to: number,
  ): Promise<KLineData[]> {
    this.onSelectionChange?.({ symbol, period })
    const context = this.context
    if (context === null) {
      const candles = await this.base.getHistoryKLineData(
        symbol,
        period,
        from,
        to,
      )
      if (requiresRestart(context, this.context)) {
        return this.getHistoryKLineData(symbol, period, from, to)
      }
      return candles
    }
    if (
      symbol.ticker.toUpperCase() !== context.symbol ||
      period.text !== context.timeframe
    ) {
      this.onWarning?.('回放会话进行中，不能切换交易对或周期。')
      return []
    }
    const visibleTo = Math.min(to, context.currentTime)
    const visibleFrom =
      from > visibleTo
        ? shiftOpenTime(visibleTo, context.timeframe, -499)
        : from
    const candles = await this.base.getHistoryKLineData(
      symbol,
      period,
      visibleFrom,
      visibleTo,
    )
    if (requiresRestart(context, this.context)) {
      return this.getHistoryKLineData(symbol, period, from, to)
    }
    return candles.filter((candle) => candle.timestamp <= context.currentTime)
  }

  subscribe(
    symbol: SymbolInfo,
    period: Period,
    callback: DatafeedSubscribeCallback,
  ): void {
    this.subscription = { symbol, period, callback }
    if (this.context === null) {
      this.base.subscribe(symbol, period, callback)
    }
  }

  unsubscribe(symbol: SymbolInfo, period: Period): void {
    if (
      this.subscription?.symbol.ticker === symbol.ticker &&
      this.subscription.period.text === period.text
    ) {
      if (this.context === null) {
        this.base.unsubscribe(symbol, period)
      }
      this.subscription = null
    }
  }

  private async emitCurrentCandle(context: ReplayContext): Promise<void> {
    const subscription = this.subscription
    if (
      subscription === null ||
      subscription.symbol.ticker.toUpperCase() !== context.symbol ||
      subscription.period.text !== context.timeframe
    ) {
      return
    }
    try {
      const candles = await this.service.loadCandles(
        'trade',
        context.symbol,
        context.timeframe,
        context.currentTime,
        context.currentTime,
      )
      if (
        this.context?.sessionId !== context.sessionId ||
        this.context.currentTime !== context.currentTime
      ) {
        return
      }
      const candle = candles.find(
        (item) => item.openTime === context.currentTime,
      )
      if (candle !== undefined) {
        subscription.callback(toKLineData(candle))
      }
    } catch (error) {
      this.onWarning?.(
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}
