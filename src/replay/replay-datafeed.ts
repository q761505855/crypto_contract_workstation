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
  shiftOpenTime,
} from '../market-data/intervals'
import { findMissingRanges } from '../market-data/gaps'
import type { MarketDataService } from '../market-data/market-data-service'
import type { MarketCandle, MarketSelection } from '../market-data/models'
import type { ReplayContext } from './models'
import { readChartHistory } from '../market-data/indicator-history'

const MAX_REPLAY_MINUTES = 100_000

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
  private sessionData: { id: string; candles: readonly MarketCandle[] } | null = null
  private onSelectionChange?: (selection: MarketSelection) => void
  private onWarning?: (message: string) => void
  private replayGeneration = 0
  private minutePool = new Map<number, MarketCandle>()

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

  setSessionCandles(id: string | null, candles: readonly MarketCandle[] = []): void {
    this.sessionData = id === null ? null : { id, candles }
  }

  setReplayContext(context: ReplayContext | null): void {
    const previous = this.context
    if (requiresRestart(previous, context)) {
      this.historyContexts.clear()
      this.replayGeneration += 1
      this.minutePool.clear()
    }
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
    notifySelection = true,
    signal?: AbortSignal,
  ): Promise<KLineData[]> {
    signal?.throwIfAborted()
    if (this.context !== null && symbol.ticker.toUpperCase() !== this.context.symbol) {
      this.onWarning?.('回放会话进行中，不能切换交易对。')
      return []
    }
    if (notifySelection) this.onSelectionChange?.({ symbol, period })
    const context = this.context
    const generation = this.replayGeneration
    if (context === null) {
      let candles: KLineData[]
      try {
        candles = await readChartHistory(this.base, symbol, period, from, to, notifySelection, signal)
        signal?.throwIfAborted()
      } catch (error) {
        signal?.throwIfAborted()
        if (generation !== this.replayGeneration || requiresRestart(context, this.context)) {
          return this.getHistoryKLineData(symbol, period, from, to, false, signal)
        }
        throw error
      }
      if (generation !== this.replayGeneration || requiresRestart(context, this.context)) {
        return this.getHistoryKLineData(symbol, period, from, to, false, signal)
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
    let candles: KLineData[]
    try {
      candles = await this.loadVisibleCandles(context, symbol, period, visibleFrom, visibleTo, true, signal)
      signal?.throwIfAborted()
    } catch (error) {
      signal?.throwIfAborted()
      if (generation !== this.replayGeneration || requiresRestart(context, this.context)) {
        return this.getHistoryKLineData(symbol, period, from, to, false, signal)
      }
      throw error
    }
    if (generation !== this.replayGeneration || requiresRestart(context, this.context)) {
      // Retrying old work must not select its period over the user's newer one.
      return this.getHistoryKLineData(symbol, period, from, to, false, signal)
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
    const generation = this.replayGeneration
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
          ? (await this.loadLocalCandles(
              context,
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
        !this.isCurrentContext(context, generation) ||
        this.context?.sessionId !== context.sessionId ||
        this.context.currentTime !== context.currentTime ||
        this.subscription !== subscription
      ) {
        return
      }
      for (const candle of candles) {
        if (!this.isCurrentContext(context, generation) || this.subscription !== subscription) return
        subscription.callback(candle)
      }
      if (this.isCurrentContext(context, generation) && this.subscription === subscription) {
        subscription.visibleUntil = visibleUntil
      }
    } catch (error) {
      if (this.isCurrentContext(context, generation) && this.subscription === subscription) {
        this.onWarning?.(error instanceof Error ? error.message : String(error))
      }
    }
  }

  private async loadVisibleCandles(
    context: ReplayContext,
    symbol: SymbolInfo,
    period: Period,
    from: number,
    to: number,
    allowFill = true,
    signal?: AbortSignal,
  ): Promise<KLineData[]> {
    signal?.throwIfAborted()
    const generation = this.replayGeneration
    if (!this.isCurrentContext(context, generation)) return []
    const visibleUntil = nextOpenTime(context.currentTime, context.timeframe)
    const lastOpen = alignOpenTime(visibleUntil - 1, period.text, 'floor')
    to = Math.min(to, lastOpen)
    from = Math.max(from, shiftOpenTime(alignOpenTime(to, period.text, 'floor'), period.text, -498))
    const minuteHistory = this.service.usesMinuteHistory?.() ?? false
    if (minuteHistory) {
      // Library period switches can ask for hundreds of weeks. Prepare chart
      // history in calendar chunks; session buffering has its own month limit.
      from = Math.max(from, shiftOpenTime(alignOpenTime(to, '1M', 'floor'), '1M', -1))
    }
    if (from > to) return []
    const lastComplete = nextOpenTime(lastOpen, period.text) <= visibleUntil
      ? lastOpen
      : shiftOpenTime(lastOpen, period.text, -1)
    const completeTo = Math.min(to, lastComplete)
    // The cache service expands a higher-period open to the end of its bucket.
    // Never ask it for an unfinished bucket; build that bucket from visible source bars.
    const cached = (from > completeTo || (minuteHistory && period.text !== '1m')
      ? [] : await this.loadLocalCandles(context, period.text, from, completeTo, signal))
      .filter((candle) => nextOpenTime(candle.openTime, period.text) <= visibleUntil)
    signal?.throwIfAborted()
    if (!this.isCurrentContext(context, generation)) return []
    const visible = new Map(cached.map((candle) => [candle.openTime, toKLineData(candle)]))

    // Larger periods can be built locally from the source period. Smaller or
    // incompatible buckets require minute candles. Use local data first, then
    // fill missing ranges through the shared batch loader without inventing
    // intrabar movement or retrying the same failed range on every step.
    const sourceTimeframe =
      !minuteHistory && alignOpenTime(lastOpen, context.timeframe, 'floor') === lastOpen &&
      alignOpenTime(nextOpenTime(lastOpen, period.text), context.timeframe, 'floor') === nextOpenTime(lastOpen, period.text) &&
      nextOpenTime(lastOpen, context.timeframe) <= nextOpenTime(lastOpen, period.text)
        ? context.timeframe
        : '1m'
    const completeGaps = findMissingRanges(cached, period.text, from, Math.min(to, lastComplete))
    const needsPartial = lastOpen <= to && nextOpenTime(lastOpen, period.text) > visibleUntil
    if (sourceTimeframe !== period.text && (completeGaps.length > 0 || needsPartial)) {
      const sourceFrom = completeGaps.length > 0 ? completeGaps[0].from : lastOpen
      const sourceTo = Math.min(nextOpenTime(alignOpenTime(to, period.text, 'floor'), period.text), visibleUntil) - 1
      const source = (await this.loadLocalCandles(context, sourceTimeframe, sourceFrom, sourceTo, signal))
        .filter((candle) => nextOpenTime(candle.openTime, sourceTimeframe) <= visibleUntil)
      signal?.throwIfAborted()
      if (!this.isCurrentContext(context, generation)) return []
      const groups = new Map<number, MarketCandle[]>()
      for (const candle of source) {
        const open = alignOpenTime(candle.openTime, period.text, 'floor')
        if (open < from || open > to || visible.has(open)) continue
        const group = groups.get(open) ?? []
        group.push(candle)
        groups.set(open, group)
      }
      for (const [open, group] of groups) {
        const end = Math.min(nextOpenTime(open, period.text), visibleUntil) - 1
        if (findMissingRanges(group, sourceTimeframe, open, end).length > 0) continue
        const aggregate = { ...toKLineData(group[0]), timestamp: open }
        for (const candle of group.slice(1)) {
          aggregate.high = Math.max(aggregate.high, Number(candle.high))
          aggregate.low = Math.min(aggregate.low, Number(candle.low))
          aggregate.close = Number(candle.close)
          aggregate.volume = (aggregate.volume ?? 0) + Number(candle.volume)
          aggregate.turnover = (aggregate.turnover ?? 0) + Number(candle.quoteVolume)
        }
        visible.set(open, aggregate)
      }
    }
    const result = [...visible.values()].sort((left, right) => left.timestamp - right.timestamp)
    const missingComplete = findMissingRanges(
      result.map((candle) => ({ openTime: candle.timestamp }) as MarketCandle),
      period.text, Math.max(0, from), Math.min(to, lastComplete),
    )
    const missingPartial = needsPartial && !visible.has(lastOpen)
    if (allowFill && (missingComplete.length > 0 || missingPartial)) {
      const prefetchTo = context.endTime === undefined ? undefined
        : nextOpenTime(context.endTime, context.timeframe) - 1
      const options = { prefetchTo, ...(signal ? { signal } : {}), onWarning: (message: string) => {
        if (!signal?.aborted && this.isCurrentContext(context, generation)) this.onWarning?.(message)
      } }
      signal?.throwIfAborted()
      if (missingComplete.length > 0) {
        await this.service.loadReplayCandles(
          'trade', context.symbol, period.text,
          missingComplete[0].from, missingComplete.at(-1)!.to, options,
        )
        signal?.throwIfAborted()
        if (!this.isCurrentContext(context, generation)) return []
      }
      if (missingPartial) {
        await this.service.loadReplayCandles(
          'trade', context.symbol, sourceTimeframe,
          lastOpen, visibleUntil - 1, options,
        )
        signal?.throwIfAborted()
        if (!this.isCurrentContext(context, generation)) return []
      }
      return this.loadVisibleCandles(context, symbol, period, from, to, false, signal)
    }
    signal?.throwIfAborted()
    if (visible.size === 0 || missingPartial) this.warnMissingPeriod(period)
    return result
  }

  private async loadLocalCandles(
    context: ReplayContext,
    timeframe: string,
    from: number,
    to: number,
    signal?: AbortSignal,
  ): Promise<MarketCandle[]> {
    signal?.throwIfAborted()
    const visibleUntil = nextOpenTime(context.currentTime, context.timeframe)
    to = Math.min(to, visibleUntil - 1)
    if (from > to) return []
    const isVisible = (candle: MarketCandle) => candle.symbol === context.symbol && candle.timeframe === timeframe &&
      candle.openTime >= from && candle.openTime <= to && candle.isClosed && nextOpenTime(candle.openTime, timeframe) <= visibleUntil
    const session = this.sessionData?.id === context.sessionId && timeframe === context.timeframe
      ? this.sessionData.candles
      : []
    if (timeframe === '1m' && this.service.usesMinuteHistory?.()) {
      const generation = this.replayGeneration
      if (!this.isCurrentContext(context, generation)) return []
      const local = new Map([...this.minutePool.values()].filter(isVisible).map((row) => [row.openTime, row]))
      for (const row of session) if (isVisible(row)) local.set(row.openTime, row)
      const missing = findMissingRanges([...local.values()], '1m', from, to)
      for (const gap of missing) {
        signal?.throwIfAborted()
        const rows = await this.service.loadCachedCandles('trade', context.symbol, '1m', gap.from, gap.to)
        signal?.throwIfAborted()
        if (!this.isCurrentContext(context, generation)) return []
        for (const row of rows) if (isVisible(row)) local.set(row.openTime, row)
      }
      signal?.throwIfAborted()
      if (!this.isCurrentContext(context, generation)) return []
      const result = [...local.values()].sort((left, right) => left.openTime - right.openTime)
      // Commit only a fully successful, still-visible read. Navigation aborts
      // and replay restarts cannot seed a later request with retired results.
      for (const row of result) this.minutePool.set(row.openTime, row)
      if (this.minutePool.size > MAX_REPLAY_MINUTES) {
        this.minutePool = new Map(result.slice(-MAX_REPLAY_MINUTES).map((row) => [row.openTime, row]))
      }
      return result
    }
    if (session.length > 0 && from >= session[0].openTime && to < nextOpenTime(session.at(-1)!.openTime, timeframe)) {
      return session.filter(isVisible)
    }
    const cached = await this.service.loadCachedCandles('trade', context.symbol, timeframe, from, to)
    signal?.throwIfAborted()
    const local = new Map(cached.filter(isVisible)
      .map((candle) => [candle.openTime, candle]))
    for (const candle of session) {
      if (isVisible(candle)) local.set(candle.openTime, candle)
    }
    return [...local.values()].sort((left, right) => left.openTime - right.openTime)
  }

  private warnMissingPeriod(period: Period): void {
    this.onWarning?.(`本地 ${period.text} 数据仍不完整，批量补缺暂未完成；不会逐根重复请求，受保护限制时请在数据管理中恢复或手动重试。`)
  }

  private selectionKey(symbol: SymbolInfo, period: Period): string {
    return `${symbol.ticker.toUpperCase()}:${period.text}`
  }

  private isCurrentContext(context: ReplayContext, generation: number): boolean {
    return generation === this.replayGeneration && this.context !== null &&
      this.context.sessionId === context.sessionId && this.context.symbol === context.symbol &&
      this.context.timeframe === context.timeframe && this.context.currentTime >= context.currentTime
  }
}
