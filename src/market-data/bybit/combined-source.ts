import type { SymbolInfo } from '@klinecharts/pro'
import type { GitHubContentsClient } from '../../github-sync/github-client'
import { replayConfirmedUntil, type ReplayContext } from '../../replay/models'
import { BybitArchive } from './archive'
import { ensureBybitDay } from './archive-requests'
import { BybitLiveTrades } from './live'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, bybitDay, bybitDayStart, bybitFirstDay, bybitMapping, type BybitMapping,
  type BybitTrade } from './trades'

export interface TradeRange { fromUs: number; untilUs: number }

interface PendingDay {
  abort: AbortController
  message: string
  report: (message: string) => void
  done: Promise<string>
}
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
  private nextWake = 0
  private pendingLiveUpdate?: ReturnType<typeof setTimeout>

  constructor(private readonly cloud: GitHubContentsClient, private readonly changed: (reset?: boolean) => void,
    private readonly archive = new BybitArchive(cloud.getTarget()), private readonly now = Date.now) {}

  get mapping(): BybitMapping | undefined { return this.active }
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
    for (const pending of this.pending.values()) pending.abort.abort()
    this.pending.clear()
  }

  async visitTrades({ fromUs, untilUs }: TradeRange, accept: (trade: BybitTrade) => void, signal: AbortSignal): Promise<boolean> {
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
    const latest = bybitDay(this.now())
    let complete = fromUs >= first * 1000
    for (let hour = Math.floor(Math.max(fromUs / 1000, first) / BYBIT_HOUR_MS) * BYBIT_HOUR_MS; hour * 1000 < end;) {
      signal.throwIfAborted()
      const day = bybitDay(hour)
      const nextDay = bybitDayStart(day) + BYBIT_DAY_MS
      const available = day < latest && await this.archive.hasDay(mapping.symbol, day)
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

  async downloadDay(timestamp: number, report: (message: string) => void): Promise<string> {
    const symbol = this.active?.symbol
    if (!symbol) throw new Error('当前品种暂无 Bybit 成交量')
    const day = bybitDay(timestamp)
    if (day >= bybitDay(this.now())) throw new Error(`${day} UTC 日档须等该日结束后下载`)
    if (day < bybitFirstDay(symbol)) throw new Error(`Bybit 未提供 ${symbol} ${day} UTC 逐笔归档`)
    const key = `${symbol}:${day}`
    const existing = this.pending.get(key)
    if (existing) {
      existing.report = report
      report(existing.message)
      return existing.done
    }
    const abort = new AbortController()
    const message = `正在检查 ${symbol} ${day} UTC 日档…`
    const done = ensureBybitDay(this.archive, this.cloud, symbol, day, progress => {
      const pending = this.pending.get(key)
      if (pending?.abort !== abort) return
      pending.message = progress
      pending.report(progress)
    }, abort.signal, this.wakeWorker).then(() => {
      abort.signal.throwIfAborted()
      if (this.active?.symbol === symbol) this.changed(true)
      return `${symbol} ${day} UTC 日档已缓存`
    }).finally(() => {
      if (this.pending.get(key)?.abort === abort) this.pending.delete(key)
    })
    this.pending.set(key, { abort, message, report, done })
    report(message)
    return done
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
