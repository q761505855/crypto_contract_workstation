import type { Datafeed, DatafeedSubscribeCallback, Period, SymbolInfo } from '@klinecharts/pro'
import type { KLineData } from 'klinecharts'
import { toChartCandle } from '../market-data/chart-candle'
import { readChartHistory } from '../market-data/indicator-history'
import { alignOpenTime, nextOpenTime, shiftOpenTime } from '../market-data/intervals'
import type { MarketCandle, MarketSelection } from '../market-data/models'
import { loadClosedReplayBars, type CTraderReplayMarket } from './ctrader-replay-bars'
import { CTraderReplayTicks } from './ctrader-replay-ticks'
import { compareReplayPositions, replayConfirmedUntil, replayVisibleUntil, type ReplayContext } from './models'

const PAGE_SIZE = 500
const MAX_EMPTY_PAGES = 8
const FORWARD_PAGE_SIZE = 256
const DAY = 86_400_000
const FORWARD_MAX_SPAN_MS = 365 * DAY
const HISTORY_ERROR_RETRY_MS = 3_000

interface ReplayTail {
  position: ReplayContext
  nextClose?: number
}

interface Subscription extends Partial<ReplayTail> {
  symbol: SymbolInfo
  period: Period
  callback: DatafeedSubscribeCallback
  request?: AbortController
  buffered?: { to: number; bars: MarketCandle[] }
  retryAfter?: number
}

type LoadHistoryPage = (symbol: SymbolInfo, period: Period, edge: number, signal?: AbortSignal) =>
  Promise<{ candles: KLineData[]; hasMore: boolean } | null>

type BaseDatafeed = Datafeed & {
  hasLiveTail?: (symbol: SymbolInfo, period: Period) => boolean
  setWarningListener?: (listener?: (message: string) => void) => void
  getOlderHistory?: LoadHistoryPage
  getNewerHistory?: LoadHistoryPage
}

function timelineChanged(before: ReplayContext | null, after: ReplayContext | null): boolean {
  if (before === null || after === null) return before !== after
  return before.sessionId !== after.sessionId || before.symbol !== after.symbol ||
    compareReplayPositions(before, after) > 0
}

export function ctraderReplayChartNeedsReload(before: ReplayContext, after: ReplayContext, timeframe: string): boolean {
  return replayVisibleUntil(before) < shiftOpenTime(replayVisibleUntil(after), timeframe, -PAGE_SIZE)
}

function nextNativeClose(bars: readonly MarketCandle[], until: number): number | undefined {
  const next = bars.find(bar => bar.closeTime >= until)
  if (next !== undefined) return next.closeTime + 1
}

export class CTraderReplayDatafeed implements Datafeed {
  private context: ReplayContext | null = null
  private readonly cursorListeners = new Set<(context: ReplayContext | null) => void>()
  private subscription: Subscription | null = null
  private generation = 0
  private readonly tails = new Map<string, ReplayTail>()
  private readonly olderCursors = new Map<string, number>()
  private onSelectionChange?: (selection: MarketSelection) => void
  private onWarning?: (message: string) => void
  private onHistoryStatus?: (message: string) => void

  constructor(
    private readonly base: BaseDatafeed,
    private readonly service: CTraderReplayMarket,
    private readonly ticks = new CTraderReplayTicks(service),
  ) {
    base.setWarningListener?.(message => this.onWarning?.(message))
  }

  createChartView(base: Datafeed): CTraderReplayDatafeed {
    return new CTraderReplayDatafeed(base, this.service, this.ticks)
  }

  dispose(): void {
    const subscription = this.subscription
    if (subscription !== null) this.unsubscribe(subscription.symbol, subscription.period)
    this.invalidateHistory()
  }

  setSelectionListener(listener?: (selection: MarketSelection) => void): void {
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

  subscribeReplayCursor(listener: (context: ReplayContext | null) => void): () => void {
    this.cursorListeners.add(listener)
    return () => { this.cursorListeners.delete(listener) }
  }

  hasLiveTail(symbol: SymbolInfo, period: Period): boolean {
    return this.context === null && (this.base.hasLiveTail?.(symbol, period) ?? false)
  }

  setReplayContext(context: ReplayContext | null, reloadChart = false): void {
    const before = this.context
    const restart = timelineChanged(before, context)
    if (restart || reloadChart) this.invalidateHistory()
    this.context = context === null ? null : { ...context }
    for (const listener of this.cursorListeners) listener(this.context)
    const subscription = this.subscription
    if (subscription === null) return
    if (before === null && context !== null) {
      this.base.unsubscribe(subscription.symbol, subscription.period)
    } else if (before !== null && context === null) {
      this.base.subscribe(subscription.symbol, subscription.period, subscription.callback)
    }
    if (context === null) return
    if (restart || reloadChart) {
      subscription.position = context
      subscription.nextClose = undefined
    } else {
      void this.emitBars(subscription)
    }
  }

  searchSymbols(search = ''): Promise<SymbolInfo[]> {
    return this.base.searchSymbols(search)
  }

  async getHistoryKLineData(
    symbol: SymbolInfo, period: Period, from: number, to: number,
    notifySelection = true, signal?: AbortSignal,
  ): Promise<KLineData[]> {
    signal?.throwIfAborted()
    const context = this.context
    if (context !== null && symbol.ticker.toUpperCase() !== context.symbol) {
      this.onWarning?.('回放会话进行中，不能切换品种。')
      return []
    }
    if (notifySelection) this.onSelectionChange?.({ symbol, period })
    const generation = this.generation
    if (context === null) {
      const rows = await readChartHistory(this.base, symbol, period, from, to, notifySelection, signal)
      signal?.throwIfAborted()
      return generation === this.generation ? rows : this.getHistoryKLineData(symbol, period, from, to, false, signal)
    }
    const until = replayVisibleUntil(context)
    const nativeUntil = replayConfirmedUntil(context)
    const upper = Math.min(to, until - 1)
    const recent = Math.max(0, shiftOpenTime(upper + 1, period.text, -PAGE_SIZE))
    const lower = from < 0 || from > upper ? recent : Math.max(from, notifySelection ? recent : 0)
    let bars = await loadClosedReplayBars(this.service, context.symbol, period.text, lower, upper, signal)
    let visible = bars.filter(bar => bar.closeTime < nativeUntil)
    if (notifySelection && upper === until - 1 && visible.length === 0 && lower > 0) {
      const older = await this.olderPage(context, period, lower, signal)
      visible = older.bars
      bars = [...visible, ...bars]
      this.onHistoryStatus?.(older.hasMore && visible.length === 0 ? '区间内没有已收盘 K 线' : '')
    }
    const forming = await this.readFormingBar(context, period.text, lower, upper, signal)
    if (generation !== this.generation) {
      return this.getHistoryKLineData(symbol, period, from, to, false, signal)
    }
    const latest = this.context
    if (upper === until - 1 && latest !== null && to >= replayVisibleUntil(latest) - 1 &&
      compareReplayPositions(latest, context) > 0) {
      // A history replacement must not roll the chart back over newer subscription updates.
      return this.getHistoryKLineData(symbol, period, lower, to, false, signal)
    }
    if (upper === until - 1 || forming !== undefined) {
      this.tails.set(this.key(symbol, period), { position: context, nextClose: nextNativeClose(bars, nativeUntil) })
    }
    const candles = visible.map(toChartCandle)
    if (forming !== undefined && forming.timestamp > (candles.at(-1)?.timestamp ?? -1)) candles.push(forming)
    return candles
  }

  async getOlderHistory(symbol: SymbolInfo, period: Period, before: number, signal?: AbortSignal) {
    const context = this.context
    const generation = this.generation
    if (context === null) {
      const page = await this.base.getOlderHistory?.(symbol, period, before, signal)
      return generation === this.generation ? page ?? null : { candles: [], hasMore: true }
    }
    if (symbol.ticker.toUpperCase() !== context.symbol) return { candles: [], hasMore: true }
    const key = `${this.key(symbol, period)}:${before}`
    const { bars, hasMore, cursor } = await this.olderPage(context, period, this.olderCursors.get(key) ?? before, signal)
    if (generation !== this.generation) return { candles: [], hasMore: true }
    this.olderCursors.clear()
    if (bars.length === 0 && hasMore) this.olderCursors.set(key, cursor)
    this.onHistoryStatus?.(!hasMore ? '已到最早历史数据' : bars.length === 0 ? '此区间休市或无报价，继续向左查看' : '')
    return { candles: bars.map(toChartCandle), hasMore }
  }

  async getNewerHistory(symbol: SymbolInfo, period: Period, after: number, signal?: AbortSignal) {
    if (this.context !== null || !this.base.getNewerHistory) return null
    const generation = this.generation
    const page = await this.base.getNewerHistory(symbol, period, after, signal)
    return generation === this.generation ? page : null
  }

  subscribe(symbol: SymbolInfo, period: Period, callback: DatafeedSubscribeCallback): void {
    if (this.subscription !== null) this.unsubscribe(this.subscription.symbol, this.subscription.period)
    const context = this.context
    const tail = this.tails.get(this.key(symbol, period))
    const subscription: Subscription = { symbol, period, callback, ...tail }
    this.subscription = subscription
    if (context === null) this.base.subscribe(symbol, period, callback)
    else {
      subscription.position ??= context
      void this.emitBars(subscription)
    }
  }

  unsubscribe(symbol: SymbolInfo, period: Period): void {
    const subscription = this.subscription
    if (subscription === null || this.key(symbol, period) !== this.key(subscription.symbol, subscription.period)) return
    this.subscription = null
    subscription.request?.abort()
    if (this.context === null) this.base.unsubscribe(symbol, period)
  }

  private invalidateHistory(): void {
    this.generation += 1
    this.tails.clear()
    this.olderCursors.clear()
    this.subscription?.request?.abort()
    if (this.subscription !== null) {
      this.subscription.request = undefined
      this.subscription.buffered = undefined
      this.subscription.retryAfter = undefined
    }
    this.onHistoryStatus?.('')
  }

  private async olderPage(context: ReplayContext, period: Period, before: number, signal?: AbortSignal) {
    const until = replayConfirmedUntil(context)
    let cursor = Math.min(before, until)
    for (let page = 0; page < MAX_EMPTY_PAGES && cursor > 0; page += 1) {
      const from = Math.max(0, shiftOpenTime(cursor - 1, period.text, -PAGE_SIZE))
      const bars = (await loadClosedReplayBars(this.service, context.symbol, period.text, from, cursor - 1, signal))
        .filter(bar => bar.closeTime < until)
      if (bars.length !== 0) return { bars, hasMore: from > 0, cursor: from }
      cursor = from
    }
    return { bars: [], hasMore: cursor > 0, cursor }
  }

  private async readFormingBar(
    context: ReplayContext, timeframe: string, from: number, to: number, signal?: AbortSignal,
  ): Promise<KLineData | undefined> {
    const until = replayVisibleUntil(context)
    const nativeUntil = replayConfirmedUntil(context)
    const open = alignOpenTime(until - 1, timeframe, 'floor')
    const end = nextOpenTime(open, timeframe)
    if (open < from || open > to || end <= nativeUntil) return undefined

    const generation = this.generation
    try {
      // Use complete hours within long buckets to keep the minute reads bounded.
      const minuteEnd = alignOpenTime(nativeUntil, '1m', 'floor')
      const hourEnd = end - open >= DAY ? alignOpenTime(minuteEnd, '1h', 'floor') : open
      const hours = await loadClosedReplayBars(this.service, context.symbol, '1h', open, hourEnd - 1, signal)
      const minutes = await loadClosedReplayBars(this.service, context.symbol, '1m', hourEnd, minuteEnd - 1, signal)
      const bars = [...hours.filter(bar => bar.closeTime < hourEnd), ...minutes]
      if (minuteEnd < until) {
        const quoted = await this.ticks.readFormingMinute(context.symbol, minuteEnd, until - 1, signal, context.cursorTickIndex)
        if (quoted !== undefined) bars.push(quoted)
      }
      const first = bars[0]
      if (first === undefined) return undefined
      const forming = { ...toChartCandle(first), timestamp: open, ctraderClosed: false }
      for (const bar of bars.slice(1)) {
        forming.high = Math.max(forming.high, Number(bar.high))
        forming.low = Math.min(forming.low, Number(bar.low))
        forming.close = Number(bar.close)
        forming.volume = (forming.volume ?? 0) + (bar.tickVolume ?? 0)
      }
      return forming
    } catch (reason) {
      signal?.throwIfAborted()
      if (generation === this.generation) {
        this.onWarning?.(`回放中的 K 线暂时无法更新：${reason instanceof Error ? reason.message : String(reason)}`)
      }
    }
  }

  private async emitBars(subscription: Subscription): Promise<void> {
    const context = this.context
    const previous = subscription.position
    if (context === null || previous === undefined || subscription.request !== undefined ||
      subscription.symbol.ticker.toUpperCase() !== context.symbol || compareReplayPositions(context, previous) <= 0 ||
      (subscription.retryAfter ?? 0) > Date.now()) return
    const since = replayConfirmedUntil(previous)
    const until = replayConfirmedUntil(context)
    const timeframe = subscription.period.text
    const request = new AbortController()
    subscription.request = request
    try {
      let closed: MarketCandle[] = []
      let nextClose = subscription.nextClose
      if (since < until && (nextClose === undefined || nextClose <= until)) {
        let page = subscription.buffered
        if (page === undefined || page.to < until - 1) {
          const from = Math.max(0, shiftOpenTime(since, timeframe, -1))
          const pageEnd = Math.min(shiftOpenTime(from, timeframe, FORWARD_PAGE_SIZE) - 1, from + FORWARD_MAX_SPAN_MS - 1)
          const to = Math.min(context.endTime ?? Date.now(), Math.max(until - 1, pageEnd))
          const bars = await loadClosedReplayBars(this.service, context.symbol, timeframe, from, to, request.signal)
          if (request.signal.aborted || this.subscription !== subscription) return
          page = { to, bars }
          subscription.buffered = page
        }
        // Bars ahead of the replay clock stay private to this buffer.
        closed = page.bars.filter(bar => bar.closeTime >= since && bar.closeTime < until)
        nextClose = nextNativeClose(page.bars, until)
      }
      const forming = await this.readFormingBar(context, timeframe, 0, replayVisibleUntil(context) - 1, request.signal)
      for (const bar of closed) {
        if (request.signal.aborted || this.subscription !== subscription) return
        subscription.callback(toChartCandle(bar))
      }
      if (request.signal.aborted || this.subscription !== subscription) return
      subscription.nextClose = nextClose
      subscription.position = context
      if (forming !== undefined && forming.timestamp > (closed.at(-1)?.openTime ?? -1)) {
        subscription.callback(forming)
      }
    } catch (reason) {
      if (!request.signal.aborted) {
        subscription.retryAfter = Date.now() + HISTORY_ERROR_RETRY_MS
        this.onWarning?.(`回放图表行情暂时不可用：${reason instanceof Error ? reason.message : String(reason)}`)
      }
      return
    } finally {
      if (subscription.request === request) subscription.request = undefined
    }
    if (!request.signal.aborted && this.subscription === subscription) {
      void this.emitBars(subscription)
    }
  }

  private key(symbol: SymbolInfo, period: Period): string {
    return `${symbol.ticker.toUpperCase()}:${period.text}`
  }
}
