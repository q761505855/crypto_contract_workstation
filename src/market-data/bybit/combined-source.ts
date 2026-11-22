import type { SymbolInfo } from '@klinecharts/pro'
import type { GitHubContentsClient } from '../../github-sync/github-client'
import { replayConfirmedUntil, type ReplayContext } from '../../replay/models'
import { BybitArchive } from './archive'
import { ensureBybitDay } from './archive-requests'
import { BybitLiveTrades } from './live'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, bybitDay, bybitDayStart, bybitFirstDay, bybitMapping, type BybitMapping,
  type BybitSymbol, type BybitTrade } from './trades'

export interface TradeRange { fromUs: number; untilUs: number }
export interface TradeCoverage extends TradeRange { complete: boolean; archived: boolean }

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
  private readonly downloaded = new Map<BybitSymbol, Set<number>>()
  private released = false
  private nextWake = 0
  private pendingLiveUpdate?: ReturnType<typeof setTimeout>

  constructor(private readonly cloud: GitHubContentsClient, private readonly changed: (reset?: boolean, affected?: TradeRange) => void,
    private readonly archive = new BybitArchive(cloud.getTarget()), private readonly now = Date.now) {}

  get mapping(): BybitMapping | undefined { return this.active }
  get replaying(): boolean { return this.context !== null }
  get downloadedDays(): Iterable<number> { return this.active && this.downloaded.get(this.active.symbol) || [] }
  get archiveCacheKey(): string {
    const { owner, repository, branch, root } = this.cloud.getTarget()
    return JSON.stringify([owner, repository, branch, root, this.active?.symbol])
  }
  get tradeCursorUs(): number {
    if (this.context) return replayConfirmedUntil(this.context) * 1000
    const last = this.live?.lastTradeUs
    return last === undefined ? this.now() * 1000 + 1 : Math.min(last + 1, (this.now() - liveSettlementMs) * 1000)
  }

  hasArchivedDay(start: number): Promise<boolean> {
    return this.active ? this.archive.hasDay(this.active.symbol, bybitDay(start)) : Promise.resolve(false)
  }

  readArchivedHour(start: number): Promise<BybitTrade[] | null> {
    return this.active ? this.archive.loadHour(this.active.symbol, start) : Promise.resolve(null)
  }

  readReplayLive({ fromUs, untilUs }: TradeRange): BybitTrade[] {
    return this.live?.read(fromUs, untilUs) ?? []
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
    this.released = true
    this.live?.close()
    this.live = undefined
    clearTimeout(this.pendingLiveUpdate)
    for (const pending of this.pending.values()) pending.abort.abort()
    this.pending.clear()
  }

  async visitTrades({ fromUs, untilUs }: TradeRange, accept: (trade: BybitTrade) => void, signal: AbortSignal,
    reportCoverage?: (coverage: TradeCoverage) => void): Promise<boolean> {
    const mapping = this.active
    if (!mapping) return false
    if (!this.context && !this.live) {
      const live = new BybitLiveTrades(mapping.symbol, () => this.changed())
      live.subscribe((rows, rebuilt, fromUs) => {
        // A busy contract can send several messages stamped with the same
        // millisecond. Wait briefly before finalizing that timestamp.
        const first = fromUs ?? rows[0]?.timeUs
        const changedPast = rebuilt && first !== undefined && first < this.tradeCursorUs
        this.changed(changedPast, changedPast ? { fromUs: first, untilUs: Infinity } : undefined)
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
    if (!complete && fromUs < end) reportCoverage?.({ fromUs, untilUs: Math.min(first * 1000, end), complete: false, archived: false })
    for (let hour = Math.floor(Math.max(fromUs / 1000, first) / BYBIT_HOUR_MS) * BYBIT_HOUR_MS; hour * 1000 < end;) {
      signal.throwIfAborted()
      const day = bybitDay(hour)
      const nextDay = bybitDayStart(day) + BYBIT_DAY_MS
      const dayFrom = Math.max(hour * 1000, fromUs)
      const dayUntil = Math.min(nextDay * 1000, end)
      const available = day < latest && await this.archive.hasDay(mapping.symbol, day)
      signal.throwIfAborted()
      if (!available) {
        const coverageStart = this.live?.coverageStartUs ?? Infinity
        const gapUntil = this.live && !this.live.gap ? Math.min(dayUntil, Math.max(dayFrom, coverageStart)) : dayUntil
        if (gapUntil > dayFrom) {
          complete = false
          reportCoverage?.({ fromUs: dayFrom, untilUs: gapUntil, complete: false, archived: false })
        }
        if (gapUntil < dayUntil) reportCoverage?.({ fromUs: gapUntil, untilUs: dayUntil, complete: true, archived: false })
        for (const trade of this.live?.read(dayFrom, dayUntil) ?? []) accept(trade)
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
        reportCoverage?.({ fromUs: Math.max(hour * 1000, fromUs), untilUs: Math.min(nextHour * 1000, end),
          complete: rows !== null, archived: rows !== null })
        hour = nextHour
      }
    }
    return complete
  }

  downloadDays(start: string, end: string, report: (message: string) => void): Promise<string> {
    const symbol = this.active?.symbol
    if (!symbol) throw new Error('当前品种暂无 Bybit 成交量')
    const first = start || end
    const last = end || start
    if (!first) throw new Error('请选择开始或结束日期')
    const from = bybitDayStart(first)
    const to = bybitDayStart(last)
    if (from > to) throw new Error('开始日期不能晚于结束日期')
    if (last >= bybitDay(this.now())) throw new Error(`${last} UTC 日档须等该日结束后下载`)
    if (first < bybitFirstDay(symbol)) throw new Error(`Bybit 未提供 ${symbol} ${first} UTC 逐笔归档`)
    return from === to ? this.requestDay(symbol, first, report) : this.downloadRange(symbol, from, to, report)
  }

  private async downloadRange(symbol: BybitSymbol, from: number, to: number, report: (message: string) => void): Promise<string> {
    const total = (to - from) / BYBIT_DAY_MS + 1
    let finished = 0
    const failures: string[] = []
    for (let batch = from; batch <= to; batch += 8 * BYBIT_DAY_MS) {
      const requests: Promise<void>[] = []
      for (let time = batch; time <= to && time < batch + 8 * BYBIT_DAY_MS; time += BYBIT_DAY_MS) {
        const day = bybitDay(time)
        const show = (progress: string) => report(`${symbol} 已处理 ${finished}/${total} 天 · ${progress}`)
        requests.push(this.requestDay(symbol, day, show).then(message => {
          finished++
          show(message)
        }, error => {
          finished++
          failures.push(day)
          show(error instanceof Error ? error.message : `${day} 下载失败`)
        }))
      }
      await Promise.all(requests)
      if (this.released) break
    }
    return failures.length
      ? `${symbol} 已缓存 ${finished - failures.length}/${total} 天 · 失败日期 ${failures.sort().join('、')}`
      : `${symbol} ${bybitDay(from)} 至 ${bybitDay(to)} UTC 日档已缓存（${total} 天）`
  }

  private async requestDay(symbol: BybitSymbol, day: string, report: (message: string) => void): Promise<string> {
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
      const start = bybitDayStart(day)
      const downloaded = this.downloaded.get(symbol) ?? new Set<number>()
      downloaded.add(start)
      this.downloaded.set(symbol, downloaded)
      if (this.active?.symbol === symbol) this.changed(true, { fromUs: start * 1000, untilUs: (start + BYBIT_DAY_MS) * 1000 })
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
