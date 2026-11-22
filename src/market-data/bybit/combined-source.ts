import type { SymbolInfo } from '@klinecharts/pro'
import type { GitHubContentsClient } from '../../github-sync/github-client'
import { replayConfirmedUntil, type ReplayContext } from '../../replay/models'
import { BybitArchive } from './archive'
import { ensureTradeDay } from './archive-requests'
import { BybitLiveTrades } from './live'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, bybitDay, bybitDayStart, bybitFirstDay, type BybitSymbol, type BybitTrade } from './trades'
import { OkxArchive, okxArchiveDay } from '../okx/archive'
import { getOkxTrades, OkxLiveTrades } from '../okx/live'
import { compareTrades, mergeOkxTrades, orderFlowMapping, type OrderFlowMapping } from '../okx/trades'

export interface TradeRange { fromUs: number; untilUs: number; replaceArchive?: boolean }
export interface TradeCoverage extends TradeRange { complete: boolean; archived: boolean; fallbackArchive?: boolean }

interface HistoryDay {
  untilUs: number
  rows: BybitTrade[]
}

interface PendingDay {
  abort: AbortController
  message: string
  report: (message: string) => void
  done: Promise<string>
}
const wakeIntervalMs = 60_000
const liveSettlementMs = 250
const cacheWorker = { owner: 'q761505855', repository: 'crypto_contract_workstation' }

const dayStart = (ms: number) => Math.floor(ms / BYBIT_DAY_MS) * BYBIT_DAY_MS

// Return the oldest UTC day that the API can still cover in full.
export function firstOkxHistoryDay(now: number): number {
  const date = new Date(now)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() - 3)
  date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()))
  const cutoff = date.getTime()
  return Math.ceil(cutoff / BYBIT_DAY_MS) * BYBIT_DAY_MS
}

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
  private okxLive?: OkxLiveTrades
  private active?: OrderFlowMapping
  private context: ReplayContext | null = null
  private selection = ''
  private readonly pending = new Map<string, PendingDay>()
  private readonly archiveDownloads = new AbortController()
  private readonly downloaded = new Map<string, Set<number>>()
  private readonly history = new Map<string, Map<number, HistoryDay>>()
  private readonly nextWake = new Map<string, number>()
  private pendingLiveUpdate?: ReturnType<typeof setTimeout>

  constructor(private readonly cloud: GitHubContentsClient, private readonly changed: (reset?: boolean, affected?: TradeRange) => void,
    private readonly archive = new BybitArchive(cloud.getTarget()), private readonly now = Date.now,
    private readonly okxArchive = new OkxArchive(cloud.getTarget(), fetch, now)) {}

  get mapping(): OrderFlowMapping | undefined { return this.active }
  get replaying(): boolean { return this.context !== null }
  get downloadedDays(): Iterable<number> { return this.active && this.downloaded.get(this.active.symbol) || [] }
  get requestedHistoryDays(): Iterable<[number, number]> {
    return Array.from(this.activeHistory ?? [], ([day, history]) => [day, history.untilUs])
  }
  get archiveCacheKey(): string {
    const { owner, repository, branch, root } = this.cloud.getTarget()
    const primary = this.active?.okx
    if (primary) return JSON.stringify([owner, repository, branch, root, 'okx-first', primary.symbol, primary.contractValue, this.active?.bybit?.symbol])
    return JSON.stringify([owner, repository, branch, root, this.active?.bybit?.symbol])
  }
  get tradeCursorUs(): number {
    if (this.context) return replayConfirmedUntil(this.context) * 1000
    return (this.now() - liveSettlementMs) * 1000
  }

  isArchiveRequested(hour: number): boolean {
    return !!this.active && !!this.downloaded.get(this.active.symbol)?.has(dayStart(hour))
  }

  shouldScanTradeHour(hour: number): boolean {
    return this.isArchiveRequested(hour) || this.activeHistory?.has(dayStart(hour)) === true ||
      ((hour + BYBIT_HOUR_MS) * 1000 > this.liveStartUs &&
        Math.max(this.okxLive?.lastTradeUs ?? -1, this.live?.lastTradeUs ?? -1) >= hour * 1000)
  }

  private get activeHistory(): Map<number, HistoryDay> | undefined {
    return this.active && this.history.get(this.active.symbol)
  }

  private get liveStartUs(): number {
    return Math.min(this.okxLive?.firstTradeUs ?? Infinity, this.live?.firstTradeUs ?? Infinity)
  }

  async hasArchivedDay(start: number): Promise<boolean> {
    const mapping = this.active
    if (!mapping || !this.isArchiveRequested(start)) return false
    if (mapping.okx && (await this.okxDayHours(mapping.okx, start)).some(Boolean)) return true
    return !!mapping.bybit && this.archive.hasDay(mapping.bybit.symbol, bybitDay(start)).catch(() => false)
  }

  private okxDayHours(okx: NonNullable<OrderFlowMapping['okx']>, start: number): Promise<boolean[]> {
    return Promise.all([start, start + BYBIT_DAY_MS - BYBIT_HOUR_MS]
      .map(hour => this.okxArchive.hasHour(okx, hour)))
  }

  async shouldPersistArchiveDay(start: number): Promise<boolean> {
    const okx = this.active?.okx
    return !okx || okxArchiveDay(start + BYBIT_DAY_MS - 1) < okx.firstDay || (await this.okxDayHours(okx, start)).every(Boolean)
  }

  hasCapturedCoverage(fromUs: number, untilUs: number): boolean {
    const snapshot = this.activeHistory?.get(dayStart(fromUs / 1000))
    if (snapshot && snapshot.untilUs >= untilUs) return true
    const socket = this.okxLive?.gap === false ? this.okxLive : this.live?.gap === false ? this.live : undefined
    if (!socket || (socket.lastTradeUs ?? -1) + 1 < untilUs) return false
    const socketStart = socket.coverageStartUs ?? Infinity
    return socketStart <= fromUs || (!!snapshot && snapshot.untilUs >= socketStart)
  }

  async readArchivedHour(start: number): Promise<BybitTrade[] | null> {
    const mapping = this.active
    if (!this.isArchiveRequested(start)) return null
    const primary = mapping?.okx && await this.okxArchive.loadHour(mapping.okx, start).catch(() => null)
    if (primary !== null && primary !== undefined) return primary
    return mapping?.bybit ? this.archive.loadHour(mapping.bybit.symbol, start).catch(() => null) : null
  }

  isOkxArchiveCachedAt(hour: number): Promise<boolean> {
    return this.active?.okx ? this.okxArchive.hasHour(this.active.okx, hour) : Promise.resolve(false)
  }

  readReplayLive({ fromUs, untilUs }: TradeRange): BybitTrade[] {
    const result: BybitTrade[] = []
    for (let start = Math.max(fromUs, this.capturedFromUs); start < untilUs;) {
      const day = dayStart(start / 1000)
      const end = Math.min(untilUs, (day + BYBIT_DAY_MS) * 1000)
      for (const trade of this.readCapturedDay(day, start, end)) result.push(trade)
      start = end
    }
    return result
  }

  private readCapturedDay(day: number, fromUs: number, untilUs: number): BybitTrade[] {
    const snapshot = this.activeHistory?.get(day)
    const rows = snapshot?.rows
    const requested = rows?.slice(lowerBound(rows, fromUs), lowerBound(rows, untilUs)) ?? []
    const primary = this.okxLive?.read(fromUs, untilUs) ?? []
    const okx = !primary.length ? requested : !requested.length ? primary : mergeOkxTrades(requested, primary)
    const fallbackStart = Math.max(fromUs, snapshot?.untilUs ?? fromUs)
    const fallback = this.live?.read(fallbackStart, untilUs) ?? []
    if (!fallback.length || !this.okxLive) return okx.length ? okx : fallback
    // Keep fallback trades only in the gap between confirmed OKX sessions.
    const primaryResumed = this.okxLive.gap ? Infinity : this.okxLive.coverageStartUs
    const available = fallback.filter(trade => trade.timeUs < primaryResumed)
    return okx.concat(available).sort(compareTrades)
  }

  get capturedFromUs(): number {
    let first = this.liveStartUs
    for (const day of this.activeHistory?.keys() ?? []) first = Math.min(first, day * 1000)
    return first
  }

  get capturedUntilUs(): number {
    let end = Math.max(this.okxLive?.lastTradeUs ?? -1, this.live?.lastTradeUs ?? -1) + 1
    for (const { untilUs } of this.activeHistory?.values() ?? []) end = Math.max(end, untilUs)
    return end
  }

  select(symbol: SymbolInfo, context: ReplayContext | null): void {
    const key = `${symbol.exchange}:${symbol.ticker}:${context?.sessionId ?? ''}`
    const reset = this.selection !== key || (!!context && !!this.context && replayConfirmedUntil(context) < replayConfirmedUntil(this.context))
    this.context = context
    if (reset) {
      const mapping = orderFlowMapping(symbol)
      if (mapping?.symbol !== this.active?.symbol || mapping?.okx?.symbol !== this.active?.okx?.symbol) {
        this.live?.close()
        this.live = undefined
        this.okxLive?.close()
        this.okxLive = undefined
        clearTimeout(this.pendingLiveUpdate)
      }
      this.selection = key
      this.active = mapping
    }
    if (!context && this.active) this.startRealtime(this.active)
    this.changed(reset)
  }

  release(): void {
    this.archiveDownloads.abort()
    this.live?.close()
    this.live = undefined
    this.okxLive?.close()
    clearTimeout(this.pendingLiveUpdate)
    for (const pending of this.pending.values()) pending.abort.abort()
    this.pending.clear()
  }

  async visitTrades({ fromUs, untilUs }: TradeRange, accept: (trade: BybitTrade) => void, signal: AbortSignal,
    reportCoverage?: (coverage: TradeCoverage) => void): Promise<boolean> {
    if (!this.active) return false
    const end = Math.min(untilUs, this.tradeCursorUs)
    let complete = true
    for (let hour = Math.floor(fromUs / 1000 / BYBIT_HOUR_MS) * BYBIT_HOUR_MS; hour * 1000 < end; hour += BYBIT_HOUR_MS) {
      signal.throwIfAborted()
      const start = Math.max(fromUs, hour * 1000)
      const stop = Math.min(end, (hour + BYBIT_HOUR_MS) * 1000)
      const primary = this.isArchiveRequested(hour) && this.active.okx
        ? await this.okxArchive.loadHour(this.active.okx, hour).catch(() => null) : null
      const archived = primary ?? (this.isArchiveRequested(hour) && this.active.bybit
        ? await this.archive.loadHour(this.active.bybit.symbol, hour).catch(() => null) : null)
      signal.throwIfAborted()
      if (archived) {
        const last = lowerBound(archived, stop)
        for (let i = lowerBound(archived, start); i < last; i++) accept(archived[i])
      } else {
        for (const trade of this.readCapturedDay(dayStart(hour), start, stop)) accept(trade)
      }
      const covered = archived !== null || this.hasCapturedCoverage(start, stop)
      complete &&= covered
      reportCoverage?.({ fromUs: start, untilUs: stop, complete: covered, archived: archived !== null,
        fallbackArchive: !!archived && !primary && !!this.active.okx && bybitDay(hour) >= this.active.okx.firstDay })
    }
    return complete
  }

  private openBybitLive(symbol: BybitSymbol): void {
    if (this.live) { this.live.open(); return }
    const live = new BybitLiveTrades(symbol, () => this.changed(), undefined, this.now)
    live.subscribe((rows, _rebuilt, fromUs) => this.liveChanged(fromUs ?? rows[0]?.timeUs))
    this.live = live
    live.open()
  }

  private liveChanged(fromUs?: number): void {
    const affected = fromUs !== undefined && fromUs < this.tradeCursorUs
      ? { fromUs, untilUs: Infinity } : undefined
    this.changed(!!affected, affected)
    clearTimeout(this.pendingLiveUpdate)
    this.pendingLiveUpdate = setTimeout(() => this.changed(), liveSettlementMs + 1)
  }

  private startRealtime(mapping: OrderFlowMapping): void {
    const instrument = mapping.okx
    if (!instrument) {
      if (mapping.bybit) this.openBybitLive(mapping.bybit.symbol)
    } else if (!this.okxLive) {
      this.okxLive = new OkxLiveTrades(instrument, fromUs => {
        if (this.okxLive?.failed && mapping.bybit && !this.context) this.openBybitLive(mapping.bybit.symbol)
        else if (this.live && !this.okxLive?.gap) this.live.close()
        this.liveChanged(fromUs)
      }, this.now)
      this.okxLive.open()
    }
  }

  downloadDays(start: string, end: string, report: (message: string) => void): Promise<string> {
    const mapping = this.active
    if (!mapping) throw new Error('当前品种暂无成交量')
    const first = start || end
    const last = end || start
    if (!first) throw new Error('请选择开始或结束日期')
    const from = bybitDayStart(first)
    const to = bybitDayStart(last)
    if (from > to) throw new Error('开始日期不能晚于结束日期')
    const now = this.now()
    const today = dayStart(now)
    if (to > today) throw new Error('结束日期不能晚于当前 UTC 日期')
    return this.downloadRange(mapping, from, to, now, report)
  }

  private async downloadRange(mapping: OrderFlowMapping, from: number, to: number, now: number,
    report: (message: string) => void): Promise<string> {
    const signal = this.archiveDownloads.signal
    const total = 1 + (to - from) / BYBIT_DAY_MS
    const earliest = firstOkxHistoryDay(now)
    const today = dayStart(now)
    const instrument = mapping.okx
    const counts = { 'OKX 接口': 0, 'OKX 日档': 0, 'Bybit 日档': 0 }
    const unavailable: string[] = []

    const fallbacks: Promise<void>[] = []
    const load = async (start: number, useRest: boolean) => {
      signal.throwIfAborted()
      const day = bybitDay(start)
      const progress = (message: string) => report(`${(start - from) / BYBIT_DAY_MS + 1}/${total} 天 · ${message}`)
      try {
        if (instrument && useRest) {
          if (start < today) {
            progress(`正在检查 OKX ${day} UTC 日档缓存…`)
            const cached = await this.okxArchive.hasCloudDay(instrument, day).catch(() => false)
            signal.throwIfAborted()
            if (cached) {
              this.markDownloaded(mapping.symbol, start)
              counts['OKX 日档']++
              return
            }
          }
          try {
            const untilUs = Math.min(start + BYBIT_DAY_MS, now) * 1000
            let history = this.history.get(mapping.symbol)
            if (!history) {
              history = new Map<number, HistoryDay>()
              this.history.set(mapping.symbol, history)
            }
            const previous = history.get(start)
            const fromUs = previous?.untilUs ?? start * 1000
            if (!previous || fromUs < untilUs) {
              progress(`正在读取 OKX ${day} UTC 历史逐笔…`)
              const rows = await getOkxTrades(instrument, fromUs, untilUs, signal, fetch,
                count => progress(`OKX ${day} UTC 已读取 ${count.toLocaleString()} 笔…`))
              signal.throwIfAborted()
              if ((history.get(start)?.untilUs ?? -Infinity) < untilUs) {
                history.set(start, { untilUs, rows: previous ? previous.rows.concat(rows) : rows })
                this.downloaded.get(mapping.symbol)?.delete(start)
                this.invalidateDay(mapping.symbol, start)
              }
            }
            counts['OKX 接口']++
            return
          } catch (error) {
            signal.throwIfAborted()
            if (start === today) throw error
            return false
          }
        }
        if (start === today) throw new Error(`${day} UTC 尚无可按日期读取的逐笔接口，日档在该日结束后提供`)
        const venue = await this.downloadArchive(mapping, start, progress, signal)
        counts[venue]++
      } catch (error) {
        signal.throwIfAborted()
        if (from === to) throw error
        unavailable.push(day)
        progress(error instanceof Error ? error.message : `${day} 下载失败`)
      }
    }
    // Page the REST API one day at a time. Archive requests can wait on Git in parallel.
    const firstRest = instrument ? Math.max(from, earliest, bybitDayStart(instrument.firstDay)) : to + BYBIT_DAY_MS
    const loadArchived = async () => {
      for (let batch = from; batch < firstRest && batch <= to; batch += 8 * BYBIT_DAY_MS) {
        const length = Math.min(8, (firstRest - batch) / BYBIT_DAY_MS, (to - batch) / BYBIT_DAY_MS + 1)
        await Promise.all(Array.from({ length }, (_, index) => load(batch + index * BYBIT_DAY_MS, false)))
      }
    }
    const loadRecent = async () => {
      for (let start = firstRest; start <= to; start += BYBIT_DAY_MS) {
        if (await load(start, true) !== false) continue
        if (from === to) { await load(start, false); return }
        fallbacks.push(load(start, false).then(() => undefined))
        if (fallbacks.length === 8) await Promise.all(fallbacks.splice(0))
      }
      await Promise.all(fallbacks)
    }
    await Promise.all([loadArchived(), loadRecent()])
    const summary = Object.entries(counts).filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count} 天`)
    if (unavailable.length) summary.push(`日期暂不可用 ${unavailable.sort().join('、')}`)
    return summary.join(' · ')
  }

  private async downloadArchive(mapping: OrderFlowMapping, start: number, progress: (message: string) => void,
    signal: AbortSignal): Promise<'OKX 日档' | 'Bybit 日档'> {
    const instrument = mapping.okx
    const day = bybitDay(start)
    const published = (ref?: string) => instrument ? this.okxArchive.hasCloudDay(instrument, day, ref) : Promise.resolve(false)
    let primaryError: unknown
    if (instrument && day >= instrument.firstDay) {
      try {
        if (await ensureTradeDay('OKX', published, this.cloud, instrument.symbol, day, progress, signal,
          () => this.wakeWorker('okx-trades-requested'))) {
          this.markDownloaded(mapping.symbol, start)
          return 'OKX 日档'
        }
      } catch (error) {
        signal.throwIfAborted()
        primaryError = error
      }
    }
    if (mapping.bybit && day >= bybitFirstDay(mapping.bybit.symbol)) {
      await this.requestDay(mapping.bybit.symbol, day, progress, published)
      this.markDownloaded(mapping.symbol, start)
      return await published().catch(() => false) ? 'OKX 日档' : 'Bybit 日档'
    }
    throw primaryError ?? new Error(`${mapping.symbol} ${day} UTC 暂无逐笔归档`)
  }

  private markDownloaded(symbol: string, start: number): void {
    const downloaded = this.downloaded.get(symbol) ?? new Set<number>()
    downloaded.add(start)
    this.downloaded.set(symbol, downloaded)
    this.history.get(symbol)?.delete(start)
    this.invalidateDay(symbol, start)
  }

  private invalidateDay(symbol: string, start: number): void {
    if (this.active?.symbol === symbol) this.changed(true, {
      fromUs: start * 1000,
      untilUs: (start + BYBIT_DAY_MS) * 1000,
      replaceArchive: true,
    })
  }

  private async requestDay(symbol: BybitSymbol, day: string, report: (message: string) => void,
    superseded?: (ref?: string) => Promise<boolean>): Promise<string> {
    const key = `${symbol}:${day}`
    const existing = this.pending.get(key)
    if (existing) {
      existing.report = report
      report(existing.message)
      return existing.done
    }
    const abort = new AbortController()
    const message = `正在检查 ${symbol} ${day} UTC 日档…`
    const available = async (ref?: string) => !!await superseded?.(ref).catch(() => false) || this.archive.hasDay(symbol, day, ref)
    const done = ensureTradeDay('Bybit', available, this.cloud, symbol, day, progress => {
      const pending = this.pending.get(key)
      if (pending?.abort !== abort) return
      pending.message = progress
      pending.report(progress)
    }, abort.signal, () => this.wakeWorker('bybit-trades-requested')).then(ready => {
      abort.signal.throwIfAborted()
      if (!ready) throw new Error(`Bybit 未提供 ${symbol} ${day} UTC 逐笔归档`)
      return `${symbol} ${day} UTC 日档已缓存`
    }).finally(() => {
      if (this.pending.get(key)?.abort === abort) this.pending.delete(key)
    })
    this.pending.set(key, { abort, message, report, done })
    report(message)
    return done
  }

  private wakeWorker(event: string): void {
    if (!this.cloud.canWrite() || this.now() < (this.nextWake.get(event) ?? 0)) return
    const target = this.cloud.getTarget()
    if (target.owner !== cacheWorker.owner || target.repository !== 'personal-cloud-storage' || target.branch !== 'main') return
    this.nextWake.set(event, this.now() + wakeIntervalMs)
    void this.cloud.dispatchRepositoryEvent(cacheWorker.owner, cacheWorker.repository, event, AbortSignal.timeout(10_000))
      .catch(() => { /* The persisted request remains available to the scheduled job. */ })
  }
}
