import type {
  Datafeed,
  DatafeedSubscribeCallback,
  Period,
  SymbolInfo,
} from '@klinecharts/pro'
import type { KLineData } from 'klinecharts'
import {
  alignOpenTime,
  nextOpenTime,
  previousOpenTime,
  shiftOpenTime,
} from '../market-data/intervals'
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
  visibleUntil?: number
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
  private readonly historyContexts = new Map<string, ReplayContext>()
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
    if (requiresRestart(previous, context)) this.historyContexts.clear()
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
    if (symbol.ticker.toUpperCase() !== context.symbol) {
      this.onWarning?.('回放会话进行中，不能切换交易对。')
      return []
    }
    // A replay step reveals a whole source candle. Other chart periods share
    // that same exclusive time boundary, regardless of their bucket size.
    const visibleUntil = nextOpenTime(context.currentTime, context.timeframe)
    const visibleTo = Math.min(
      to,
      alignOpenTime(visibleUntil - 1, period.text, 'floor'),
    )
    const visibleFrom =
      from > visibleTo
        ? shiftOpenTime(visibleTo, period.text, -498)
        : from
    const candles = await this.loadVisibleCandles(
      context,
      symbol,
      period,
      visibleFrom,
      visibleTo,
    )
    if (requiresRestart(context, this.context)) {
      return this.getHistoryKLineData(symbol, period, from, to)
    }
    if (visibleTo === alignOpenTime(visibleUntil - 1, period.text, 'floor')) {
      this.historyContexts.set(this.selectionKey(symbol, period), context)
    }
    return candles
  }

  subscribe(
    symbol: SymbolInfo,
    period: Period,
    callback: DatafeedSubscribeCallback,
  ): void {
    const history = this.historyContexts.get(this.selectionKey(symbol, period))
    const visibleContext = history ?? this.context
    this.subscription = {
      symbol,
      period,
      callback,
      visibleUntil:
        visibleContext === null
          ? undefined
          : nextOpenTime(visibleContext.currentTime, visibleContext.timeframe),
    }
    if (this.context === null) {
      this.base.subscribe(symbol, period, callback)
    } else if (history !== undefined && history.currentTime < this.context.currentTime) {
      // Playback may advance while the chart is loading its new period.
      void this.emitCurrentCandle(this.context)
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
      subscription.symbol.ticker.toUpperCase() !== context.symbol
    ) {
      return
    }
    try {
      const visibleUntil = nextOpenTime(context.currentTime, context.timeframe)
      const from = alignOpenTime(
        Math.min(subscription.visibleUntil ?? visibleUntil, visibleUntil) - 1,
        subscription.period.text,
        'floor',
      )
      const candles =
        subscription.period.text === context.timeframe
          ? (await this.service.loadCandles(
              'trade',
              context.symbol,
              context.timeframe,
              from,
              context.currentTime,
            ))
              .filter((candle) =>
                candle.openTime >= from && candle.openTime <= context.currentTime,
              )
              .sort((left, right) => left.openTime - right.openTime)
              .map(toKLineData)
          : await this.loadVisibleCandles(
            context,
            subscription.symbol,
            subscription.period,
            from,
            alignOpenTime(visibleUntil - 1, subscription.period.text, 'floor'),
          )
      if (
        this.context?.sessionId !== context.sessionId ||
        this.context.currentTime !== context.currentTime ||
        this.subscription !== subscription
      ) {
        return
      }
      for (const candle of candles) {
        subscription.callback(candle)
      }
      subscription.visibleUntil = visibleUntil
    } catch (error) {
      this.onWarning?.(
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private async loadVisibleCandles(
    context: ReplayContext,
    symbol: SymbolInfo,
    period: Period,
    from: number,
    to: number,
  ): Promise<KLineData[]> {
    const visibleUntil = nextOpenTime(context.currentTime, context.timeframe)
    const lastOpen = alignOpenTime(visibleUntil - 1, period.text, 'floor')
    const partial = nextOpenTime(lastOpen, period.text) > visibleUntil
    const completeTo = Math.min(
      to,
      partial ? previousOpenTime(lastOpen, period.text) : lastOpen,
    )
    const candles =
      from <= completeTo
        ? (await this.base.getHistoryKLineData(symbol, period, from, completeTo))
            .filter((candle) =>
              candle.timestamp >= from &&
              candle.timestamp <= completeTo &&
              nextOpenTime(candle.timestamp, period.text) <= visibleUntil,
            )
        : []
    if (!partial || lastOpen < from || lastOpen > to) return candles

    // Never use the finished higher-period candle: its OHLC and volume would
    // reveal the future. Rebuild only the visible part from completed candles.
    const sourceTimeframe =
      alignOpenTime(lastOpen, context.timeframe, 'floor') === lastOpen
        ? context.timeframe
        : '1m'
    try {
      const source = (await this.service.loadCandles(
        'trade',
        context.symbol,
        sourceTimeframe,
        lastOpen,
        visibleUntil - 1,
      ))
        .filter((candle) =>
          candle.openTime >= lastOpen &&
          nextOpenTime(candle.openTime, sourceTimeframe) <= visibleUntil,
        )
        .sort((left, right) => left.openTime - right.openTime)
      if (source.length > 0) {
        const first = toKLineData(source[0])
        const aggregate = { ...first, timestamp: lastOpen }
        for (const candle of source.slice(1)) {
          aggregate.high = Math.max(aggregate.high, Number(candle.high))
          aggregate.low = Math.min(aggregate.low, Number(candle.low))
          aggregate.close = Number(candle.close)
          aggregate.volume = (aggregate.volume ?? 0) + Number(candle.volume)
          aggregate.turnover =
            (aggregate.turnover ?? 0) + Number(candle.quoteVolume)
        }
        candles.push(aggregate)
      }
    } catch (error) {
      this.onWarning?.(error instanceof Error ? error.message : String(error))
    }
    return candles
  }

  private selectionKey(symbol: SymbolInfo, period: Period): string {
    return `${symbol.ticker.toUpperCase()}:${period.text}`
  }
}
