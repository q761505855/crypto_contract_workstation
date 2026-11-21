import type { SymbolInfo } from '@klinecharts/pro'
import type { GitHubContentsClient } from '../../github-sync/github-client'
import { replayConfirmedUntil, type ReplayContext } from '../../replay/models'
import { BybitArchive } from './archive'
import { ensureBybitDay } from './archive-requests'
import { BybitLiveTrades } from './live'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, bybitDay, bybitDayStart, bybitFirstDay, bybitMapping, type BybitMapping,
  type BybitTrade } from './trades'

export interface TradeRange { fromUs: number; untilUs: number }

function lowerBound(rows: readonly BybitTrade[], time: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (rows[mid].timeUs < time) low = mid + 1
    else high = mid
  }
  return low
}

export class CombinedBybitSource {
  private live?: BybitLiveTrades
  private active?: BybitMapping
  private context: ReplayContext | null = null
  private selection = ''
  private pending?: { day: string; abort: AbortController }
  private failedDay?: string
  private message = ''

  constructor(private readonly cloud: GitHubContentsClient, private readonly changed: (reset?: boolean) => void,
    private readonly archive = new BybitArchive(cloud.getTarget()), private readonly now = Date.now) {}

  get mapping(): BybitMapping | undefined { return this.active }
  get status(): string { return this.message }
  get tradeCursorUs(): number { return this.context ? replayConfirmedUntil(this.context) * 1000 : (this.live?.lastTradeUs ?? this.now() * 1000) + 1 }

  select(symbol: SymbolInfo, context: ReplayContext | null): void {
    const key = `${symbol.exchange}:${symbol.ticker}:${context?.sessionId ?? ''}`
    const reset = this.selection !== key || (!!context && !!this.context && replayConfirmedUntil(context) < replayConfirmedUntil(this.context))
    this.context = context
    if (reset) {
      const mapping = bybitMapping(symbol)
      if (!mapping || mapping.symbol !== this.active?.symbol) {
        this.live?.close()
        this.live = undefined
      }
      this.clearRequest()
      this.selection = key
      this.active = mapping
    }
    this.changed(reset)
  }

  release(): void {
    this.live?.close()
    this.live = undefined
    this.clearRequest()
  }

  private clearRequest(): void {
    this.pending?.abort.abort()
    this.pending = undefined
    this.failedDay = undefined
    this.message = ''
  }

  async visitTrades({ fromUs, untilUs }: TradeRange, accept: (trade: BybitTrade) => void, signal: AbortSignal): Promise<boolean> {
    const mapping = this.active
    if (!mapping) return false
    if (!this.context && !this.live) {
      const live = new BybitLiveTrades(mapping.symbol, () => this.changed())
      live.subscribe((_rows, reset) => this.changed(reset))
      this.live = live
      live.open()
    }
    const first = bybitDayStart(bybitFirstDay(mapping.symbol))
    const end = Math.min(untilUs, this.tradeCursorUs)
    const replayDay = this.context && bybitDay((this.tradeCursorUs - 1) / 1000)
    const firstDay = bybitFirstDay(mapping.symbol)
    const latest = bybitDay(this.now())
    const replayAvailable = replayDay && replayDay < latest && replayDay >= firstDay &&
      end > bybitDayStart(replayDay) * 1000 ? await this.archive.hasDay(mapping.symbol, replayDay) : undefined
    signal.throwIfAborted()
    if (replayDay && replayAvailable === false) this.requestDay(mapping, replayDay)
    let complete = fromUs >= first * 1000
    for (let hour = Math.floor(Math.max(fromUs / 1000, first) / BYBIT_HOUR_MS) * BYBIT_HOUR_MS; hour * 1000 < end;) {
      signal.throwIfAborted()
      const day = bybitDay(hour)
      const nextDay = bybitDayStart(day) + BYBIT_DAY_MS
      const available = day < latest && (day === replayDay && replayAvailable !== undefined
        ? replayAvailable : await this.archive.hasDay(mapping.symbol, day))
      signal.throwIfAborted()
      if (!available) {
        const lo = Math.max(hour * 1000, fromUs)
        if (!this.live || this.live.gap || (this.live.coverageStartUs ?? Infinity) > lo) complete = false
        for (const trade of this.live?.read(lo, Math.min(nextDay * 1000, end)) ?? []) accept(trade)
        hour = nextDay
        continue
      }
      while (hour < nextDay && hour * 1000 < end) {
        const rows = await this.archive.loadHour(mapping.symbol, hour)
        signal.throwIfAborted()
        const nextHour = hour + BYBIT_HOUR_MS
        if (rows) {
          const stop = lowerBound(rows, Math.min(nextHour * 1000, end))
          for (let i = lowerBound(rows, Math.max(hour * 1000, fromUs)); i < stop; i++) accept(rows[i])
        } else complete = false
        hour = nextHour
      }
    }
    return complete
  }

  private requestDay(mapping: BybitMapping, day: string): void {
    if (this.pending?.day === day || this.failedDay === day) return
    this.pending?.abort.abort()
    const pending = { day, abort: new AbortController() }
    this.pending = pending
    void ensureBybitDay(this.archive, this.cloud, mapping.symbol, day, message => {
      if (this.pending !== pending) return
      this.message = message
      this.changed()
    }, pending.abort.signal).then(() => {
      if (this.pending !== pending) return
      this.pending = undefined
      this.message = ''
      this.changed(true)
    }, error => {
      if (this.pending !== pending) return
      this.pending = undefined
      this.failedDay = day
      this.message = error instanceof Error ? error.message : '无法缓存 Bybit 逐笔成交'
      this.changed(true)
    })
  }
}
