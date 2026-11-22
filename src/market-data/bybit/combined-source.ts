import type { SymbolInfo } from '@klinecharts/pro'
import type { GitHubContentsClient } from '../../github-sync/github-client'
import { replayConfirmedUntil, type ReplayContext } from '../../replay/models'
import { BybitArchive } from './archive'
import { ensureTradeDay } from './archive-requests'
import { BybitLiveTrades } from './live'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, bybitDay, bybitDayStart, bybitFirstDay, type BybitSymbol, type BybitTrade } from './trades'
import { OkxArchive, okxArchiveDay } from '../okx/archive'
import { OkxLiveTrades, readOkxTradePages, readOkxTradePagesForward, type OkxTradePage } from '../okx/live'
import { compareTrades, mergeOkxTrades, orderFlowMapping, type OrderFlowMapping } from '../okx/trades'

export interface TradeRange { fromUs: number; untilUs: number; replaceArchive?: boolean; historyPage?: boolean }
export interface TradeCoverage extends TradeRange { complete: boolean; archived: boolean; fallbackArchive?: boolean }
export interface TradeDownloadAnchor { candleTime: number; until: number }

interface PendingDay {
  abort: AbortController
  message: string
  report: (message: string) => void
  done: Promise<string>
}
type ArchiveVenue = 'OKX 日档' | 'Bybit 日档'
const wakeIntervalMs = 60_000
const liveSettlementMs = 250
const cacheWorker = { owner: 'q761505855', repository: 'crypto_contract_workstation' }

const hourStart = (ms: number) => Math.floor(ms / BYBIT_HOUR_MS) * BYBIT_HOUR_MS
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
  private readonly downloaded = new Map<string, Map<number, ArchiveVenue>>()
  private readonly history = new Map<string, Map<number, OkxTradePage[]>>()
  private readonly anchors = new Map<string, TradeDownloadAnchor>()
  private readonly nextWake = new Map<string, number>()
  private pendingLiveUpdate?: ReturnType<typeof setTimeout>

  constructor(private readonly cloud: GitHubContentsClient, private readonly changed: (reset?: boolean, affected?: TradeRange) => void,
    private readonly archive = new BybitArchive(cloud.getTarget()), private readonly now = Date.now,
    private readonly okxArchive = new OkxArchive(cloud.getTarget(), fetch, now)) {}

  get mapping(): OrderFlowMapping | undefined { return this.active }
  get replaying(): boolean { return this.context !== null }
  get downloadedDays(): Iterable<number> { return this.active && this.downloaded.get(this.active.symbol)?.keys() || [] }
  get downloadAnchorUs(): number | undefined {
    const time = this.active && this.anchors.get(this.active.symbol)?.until
    return time === undefined ? undefined : time * 1000
  }

  historyPages(hour: number): readonly OkxTradePage[] {
    return this.activeHistory?.get(hour) ?? []
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
    return this.isArchiveRequested(hour) ||
      ((hour + BYBIT_HOUR_MS) * 1000 > this.liveStartUs &&
        Math.max(this.okxLive?.lastTradeUs ?? -1, this.live?.lastTradeUs ?? -1) >= hour * 1000)
  }

  private get activeHistory(): Map<number, OkxTradePage[]> | undefined {
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
    let cursor = fromUs
    for (const page of this.historyPages(hourStart(fromUs / 1000))) {
      if (page.untilUs <= cursor) continue
      if (page.fromUs > cursor) break
      cursor = page.untilUs
      if (cursor >= untilUs) return true
    }
    const socket = this.okxLive?.gap === false ? this.okxLive : this.live?.gap === false ? this.live : undefined
    return !!socket && (socket.lastTradeUs ?? -1) + 1 >= untilUs && (socket.coverageStartUs ?? Infinity) <= cursor
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

  readSocketTrades(fromUs: number, untilUs: number): BybitTrade[] {
    const primary = this.okxLive?.read(fromUs, untilUs) ?? []
    const fallback = this.live?.read(fromUs, untilUs) ?? []
    if (!fallback.length || !this.okxLive) return primary.length ? primary : fallback
    const primaryResumed = this.okxLive.gap ? Infinity : this.okxLive.coverageStartUs
    return primary.concat(fallback.filter(trade => trade.timeUs < primaryResumed)).sort(compareTrades)
  }

  private readCapturedHour(hour: number, fromUs: number, untilUs: number): BybitTrade[] {
    const pages = this.historyPages(hour)
    if (!pages.length) return this.readSocketTrades(fromUs, untilUs)
    const result: BybitTrade[] = []
    let cursor = fromUs
    for (const page of pages) {
      if (page.untilUs <= cursor) continue
      if (page.fromUs >= untilUs) break
      for (const trade of this.readSocketTrades(cursor, Math.min(untilUs, page.fromUs))) result.push(trade)
      const end = Math.min(untilUs, page.untilUs)
      const selected = page.rows.slice(lowerBound(page.rows, Math.max(cursor, page.fromUs)), lowerBound(page.rows, end))
      // A published page owns its interval. Socket data remains available in the gaps.
      for (const trade of selected) result.push(trade)
      cursor = end
    }
    for (const trade of this.readSocketTrades(cursor, untilUs)) result.push(trade)
    return result
  }

  get capturedFromUs(): number {
    return this.liveStartUs
  }

  get capturedUntilUs(): number {
    return Math.max(this.okxLive?.lastTradeUs ?? -1, this.live?.lastTradeUs ?? -1) + 1
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
    reportCoverage?: (coverage: TradeCoverage) => void, includeHistory = true): Promise<boolean> {
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
        const rows = includeHistory ? this.readCapturedHour(hour, start, stop) : this.readSocketTrades(start, stop)
        for (const trade of rows) accept(trade)
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
      this.okxLive = new OkxLiveTrades(instrument, (fromUs, trade) => {
        if (this.okxLive?.failed && mapping.bybit && !this.context) this.openBybitLive(mapping.bybit.symbol)
        else if (this.live && !this.okxLive?.gap) this.live.close()
        this.liveChanged(trade && this.mergeLiveIntoHistory(trade) ? undefined : fromUs)
      }, this.now)
      this.okxLive.open()
    }
  }

  private mergeLiveIntoHistory(trade: BybitTrade): boolean {
    const pages = this.activeHistory?.get(hourStart(trade.timeUs / 1000))
    const index = pages?.findIndex(page => page.fromUs <= trade.timeUs && trade.timeUs < page.untilUs) ?? -1
    if (!pages || index < 0) return false
    const page = pages[index]
    if (!page.rows.some(row => row.id === trade.id)) {
      pages[index] = { ...page, rows: mergeOkxTrades(page.rows, [trade]) }
      this.changed(true, { fromUs: trade.timeUs, untilUs: trade.timeUs + 1, historyPage: true })
    }
    return true
  }

  downloadDays(start: string, end: string, report: (message: string) => void, anchor?: TradeDownloadAnchor): Promise<string> {
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
    const snapshot = { candleTime: anchor?.candleTime ?? now, until: Math.min(anchor?.until ?? now, now) }
    this.anchors.set(mapping.symbol, snapshot)
    return this.downloadRange(mapping, from, to, now, snapshot.until * 1000, report)
  }

  private async downloadRange(mapping: OrderFlowMapping, from: number, to: number, now: number, pivot: number,
    report: (message: string) => void): Promise<string> {
    const signal = this.archiveDownloads.signal
    const total = 1 + (to - from) / BYBIT_DAY_MS
    const earliest = firstOkxHistoryDay(now)
    const today = dayStart(now)
    const instrument = mapping.okx
    const counts = { 'OKX 接口': 0, 'OKX 日档': 0, 'Bybit 日档': 0 }
    const unavailable: string[] = []
    const firstRest = instrument ? Math.max(from, earliest, bybitDayStart(instrument.firstDay)) : to + BYBIT_DAY_MS
    const recentDays = this.orderedDays(firstRest, to, pivot)
    const cachedDays = new Map<number, Promise<boolean>>()
    const checkCachedDay = (start: number): Promise<boolean> => {
      if (!instrument || start >= today) return Promise.resolve(false)
      const existing = cachedDays.get(start)
      if (existing) return existing
      const checking = this.okxArchive.hasCloudDay(instrument, bybitDay(start)).catch(() => false).then(cached => {
        signal.throwIfAborted()
        if (cached) {
          this.markDownloaded(mapping.symbol, start, 'OKX 日档')
          counts['OKX 日档']++
        }
        return cached
      })
      cachedDays.set(start, checking)
      return checking
    }

    const fallbacks: Promise<void>[] = []
    const load = async (start: number, useRest: boolean) => {
      signal.throwIfAborted()
      const day = bybitDay(start)
      const progress = (message: string) => report(`${(start - from) / BYBIT_DAY_MS + 1}/${total} 天 · ${message}`)
      try {
        if (instrument && useRest) {
          if (start < today) {
            progress(`正在检查 OKX ${day} UTC 日档缓存…`)
            if (await checkCachedDay(start)) return
          }
          try {
            const untilUs = Math.min(start + BYBIT_DAY_MS, now) * 1000
            progress(`正在读取 OKX ${day} UTC 历史逐笔…`)
            let count = 0
            let lastReport = 0
            const reportPage = (page: OkxTradePage) => {
              count += page.rows.length
              this.publishHistoryPage(mapping.symbol, page)
              if (this.now() - lastReport >= 350) {
                lastReport = this.now()
                progress(`OKX ${day} UTC 已读取 ${count.toLocaleString()} 笔…`)
              }
            }
            const split = Math.min(untilUs, Math.max(start * 1000, pivot))
            await this.readHistoryRange(mapping.symbol, instrument, start * 1000, split, false, signal, reportPage)
            await this.readHistoryRange(mapping.symbol, instrument, split, untilUs, true, signal, reportPage)
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
    const checkRecent = async () => {
      for (let batch = 0; batch < recentDays.length; batch += 8) {
        await Promise.all(recentDays.slice(batch, batch + 8).map(checkCachedDay))
      }
    }
    const loadArchived = async () => {
      const oldDays = this.orderedDays(from, Math.min(to, firstRest - BYBIT_DAY_MS), pivot)
      for (let batch = 0; batch < oldDays.length; batch += 8) {
        await Promise.all(oldDays.slice(batch, batch + 8).map(start => load(start, false)))
      }
    }
    const loadRecent = async () => {
      for (const start of recentDays) {
        if (await load(start, true) !== false) continue
        if (from === to) { await load(start, false); return }
        fallbacks.push(load(start, false).then(() => undefined))
        if (fallbacks.length === 8) await Promise.all(fallbacks.splice(0))
      }
      await Promise.all(fallbacks)
    }
    await Promise.all([loadArchived(), checkRecent(), loadRecent()])
    const summary = Object.entries(counts).filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count} 天`)
    if (unavailable.length) summary.push(`日期暂不可用 ${unavailable.sort().join('、')}`)
    return summary.join(' · ')
  }

  private orderedDays(from: number, to: number, pivot: number): number[] {
    const days: number[] = []
    const anchor = dayStart(pivot / 1000)
    for (let day = Math.min(to, anchor); day >= from; day -= BYBIT_DAY_MS) days.push(day)
    for (let day = Math.max(from, anchor + BYBIT_DAY_MS); day <= to; day += BYBIT_DAY_MS) days.push(day)
    return days
  }

  private missingHistoryRanges(hours: Map<number, OkxTradePage[]> | undefined, fromUs: number, untilUs: number): TradeRange[] {
    if (fromUs >= untilUs) return []
    const gaps: TradeRange[] = []
    let cursor = fromUs
    for (let hour = hourStart(fromUs / 1000); hour * 1000 < untilUs; hour += BYBIT_HOUR_MS) {
      for (const page of hours?.get(hour) ?? []) {
        if (page.untilUs <= cursor) continue
        if (page.fromUs >= untilUs) break
        if (page.fromUs > cursor) gaps.push({ fromUs: cursor, untilUs: page.fromUs })
        cursor = page.untilUs
      }
    }
    if (cursor < untilUs) gaps.push({ fromUs: cursor, untilUs })
    return gaps
  }

  private async readHistoryRange(symbol: string, instrument: NonNullable<OrderFlowMapping['okx']>, fromUs: number, untilUs: number,
    forward: boolean, signal: AbortSignal, offer: (page: OkxTradePage) => void): Promise<void> {
    const gaps = this.missingHistoryRanges(this.history.get(symbol), fromUs, untilUs)
    if (!forward) gaps.reverse()
    const read = forward ? readOkxTradePagesForward : readOkxTradePages
    for (const gap of gaps) {
      for await (const page of read(instrument, gap.fromUs, gap.untilUs, signal)) {
        signal.throwIfAborted()
        offer(page)
      }
    }
  }

  private publishHistoryPage(symbol: string, page: OkxTradePage): void {
    const day = dayStart(page.fromUs / 1000)
    const downloaded = this.downloaded.get(symbol)
    if (downloaded?.get(day) === 'OKX 日档') return
    if (downloaded?.delete(day)) this.invalidateDay(symbol, day)
    if (!this.history.has(symbol)) this.history.set(symbol, new Map())
    const hours = this.history.get(symbol)!
    for (const gap of this.missingHistoryRanges(hours, page.fromUs, page.untilUs)) {
      for (let fromUs = gap.fromUs; fromUs < gap.untilUs;) {
        const hour = hourStart(fromUs / 1000)
        const untilUs = Math.min(gap.untilUs, (hour + BYBIT_HOUR_MS) * 1000)
        const pages = hours.get(hour) ?? []
        const index = pages.findIndex(existing => existing.fromUs >= fromUs)
        const rows = page.rows.slice(lowerBound(page.rows, fromUs), lowerBound(page.rows, untilUs))
        const live = this.active?.symbol === symbol ? this.okxLive?.read(fromUs, untilUs) : undefined
        const entry = { fromUs, untilUs, rows: live?.length ? mergeOkxTrades(rows, live) : rows }
        pages.splice(index < 0 ? pages.length : index, 0, entry)
        hours.set(hour, pages)
        fromUs = untilUs
      }
      if (this.active?.symbol === symbol) this.changed(true, { ...gap, historyPage: true })
    }
  }

  private async downloadArchive(mapping: OrderFlowMapping, start: number, progress: (message: string) => void,
    signal: AbortSignal): Promise<ArchiveVenue> {
    const instrument = mapping.okx
    const day = bybitDay(start)
    const published = (ref?: string) => instrument ? this.okxArchive.hasCloudDay(instrument, day, ref) : Promise.resolve(false)
    let primaryError: unknown
    if (instrument && day >= instrument.firstDay) {
      try {
        if (await ensureTradeDay('OKX', published, this.cloud, instrument.symbol, day, progress, signal,
          () => this.wakeWorker('okx-trades-requested'))) {
          this.markDownloaded(mapping.symbol, start, 'OKX 日档')
          return 'OKX 日档'
        }
      } catch (error) {
        signal.throwIfAborted()
        primaryError = error
      }
    }
    if (mapping.bybit && day >= bybitFirstDay(mapping.bybit.symbol)) {
      await this.requestDay(mapping.bybit.symbol, day, progress, published)
      const venue = await published().catch(() => false) ? 'OKX 日档' : 'Bybit 日档'
      this.markDownloaded(mapping.symbol, start, venue)
      return venue
    }
    throw primaryError ?? new Error(`${mapping.symbol} ${day} UTC 暂无逐笔归档`)
  }

  private markDownloaded(symbol: string, start: number, venue: ArchiveVenue): void {
    const downloaded = this.downloaded.get(symbol) ?? new Map<number, ArchiveVenue>()
    if (downloaded.get(start) === 'OKX 日档' && venue === 'Bybit 日档') return
    downloaded.set(start, venue)
    this.downloaded.set(symbol, downloaded)
    const hours = this.history.get(symbol)
    for (let hour = start; hour < start + BYBIT_DAY_MS; hour += BYBIT_HOUR_MS) hours?.delete(hour)
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
