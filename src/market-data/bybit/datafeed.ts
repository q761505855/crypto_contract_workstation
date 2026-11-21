import type { Datafeed, DatafeedSubscribeCallback, Period, SymbolInfo } from '@klinecharts/pro'
import type { KLineData } from 'klinecharts'
import { alignOpenTime, shiftOpenTime } from '../intervals'
import type { ReplayContext } from '../../replay/models'
import { BybitArchive } from './archive'
import type { BybitLiveTrades } from './live'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, bybitSymbolInfo, type BybitSymbol, type BybitTrade } from './trades'

const BAR_BATCH = 120
const LIVE_HISTORY_MS = BYBIT_DAY_MS * 2

// Stored in microseconds so archive records that share a millisecond keep
// their exact order. The displayed K line retains the chart's millisecond grid.
export interface TradeRange {
  fromUs: number
  untilUs: number
}

function firstTradeAt(trades: readonly BybitTrade[], timeUs: number): number {
  let low = 0
  let high = trades.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (trades[middle].timeUs < timeUs) low = middle + 1
    else high = middle
  }
  return low
}

export function addTradeToBar(bar: KLineData | undefined, timestamp: number, trade: BybitTrade): KLineData {
  const { price, size } = trade
  const notional = price * size
  if (!bar || bar.timestamp !== timestamp) {
    return { timestamp, open: price, high: price, low: price, close: price, volume: size, turnover: notional }
  }
  return { ...bar, high: Math.max(bar.high, price), low: Math.min(bar.low, price), close: price,
    volume: (bar.volume ?? 0) + size, turnover: (bar.turnover ?? 0) + notional }
}

export class BybitDatafeed implements Datafeed {
  private cursorUs?: number
  private readonly listeners = new Set<(reset: boolean) => void>()
  private unsubscribeLive?: () => void
  private subscription?: { timeframe: string; callback: DatafeedSubscribeCallback; last?: KLineData }
  private readonly draftBars = new Map<string, { bar: KLineData; untilUs: number }>()
  private liveUpdates = new Map<number, KLineData>()
  private frame?: ReturnType<typeof setTimeout>
  private isDisposed = false

  constructor(readonly symbol: BybitSymbol, readonly archive: BybitArchive, readonly live?: BybitLiveTrades,
    readonly dayStart?: number, startUs?: number, private readonly onWarning: (message: string) => void = () => {},
    private readonly onRebuild: () => void = () => {}) {
    this.cursorUs = startUs
  }

  get currentUs(): number { return this.cursorUs ?? (Date.now() + 1) * 1000 }
  get tradeCursorUs(): number { return this.cursorUs ?? (this.live?.lastTradeUs ?? Date.now() * 1000) + 1 }
  hasLiveTail(): boolean { return this.cursorUs === undefined }
  getReplayContext(): ReplayContext | null {
    if (this.cursorUs === undefined) return null
    const visibleUntil = Math.ceil(this.cursorUs / 1000)
    return { sessionId: `bybit:${this.symbol}:${this.dayStart}`, symbol: this.symbol,
      currentTime: visibleUntil - 1, visibleUntil, timeframe: '1m' }
  }

  start(): void {
    if (this.unsubscribeLive || !this.live) return
    this.isDisposed = false
    this.unsubscribeLive = this.live.subscribe((trades, rebuilt) => {
      if (rebuilt) {
        clearTimeout(this.frame)
        this.frame = undefined
        this.liveUpdates.clear()
        this.draftBars.clear()
        this.onRebuild()
        this.emit(true)
        return
      }
      this.pushTrades(trades)
      if (this.frame === undefined) this.frame = setTimeout(() => this.flush(), 125)
    })
  }

  dispose(): void {
    this.isDisposed = true
    this.unsubscribeLive?.()
    this.unsubscribeLive = undefined
    clearTimeout(this.frame)
    this.frame = undefined
    this.liveUpdates.clear()
  }

  subscribeTrades(listener: (reset: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async searchSymbols(): Promise<SymbolInfo[]> { return [bybitSymbolInfo(this.symbol)] }

  async visitTrades({ fromUs, untilUs }: TradeRange, accept: (trade: BybitTrade) => void,
    signal?: AbortSignal, followCursor = true): Promise<boolean> {
    const from = Math.max(0, fromUs)
    const until = followCursor ? Math.min(untilUs, this.currentUs) : untilUs
    if (from >= until) return true
    let hour = Math.floor(from / 1000 / BYBIT_HOUR_MS) * BYBIT_HOUR_MS
    let complete = true
    for (; hour * 1000 < until; hour += BYBIT_HOUR_MS) {
      signal?.throwIfAborted()
      const lo = Math.max(hour * 1000, from)
      const hi = Math.min((hour + BYBIT_HOUR_MS) * 1000, until)
      const archived = await this.archive.loadHour(this.symbol, hour)
      signal?.throwIfAborted()
      if (archived !== null) {
        const last = firstTradeAt(archived, hi)
        for (let index = firstTradeAt(archived, lo); index < last; index++) accept(archived[index])
      } else if (this.live) {
        if (this.live.gap || (this.live.coverageStartUs ?? Infinity) > lo) complete = false
        for (const trade of this.live.read(lo, hi)) accept(trade)
      } else complete = false
    }
    return complete
  }

  async getHistoryKLineData(_symbol: SymbolInfo, period: Period, from: number, to: number,
    updateState = true, signal?: AbortSignal): Promise<KLineData[]> {
    const untilUs = Math.min(this.currentUs, (to + 1) * 1000)
    if (!Number.isFinite(untilUs) || untilUs <= 0) return []
    const end = Math.floor((untilUs - 1) / 1000)
    const requestedStart = this.dayStart !== undefined && updateState && from > end ? this.dayStart : from
    const start = Math.max(this.dayStart ?? (end - LIVE_HISTORY_MS),
      alignOpenTime(requestedStart, period.text, 'floor'), shiftOpenTime(end, period.text, 1 - BAR_BATCH))
    try {
      const { bars, complete } = await this.collectBars(period.text, Math.max(0, start) * 1000, untilUs, signal)
      if (updateState && !this.isDisposed) {
        this.onWarning(complete ? '' : '部分时间没有可用的逐笔成交，缺口待日归档补齐')
        const last = bars.at(-1)
        if (last) {
          this.draftBars.set(period.text, { bar: last, untilUs })
          if (this.subscription?.timeframe === period.text) {
            this.subscription.last = last
            this.catchUpLive(untilUs)
          }
        }
      }
      return bars
    } catch (reason) {
      if (signal?.aborted) throw reason
      if (updateState && !this.isDisposed) this.onWarning(reason instanceof Error ? reason.message : '读取 Bybit 成交失败')
      return []
    }
  }

  async getOlderHistory(_symbol: SymbolInfo, period: Period, before: number, signal?: AbortSignal) {
    const start = Math.max(this.dayStart ?? 0, alignOpenTime(before - BYBIT_HOUR_MS * 3, period.text, 'floor'))
    if (start >= before) return { candles: [], hasMore: false }
    const { bars, complete } = await this.collectBars(period.text, start * 1000, before * 1000, signal)
    return { candles: bars, hasMore: bars.length > 0 && complete && (this.dayStart === undefined || start > this.dayStart) }
  }

  subscribe(_symbol: SymbolInfo, period: Period, callback: DatafeedSubscribeCallback): void {
    const draft = this.draftBars.get(period.text)
    this.subscription = { timeframe: period.text, callback, last: draft?.bar }
    if (draft) this.catchUpLive(draft.untilUs)
  }

  unsubscribe(_symbol: SymbolInfo, period: Period): void {
    if (this.subscription?.timeframe === period.text) this.subscription = undefined
  }

  async advance(untilUs: number, signal?: AbortSignal): Promise<void> {
    if (this.cursorUs === undefined || untilUs <= this.cursorUs || this.dayStart === undefined) return
    const next = Math.min(untilUs, (this.dayStart + BYBIT_DAY_MS) * 1000)
    const trades: BybitTrade[] = []
    const complete = await this.visitTrades({ fromUs: this.cursorUs, untilUs: next }, trade => trades.push(trade), signal, false)
    signal?.throwIfAborted()
    this.pushTrades(trades)
    this.cursorUs = next
    this.onWarning(complete ? '' : '当前日期的成交归档尚未完整缓存')
    this.flush()
  }

  seek(untilUs: number): void {
    this.cursorUs = untilUs
    this.draftBars.clear()
    this.liveUpdates.clear()
    if (this.subscription) this.subscription.last = undefined
    this.emit(true)
  }

  private async collectBars(timeframe: string, fromUs: number, untilUs: number, signal?: AbortSignal) {
    const bars: KLineData[] = []
    let bar: KLineData | undefined
    const complete = await this.visitTrades({ fromUs, untilUs }, trade => {
      const timestamp = alignOpenTime(Math.floor(trade.timeUs / 1000), timeframe, 'floor')
      if (bar && timestamp !== bar.timestamp) bars.push(bar)
      bar = addTradeToBar(bar, timestamp, trade)
    }, signal)
    if (bar) bars.push(bar)
    return { bars, complete }
  }

  private catchUpLive(untilUs: number): void {
    if (!this.live) return
    this.liveUpdates.clear()
    this.pushTrades(this.live.read(untilUs, Infinity))
    if (this.liveUpdates.size && this.frame === undefined) this.frame = setTimeout(() => this.flush(), 125)
  }

  private pushTrades(trades: readonly BybitTrade[]): void {
    const subscription = this.subscription
    if (!subscription) return
    const { timeframe } = subscription
    for (const trade of trades) {
      const timestamp = alignOpenTime(Math.floor(trade.timeUs / 1000), timeframe, 'floor')
      if (subscription.last && timestamp < subscription.last.timestamp) continue
      const bar = addTradeToBar(subscription.last, timestamp, trade)
      subscription.last = bar
      this.liveUpdates.set(timestamp, bar)
    }
  }

  private flush(): void {
    this.frame = undefined
    const subscription = this.subscription
    if (subscription?.last) this.draftBars.set(subscription.timeframe, { bar: subscription.last, untilUs: this.currentUs })
    for (const bar of this.liveUpdates.values()) subscription?.callback(bar)
    this.liveUpdates.clear()
    this.emit()
  }

  private emit(reset = false): void { for (const listener of this.listeners) listener(reset) }
}
