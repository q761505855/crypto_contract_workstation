import type { SymbolInfo } from '@klinecharts/pro'
import type { GitHubContentsClient } from '../../github-sync/github-client'
import { replayConfirmedUntil, type ReplayContext } from '../../replay/models'
import { BybitArchive } from './archive'
import { ensureTradeDay } from './archive-requests'
import { BybitLiveTrades } from './live'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, bybitDay, bybitDayStart, bybitFirstDay, type BybitSymbol, type BybitTrade } from './trades'
import { OkxArchive, okxArchiveDay } from '../okx/archive'
import { OkxLiveTrades, OkxRecentTrades } from '../okx/live'
import { mergeOkxTrades, orderFlowMapping, type OrderFlowMapping } from '../okx/trades'

export interface TradeRange { fromUs: number; untilUs: number; replaceArchive?: boolean }
export interface TradeCoverage extends TradeRange { complete: boolean; archived: boolean; fallbackArchive?: boolean }

interface PendingDay {
  abort: AbortController
  message: string
  report: (message: string) => void
  done: Promise<string>
}
const wakeIntervalMs = 60_000
const liveSettlementMs = 250
const cacheWorker = { owner: 'q761505855', repository: 'crypto_contract_workstation' }

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
  private recent?: OkxRecentTrades
  private active?: OrderFlowMapping
  private context: ReplayContext | null = null
  private selection = ''
  private readonly pending = new Map<string, PendingDay>()
  private readonly archiveDownloads = new AbortController()
  private readonly downloaded = new Map<string, Set<number>>()
  private released = false
  private readonly nextWake = new Map<string, number>()
  private pendingLiveUpdate?: ReturnType<typeof setTimeout>

  constructor(private readonly cloud: GitHubContentsClient, private readonly changed: (reset?: boolean, affected?: TradeRange) => void,
    private readonly archive = new BybitArchive(cloud.getTarget()), private readonly now = Date.now,
    private readonly okxArchive = new OkxArchive(cloud.getTarget(), fetch, now)) {}

  get mapping(): OrderFlowMapping | undefined { return this.active }
  get replaying(): boolean { return this.context !== null }
  get downloadedDays(): Iterable<number> { return this.active && this.downloaded.get(this.active.symbol) || [] }
  get archiveCacheKey(): string {
    const { owner, repository, branch, root } = this.cloud.getTarget()
    const primary = this.active?.okx
    if (primary) return JSON.stringify([owner, repository, branch, root, 'okx-first', primary.symbol, primary.contractValue, this.active?.bybit?.symbol])
    return JSON.stringify([owner, repository, branch, root, this.active?.bybit?.symbol])
  }
  get tradeCursorUs(): number {
    if (this.context) return replayConfirmedUntil(this.context) * 1000
    if (this.active?.okx) return (this.now() - liveSettlementMs) * 1000
    const last = this.live?.lastTradeUs
    return last === undefined ? this.now() * 1000 + 1 : Math.min(last + 1, (this.now() - liveSettlementMs) * 1000)
  }

  async hasArchivedDay(start: number): Promise<boolean> {
    const mapping = this.active
    if (!mapping) return false
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

  hasRecentOkxCoverage(hour: number, untilUs: number): boolean {
    if (this.active?.okx && this.okxArchive.isCachedHour(this.active.okx, hour)) return false
    const slice = this.recent?.read(hour)
    return !!slice && slice.untilUs >= untilUs
  }

  async readArchivedHour(start: number): Promise<BybitTrade[] | null> {
    const mapping = this.active
    const primary = mapping?.okx && await this.okxArchive.loadHour(mapping.okx, start).catch(() => null)
    if (primary !== null && primary !== undefined) return primary
    return mapping?.bybit ? this.archive.loadHour(mapping.bybit.symbol, start).catch(() => null) : null
  }

  isOkxArchiveCachedAt(hour: number): Promise<boolean> {
    return this.active?.okx ? this.okxArchive.hasHour(this.active.okx, hour) : Promise.resolve(false)
  }

  requestRecentHours(start: number, end: number): void {
    const recent = this.recent
    const instrument = this.active?.okx
    if (!recent || !instrument) return
    const hourStart = Math.max(Math.floor(start / BYBIT_HOUR_MS) * BYBIT_HOUR_MS,
      Math.floor((this.now() - 3 * BYBIT_DAY_MS) / BYBIT_HOUR_MS) * BYBIT_HOUR_MS)
    for (let hour = hourStart; hour < end; hour += BYBIT_HOUR_MS) {
      if (!recent.applies(hour)) continue
      const untilUs = Math.min(hour + BYBIT_HOUR_MS, Math.floor((this.now() - liveSettlementMs) / 15_000) * 15_000) * 1000
      void this.okxArchive.hasHour(instrument, hour).then(cached => {
        if (!cached && recent === this.recent) recent.request(hour, untilUs)
      })
    }
  }

  readReplayLive({ fromUs, untilUs }: TradeRange): BybitTrade[] {
    if (this.recent) {
      const result: BybitTrade[] = []
      const from = Math.max(fromUs, this.capturedFromUs)
      for (let hour = Math.floor(from / 1000 / BYBIT_HOUR_MS) * BYBIT_HOUR_MS; hour * 1000 < untilUs; hour += BYBIT_HOUR_MS) {
        const startUs = Math.max(from, hour * 1000)
        const endUs = Math.min(untilUs, (hour + BYBIT_HOUR_MS) * 1000)
        const rows = this.recent.read(hour)?.trades ?? []
        for (const trade of mergeOkxTrades(rows.slice(lowerBound(rows, startUs), lowerBound(rows, endUs)),
          this.okxLive?.read(startUs, endUs) ?? [])) result.push(trade)
      }
      return result
    }
    return this.live?.read(fromUs, untilUs) ?? []
  }

  get capturedFromUs(): number {
    return Math.min(this.recent?.earliestUs ?? Infinity, this.okxLive?.coverageStartUs ?? Infinity, this.live?.coverageStartUs ?? Infinity)
  }
  get capturedUntilUs(): number {
    return Math.max(this.recent?.latestUs ?? 0, (this.okxLive?.lastTradeUs ?? this.live?.lastTradeUs ?? -1) + 1)
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
        this.recent?.close()
        this.recent = mapping?.okx && new OkxRecentTrades(mapping.okx,
          (hour, ready) => this.changed(ready, ready ? { fromUs: hour * 1000, untilUs: (hour + BYBIT_HOUR_MS) * 1000 } : undefined), this.now)
        clearTimeout(this.pendingLiveUpdate)
      }
      this.selection = key
      this.active = mapping
    }
    this.changed(reset)
  }

  release(): void {
    this.released = true
    this.archiveDownloads.abort()
    this.live?.close()
    this.live = undefined
    this.okxLive?.close()
    this.recent?.close()
    clearTimeout(this.pendingLiveUpdate)
    for (const pending of this.pending.values()) pending.abort.abort()
    this.pending.clear()
  }

  async visitTrades({ fromUs, untilUs }: TradeRange, accept: (trade: BybitTrade) => void, signal: AbortSignal,
    reportCoverage?: (coverage: TradeCoverage) => void): Promise<boolean> {
    const primary = this.active
    if (primary?.okx) return this.visitOkxTrades(primary, { fromUs, untilUs }, accept, signal, reportCoverage)
    const mapping = primary?.bybit
    if (!mapping) return false
    if (!this.context) this.openBybitLive(mapping.symbol)
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

  private openBybitLive(symbol: BybitSymbol): void {
    if (this.live) return
    const live = new BybitLiveTrades(symbol, () => this.changed())
    live.subscribe((rows, rebuilt, fromUs) => {
      const first = fromUs ?? rows[0]?.timeUs
      const changedPast = first !== undefined && (rebuilt || !!this.active?.okx) && first < this.tradeCursorUs
      this.changed(changedPast, changedPast ? { fromUs: first, untilUs: Infinity } : undefined)
      clearTimeout(this.pendingLiveUpdate)
      this.pendingLiveUpdate = setTimeout(() => this.changed(), liveSettlementMs + 1)
    })
    this.live = live
    live.open()
  }

  private async visitOkxTrades(mapping: OrderFlowMapping, range: TradeRange, accept: (trade: BybitTrade) => void, signal: AbortSignal,
    reportCoverage?: (coverage: TradeCoverage) => void): Promise<boolean> {
    const instrument = mapping.okx!
    const recent = this.recent
    if (!this.context && !this.okxLive) {
      this.okxLive = new OkxLiveTrades(instrument, fromUs => {
        if (this.okxLive?.failed && mapping.bybit && !this.context) this.openBybitLive(mapping.bybit.symbol)
        else if (this.live && !this.okxLive?.gap) {
          fromUs = Math.min(fromUs ?? Infinity, this.live.coverageStartUs ?? Infinity)
          this.live.close()
          this.live = undefined
        }
        this.changed(fromUs !== undefined, fromUs === undefined ? undefined : { fromUs, untilUs: Infinity })
        clearTimeout(this.pendingLiveUpdate)
        this.pendingLiveUpdate = setTimeout(() => this.changed(), liveSettlementMs + 1)
      }, this.now)
      this.okxLive.open()
    }
    const end = Math.min(range.untilUs, this.tradeCursorUs)
    const live = this.okxLive
    const requests: [number, number][] = []
    let complete = true
    for (let hour = Math.floor(range.fromUs / 1000 / BYBIT_HOUR_MS) * BYBIT_HOUR_MS; hour * 1000 < end; hour += BYBIT_HOUR_MS) {
      signal.throwIfAborted()
      const fromUs = Math.max(hour * 1000, range.fromUs)
      const untilUs = Math.min((hour + BYBIT_HOUR_MS) * 1000, end)
      const okxAvailable = okxArchiveDay(hour) >= instrument.firstDay
      const archive = okxAvailable ? await this.okxArchive.loadHour(instrument, hour).catch(() => null) : null
      let rows = archive
      let archived = archive !== null
      let covered = archived
      let fallbackArchive = false
      if (!archive) {
        const rest = recent?.read(hour)
        const liveStart = !live || live.gap ? Infinity : live.coverageStartUs
        const restEnd = Math.min(untilUs, liveStart,
          Math.floor((this.now() - liveSettlementMs) / 5000) * 5000 * 1000)
        if (recent?.applies(hour) && fromUs < restEnd && (rest?.untilUs ?? 0) < restEnd) requests.push([hour, restEnd])
        const socketRows = live?.read(fromUs, untilUs) ?? []
        const fallback = live?.failed && !socketRows.length ? this.live : undefined
        const fallbackStart = Math.max(fromUs, rest?.untilUs ?? fromUs)
        const fallbackRows = fallback?.read(fallbackStart, untilUs) ?? []
        if (rest || socketRows.length || liveStart < untilUs || fallbackRows.length) {
          const recentRows = rest?.trades ?? []
          rows = mergeOkxTrades(recentRows.slice(lowerBound(recentRows, fromUs), lowerBound(recentRows, untilUs)), socketRows)
          if (fallbackRows.length) {
            rows = rows.filter(trade => trade.timeUs < fallbackStart).concat(fallbackRows)
          }
          covered = liveStart <= fromUs || (!!rest && rest.untilUs >= Math.min(untilUs, liveStart))
          covered ||= !!fallback && !fallback.gap && (rest !== undefined || fallbackStart === fromUs) &&
            (fallback.coverageStartUs ?? Infinity) <= fallbackStart && (fallback.lastTradeUs ?? 0) + 1 >= untilUs
        } else if (mapping.bybit) {
          rows = await this.archive.loadHour(mapping.bybit.symbol, hour).catch(() => null)
          covered = rows !== null
          archived = covered
          fallbackArchive = covered && okxAvailable
        }
      }
      signal.throwIfAborted()
      if (rows) {
        const stop = lowerBound(rows, untilUs)
        for (let index = lowerBound(rows, fromUs); index < stop; index++) accept(rows[index])
      }
      complete &&= covered
      reportCoverage?.({ fromUs, untilUs, complete: covered, archived, fallbackArchive })
    }
    for (const [hour, untilUs] of requests) recent?.request(hour, untilUs)
    return complete
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
    if (last >= bybitDay(this.now())) throw new Error(`${last} UTC 日档须等该日结束后下载`)
    if (mapping.okx) return this.downloadOkxRange(mapping, from, to, report)
    const symbol = mapping.bybit!.symbol
    if (first < bybitFirstDay(symbol)) throw new Error(`Bybit 未提供 ${symbol} ${first} UTC 逐笔归档`)
    return from === to ? this.requestDay(symbol, first, report) : this.downloadRange(symbol, from, to, report)
  }

  private async downloadOkxRange(mapping: OrderFlowMapping, from: number, to: number, report: (message: string) => void): Promise<string> {
    const signal = this.archiveDownloads.signal
    const total = 1 + (to - from) / BYBIT_DAY_MS
    const instrument = mapping.okx!
    let okx = 0
    let bybit = 0
    const unavailable: string[] = []
    for (let batch = from; batch <= to; batch += 8 * BYBIT_DAY_MS) {
      signal.throwIfAborted()
      const starts = Array.from({ length: Math.min(8, 1 + (to - batch) / BYBIT_DAY_MS) },
        (_, index) => batch + index * BYBIT_DAY_MS)
      await Promise.all(starts.map(async start => {
        const day = bybitDay(start)
        const progress = (message: string) => report(`${(start - from) / BYBIT_DAY_MS + 1}/${total} 天 · ${message}`)
        const published = (ref?: string) => this.okxArchive.hasCloudDay(instrument, day, ref)
        let primaryError: unknown
        try {
          if (day >= instrument.firstDay && await ensureTradeDay('OKX', published, this.cloud, instrument.symbol, day,
            progress, signal, () => this.wakeWorker('okx-trades-requested'))) {
            okx++
            this.markDownloaded(mapping.symbol, start)
            return
          }
        } catch (error) {
          signal.throwIfAborted()
          primaryError = error
        }
        if (mapping.bybit && day >= bybitFirstDay(mapping.bybit.symbol)) {
          try {
            await this.requestDay(mapping.bybit.symbol, day, progress, published)
            if (await published().catch(() => false)) okx++
            else bybit++
            this.markDownloaded(mapping.symbol, start)
            return
          } catch (error) {
            signal.throwIfAborted()
            if (from === to) throw (primaryError ?? error)
          }
        } else if (from === to && primaryError) throw primaryError
        unavailable.push(day)
      }))
    }
    return `已缓存 OKX ${okx} 天 · Bybit 回退 ${bybit} 天${unavailable.length ? ` · 日期暂不可用 ${unavailable.sort().join('、')}` : ''}`
  }

  private markDownloaded(symbol: string, start: number): void {
    const downloaded = this.downloaded.get(symbol) ?? new Set<number>()
    downloaded.add(start)
    this.downloaded.set(symbol, downloaded)
    if (this.active?.symbol === symbol) this.changed(true, {
      fromUs: start * 1000,
      untilUs: (start + BYBIT_DAY_MS) * 1000,
      replaceArchive: true,
    })
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
      const start = bybitDayStart(day)
      this.markDownloaded(symbol, start)
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
