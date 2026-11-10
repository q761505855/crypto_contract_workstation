import type {
  Datafeed,
  DatafeedSubscribeCallback,
  Period,
  SymbolInfo,
} from '@klinecharts/pro'
import type { KLineData } from 'klinecharts'
import {
  alignOpenTime,
  klineCloseBoundary,
  lastClosedOpenTime,
  nextOpenTime,
  previousOpenTime,
  shiftOpenTime,
  usesNativeKlines,
} from '../market-data/intervals'
import { findMissingRanges } from '../market-data/gaps'
import type { MarketDataService } from '../market-data/market-data-service'
import type { MarketCandle, MarketSelection } from '../market-data/models'
import type { ReplayContext } from './models'
import { readChartHistory } from '../market-data/indicator-history'

const MAX_REPLAY_MINUTES = 100_000
const HISTORY_LIMIT_MESSAGE = '已到回放历史上限（1 年）'

function replayHistoryStart(currentTime: number, timeframe: string): number {
  // Native candles can page back to listing without fetching minute archives.
  if (usesNativeKlines(timeframe)) return 0
  const date = new Date(currentTime)
  const month = date.getUTCMonth()
  date.setUTCFullYear(date.getUTCFullYear() - 1)
  if (date.getUTCMonth() !== month) date.setUTCDate(0) // February 29 maps to February 28.
  return alignOpenTime(Math.max(0, date.getTime()), timeframe, 'ceil')
}

function historyWindowStart(from: number, to: number, timeframe: string, minuteHistory: boolean): number {
  const candleLimit = shiftOpenTime(alignOpenTime(to, timeframe, 'floor'), timeframe, -498)
  if (!minuteHistory) return Math.max(from, candleLimit)
  // Keep each read bounded, including the candle that straddles the month
  // boundary. The next page starts immediately before this page's first bar.
  const month = previousOpenTime(alignOpenTime(to, '1M', 'floor'), '1M')
  return Math.max(from, candleLimit, alignOpenTime(month, timeframe, 'floor'))
}

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
  private onHistoryStatus?: (message: string) => void
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

  setHistoryStatusListener(listener?: (message: string) => void): void {
    this.onHistoryStatus = listener
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
      this.onHistoryStatus?.('')
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
    if (notifySelection) {
      this.onHistoryStatus?.('')
      this.onSelectionChange?.({ symbol, period })
    }
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
    const visibleUntil = klineCloseBoundary(context.currentTime, context.timeframe)
    const visibleTo = Math.min(
      to,
      alignOpenTime(visibleUntil - 1, period.text, 'floor'),
    )
    if (visibleTo < replayHistoryStart(context.currentTime, period.text)) {
      if (notifySelection) this.onHistoryStatus?.(HISTORY_LIMIT_MESSAGE)
      return []
    }
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

  async getOlderHistory(symbol: SymbolInfo, period: Period, before: number, signal?: AbortSignal) {
    const context = this.context
    if (context === null || !this.service.usesMinuteHistory?.()) return null
    const generation = this.replayGeneration
    const retry = { candles: [], hasMore: true }
    if (symbol.ticker.toUpperCase() !== context.symbol) return retry
    signal?.throwIfAborted()
    const onboard = await this.service.getSymbolOnboardDate(context.symbol, signal)
    signal?.throwIfAborted()
    if (!this.isCurrentContext(context, generation)) return retry

    const timeframe = period.text
    const visibleUntil = klineCloseBoundary(context.currentTime, context.timeframe)
    const to = Math.min(
      previousOpenTime(alignOpenTime(before, timeframe, 'floor'), timeframe),
      lastClosedOpenTime(visibleUntil, timeframe),
    )
    const native = usesNativeKlines(timeframe)
    const windowStart = replayHistoryStart(context.currentTime, timeframe)
    const listingStart = onboard === undefined ? 0 : alignOpenTime(onboard, timeframe, native ? 'floor' : 'ceil')
    const firstOpen = Math.max(windowStart, listingStart)
    const endMessage = native || (onboard !== undefined && listingStart >= windowStart)
      ? '已到最早历史数据' : HISTORY_LIMIT_MESSAGE
    if (to < firstOpen) {
      this.onHistoryStatus?.(endMessage)
      return { candles: [], hasMore: false }
    }
    const from = historyWindowStart(firstOpen, to, timeframe, !native)
    const rows = await this.loadVisibleCandles(context, symbol, period, from, to, true, signal, true)
    signal?.throwIfAborted()
    if (!this.isCurrentContext(context, generation)) return retry

    // Keep the cursor at a gap so the next drag can retry that interval,
    // even if some older candles in this page were already cached.
    let cursor = to
    let index = rows.length
    while (index > 0 && rows[index - 1].timestamp === cursor) {
      index -= 1
      cursor = previousOpenTime(cursor, timeframe)
    }
    const candles = rows.slice(index)
    const hasMore = cursor >= firstOpen
    this.onHistoryStatus?.(!hasMore ? endMessage
      : cursor >= from ? '更早历史暂未加载，拖动图表可重试。' : '')
    return { candles, hasMore }
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
          : klineCloseBoundary(visibleContext.currentTime, visibleContext.timeframe),
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
      const visibleUntil = klineCloseBoundary(context.currentTime, context.timeframe)
      const from = alignOpenTime(
        Math.min(subscription.visibleUntil ?? visibleUntil, visibleUntil) - 1,
        subscription.period.text,
        'floor',
      )
      const candles =
        subscription.period.text === context.timeframe &&
          alignOpenTime(context.currentTime, context.timeframe, 'floor') === context.currentTime
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
    historyPage = false,
  ): Promise<KLineData[]> {
    signal?.throwIfAborted()
    const generation = this.replayGeneration
    if (!this.isCurrentContext(context, generation)) return []
    const visibleUntil = klineCloseBoundary(context.currentTime, context.timeframe)
    const lastOpen = alignOpenTime(visibleUntil - 1, period.text, 'floor')
    to = Math.min(to, lastOpen)
    const minuteHistory = this.service.usesMinuteHistory?.() ?? false
    const native = minuteHistory && usesNativeKlines(period.text)
    from = historyWindowStart(Math.max(from, replayHistoryStart(context.currentTime, period.text)), to, period.text, minuteHistory && !native)
    if (from > to) return []
    const lastComplete = lastClosedOpenTime(visibleUntil, period.text)
    const completeTo = Math.min(to, lastComplete)
    // The cache service expands a higher-period open to the end of its bucket.
    // Never ask it for an unfinished bucket; build that bucket from visible source bars.
    const cached = (from > completeTo || (minuteHistory && !native && period.text !== '1m')
      ? [] : await this.loadLocalCandles(context, period.text, from, completeTo, signal))
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
    const needsPartial = lastOpen <= to && klineCloseBoundary(lastOpen, period.text) > visibleUntil
    const aggregateComplete = !native && completeGaps.length > 0
    if (sourceTimeframe !== period.text && (aggregateComplete || needsPartial)) {
      const sourceFrom = aggregateComplete ? completeGaps[0].from : lastOpen
      const sourceTo = Math.min(klineCloseBoundary(alignOpenTime(to, period.text, 'floor'), period.text), visibleUntil) - 1
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
        const end = Math.min(klineCloseBoundary(open, period.text), visibleUntil) - 1
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
        : klineCloseBoundary(context.endTime, context.timeframe) - 1
      const options = { prefetchTo, ...(signal ? { signal } : {}), onWarning: (message: string) => {
        if (!signal?.aborted && this.isCurrentContext(context, generation)) this.onWarning?.(message)
      } }
      // An older-page gesture may retry a failed archive read. Playback keeps
      // using the shared failure cache so stepping never retries it per candle.
      const load = historyPage ? this.service.loadCandles.bind(this.service)
        : this.service.loadReplayCandles.bind(this.service)
      signal?.throwIfAborted()
      try {
        if (missingComplete.length > 0) {
          await load('trade', context.symbol, period.text, missingComplete[0].from, missingComplete.at(-1)!.to, options)
          signal?.throwIfAborted()
          if (!this.isCurrentContext(context, generation)) return []
        }
        if (missingPartial) {
          await load('trade', context.symbol, sourceTimeframe, lastOpen, visibleUntil - 1, options)
        }
      } catch (error) {
        if (!historyPage) throw error
        options.onWarning(error instanceof Error ? error.message : String(error))
      }
      signal?.throwIfAborted()
      if (!this.isCurrentContext(context, generation)) return []
      return this.loadVisibleCandles(context, symbol, period, from, to, false, signal, historyPage)
    }
    signal?.throwIfAborted()
    if (!historyPage && (visible.size === 0 || missingPartial)) this.warnMissingPeriod(period)
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
    const visibleUntil = klineCloseBoundary(context.currentTime, context.timeframe)
    to = Math.min(to, visibleUntil - 1)
    if (from > to) return []
    const isVisible = (candle: MarketCandle) => candle.symbol === context.symbol && candle.timeframe === timeframe &&
      candle.openTime >= from && candle.openTime <= to && candle.isClosed &&
      candle.closeTime < visibleUntil && klineCloseBoundary(candle.openTime, timeframe) <= visibleUntil
    const session = this.sessionData?.id === context.sessionId && timeframe === context.timeframe &&
      alignOpenTime(context.currentTime, timeframe, 'floor') === context.currentTime
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
