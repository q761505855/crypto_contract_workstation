import type { SymbolInfo } from '@klinecharts/pro'
import type { GitHubContentsClient } from '../../github-sync/github-client'
import { replayConfirmedUntil, type ReplayContext } from '../../replay/models'
import { BybitArchive } from './archive'
import { ensureBybitDay } from './archive-requests'
import { BybitLiveTrades } from './live'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, bybitDay, bybitDayStart, bybitFirstDay, bybitMapping, type BybitMapping,
  type BybitTrade } from './trades'

export interface TradeRange { fromUs: number; untilUs: number; cache?: 'viewport' | 'selection' }

interface PendingDay { abort: AbortController; message: string }
const weekUs = 7 * BYBIT_DAY_MS * 1000
const wakeIntervalMs = 60_000
const liveSettlementMs = 250
const cacheWorker = { owner: 'q761505855', repository: 'crypto_contract_workstation', event: 'bybit-trades-requested' }

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
  private readonly pending = new Map<string, PendingDay>()
  private readonly failed = new Map<string, string>()
  private nextWake = 0
  private pendingLiveUpdate?: ReturnType<typeof setTimeout>

  constructor(private readonly cloud: GitHubContentsClient, private readonly changed: (reset?: boolean) => void,
    private readonly archive = new BybitArchive(cloud.getTarget()), private readonly now = Date.now) {}

  get mapping(): BybitMapping | undefined { return this.active }
  get status(): string {
    if (this.pending.size > 1) return `正在补齐 ${this.pending.size} 个 UTC 日的 Bybit 成交…`
    return this.pending.values().next().value?.message ?? this.failed.values().next().value ?? ''
  }
  get tradeCursorUs(): number {
    if (this.context) return replayConfirmedUntil(this.context) * 1000
    const last = this.live?.lastTradeUs
    return last === undefined ? this.now() * 1000 + 1 : Math.min(last + 1, (this.now() - liveSettlementMs) * 1000)
  }

  select(symbol: SymbolInfo, context: ReplayContext | null): void {
    const key = `${symbol.exchange}:${symbol.ticker}:${context?.sessionId ?? ''}`
    const reset = this.selection !== key || (!!context && !!this.context && replayConfirmedUntil(context) < replayConfirmedUntil(this.context))
    this.context = context
    if (reset) {
      const mapping = bybitMapping(symbol)
      if (!mapping || mapping.symbol !== this.active?.symbol) {
        this.live?.close()
        this.live = undefined
        clearTimeout(this.pendingLiveUpdate)
        this.clearRequests()
      }
      this.selection = key
      this.active = mapping
    }
    this.changed(reset)
  }

  release(): void {
    this.live?.close()
    this.live = undefined
    clearTimeout(this.pendingLiveUpdate)
    this.clearRequests()
  }

  private clearRequests(): void {
    for (const pending of this.pending.values()) pending.abort.abort()
    this.pending.clear()
    this.failed.clear()
  }

  async visitTrades({ fromUs, untilUs, cache }: TradeRange, accept: (trade: BybitTrade) => void, signal: AbortSignal): Promise<boolean> {
    const mapping = this.active
    if (!mapping) return false
    if (!this.context && !this.live) {
      const live = new BybitLiveTrades(mapping.symbol, () => this.changed())
      live.subscribe((_rows, rebuilt, fromUs) => {
        // A busy contract can send several messages stamped with the same
        // millisecond. Wait briefly before finalizing that timestamp.
        this.changed(rebuilt && (fromUs === undefined || fromUs < this.tradeCursorUs))
        clearTimeout(this.pendingLiveUpdate)
        this.pendingLiveUpdate = setTimeout(() => this.changed(), liveSettlementMs + 1)
      })
      this.live = live
      live.open()
    }
    const first = bybitDayStart(bybitFirstDay(mapping.symbol))
    const end = Math.min(untilUs, this.tradeCursorUs)
    const replayDay = this.context && bybitDay((this.tradeCursorUs - 1) / 1000)
    const firstDay = bybitFirstDay(mapping.symbol)
    const latest = bybitDay(this.now())
    const requested = new Set<string>()
    if (replayDay && replayDay < latest && replayDay >= firstDay && end > bybitDayStart(replayDay) * 1000) requested.add(replayDay)
    if (cache === 'selection' || (cache === 'viewport' && end - fromUs <= weekUs)) {
      const oldest = bybitDayStart(bybitDay(Math.max(fromUs / 1000, first)))
      const newest = Math.min(bybitDayStart(bybitDay((end - 1) / 1000)), bybitDayStart(latest) - BYBIT_DAY_MS)
      for (let date = newest; date >= oldest; date -= BYBIT_DAY_MS) requested.add(bybitDay(date))
    }
    const planned = new Map(await Promise.all([...requested].map(async day => {
      const available = await this.archive.hasDay(mapping.symbol, day)
      signal.throwIfAborted()
      if (!available) this.requestDay(mapping, day)
      return [day, available] as const
    })))
    let complete = fromUs >= first * 1000
    for (let hour = Math.floor(Math.max(fromUs / 1000, first) / BYBIT_HOUR_MS) * BYBIT_HOUR_MS; hour * 1000 < end;) {
      signal.throwIfAborted()
      const day = bybitDay(hour)
      const nextDay = bybitDayStart(day) + BYBIT_DAY_MS
      const available = day < latest && (planned.get(day) ?? await this.archive.hasDay(mapping.symbol, day))
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
    if (this.pending.has(day) || this.failed.has(day)) return
    const pending = { abort: new AbortController(), message: `准备补齐 ${day} UTC 日档…` }
    this.pending.set(day, pending)
    void ensureBybitDay(this.archive, this.cloud, mapping.symbol, day, message => {
      if (this.pending.get(day) !== pending || pending.message === message) return
      pending.message = message
      this.changed()
    }, pending.abort.signal, this.wakeWorker).then(() => {
      if (this.pending.get(day) !== pending) return
      this.pending.delete(day)
      this.changed(true)
    }, error => {
      if (this.pending.get(day) !== pending) return
      this.pending.delete(day)
      this.failed.set(day, error instanceof Error ? error.message : '无法缓存 Bybit 逐笔成交')
      this.changed()
    })
  }

  private wakeWorker = (): void => {
    if (!this.cloud.canWrite() || this.now() < this.nextWake) return
    const target = this.cloud.getTarget()
    if (target.owner !== cacheWorker.owner || target.repository !== 'personal-cloud-storage' || target.branch !== 'main') return
    this.nextWake = this.now() + wakeIntervalMs
    void this.cloud.dispatchRepositoryEvent(cacheWorker.owner, cacheWorker.repository, cacheWorker.event, AbortSignal.timeout(10_000))
      .catch(() => { /* The persisted request remains available to the scheduled job. */ })
  }
}
