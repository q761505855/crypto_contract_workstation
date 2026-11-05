import type { MarketDataStore } from '../storage/market-data-store'
import type { BinanceArchiveClient } from './archive-client'
import { aggregateMinuteCandles } from './aggregate-candles'
import { expandHistoryRange, historyMonths } from './history-ranges'
import { alignOpenTime, nextOpenTime } from './intervals'
import { findMissingRanges } from './gaps'
import type { CandleKind, MarketCandle, MarketSymbol } from './models'
import type { BinanceRestClient } from './rest-client'
import type { LoadCandlesOptions } from './market-data-service'

const MINUTE = 60_000
const DAY = 86_400_000
const PENDING_KEY = 'marketData.pendingCloudUploads.v1'

export interface HistoryCloudStore {
  canWrite?(): boolean
  loadMonth(symbol: string, year: number, month: number, options?: { signal?: AbortSignal }): Promise<{
    tradeCandles: MarketCandle[]; markCandles: MarketCandle[]; symbolInfo?: MarketSymbol
  } | null>
  saveMonth(symbol: string, year: number, month: number, trade: readonly MarketCandle[], mark: readonly MarketCandle[], symbolInfo?: MarketSymbol): Promise<void>
}

export interface HistoryServices {
  archives: Pick<BinanceArchiveClient, 'loadMonth' | 'loadDay'>
  cloud?: HistoryCloudStore
  now?: () => number
  pendingStorage?: Pick<Storage, 'getItem' | 'setItem'>
}

export interface PrepareHistoryOptions extends LoadCandlesOptions {
  kinds?: readonly CandleKind[]
}

interface PendingMonth { symbol: string; year: number; month: number; revision: number }

/** Canonical minute storage. Display periods never become separate downloads. */
export class MinuteHistory {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly cloudReads = new Map<string, Promise<void>>()
  private readonly cloudReadTimes = new Map<string, number>()
  private readonly pending = new Map<string, PendingMonth>()
  private uploading: Promise<void> | null = null
  private revision = 0
  private lastWarning?: (message: string) => void

  constructor(
    private readonly client: BinanceRestClient,
    private readonly store: MarketDataStore,
    private readonly services: HistoryServices,
  ) {
    try {
      const saved: unknown = JSON.parse(services.pendingStorage?.getItem(PENDING_KEY) ?? '[]')
      if (Array.isArray(saved)) for (const entry of saved) {
        if (entry && /^[A-Z0-9]+$/.test(entry.symbol) && Number.isInteger(entry.year) && entry.year >= 2017 &&
          Number.isInteger(entry.month) && entry.month >= 1 && entry.month <= 12) {
          this.pending.set(this.monthKey(entry.symbol, entry.year, entry.month), { ...entry, revision: ++this.revision })
        }
      }
    } catch { /* Corrupt device-local queue must not prevent opening the chart. */ }
  }

  private now(): number { return (this.services.now ?? Date.now)() }
  private monthKey(symbol: string, year: number, month: number): string { return `${symbol}/${year}/${month}` }
  private async local(kind: CandleKind, symbol: string, from: number, to: number): Promise<MarketCandle[]> {
    if (from > to) return []
    return (await this.store.getCandles(kind, symbol, '1m', from, to))
      .filter((candle) => candle.isClosed && candle.closeTime < this.now())
      .sort((a, b) => a.openTime - b.openTime)
  }

  private async saveRows(kind: CandleKind, rows: readonly MarketCandle[]): Promise<void> {
    if (rows.length === 0) return
    const existing = new Map((await this.store.getCandles(kind, rows[0].symbol, '1m', rows[0].openTime, rows.at(-1)!.openTime))
      .map((row) => [row.openTime, row]))
    const changed = rows.filter((row) => {
      const prior = existing.get(row.openTime)
      return prior === undefined || (Object.keys(row) as Array<keyof MarketCandle>).some((field) => prior[field] !== row[field])
    })
    if (changed.length > 0) await this.store.putCandles(kind, changed)
  }

  async cached(kind: CandleKind, symbol: string, timeframe: string, from: number, to: number, includeCurrent = false): Promise<MarketCandle[]> {
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('本地行情读取时间必须为有效时间戳')
    if (from > to || to < 0) return []
    symbol = symbol.toUpperCase()
    const first = Math.max(0, alignOpenTime(from, timeframe, 'ceil'))
    const last = Math.min(nextOpenTime(alignOpenTime(to, timeframe, 'floor'), timeframe) - MINUTE,
      alignOpenTime(this.now(), '1m', 'floor') - MINUTE)
    const minutes = await this.local(kind, symbol, first, last)
    const canonical = aggregateMinuteCandles(minutes, timeframe, includeCurrent ? alignOpenTime(this.now(), '1m', 'floor') : undefined)
    const byTime = new Map<number, MarketCandle>()
    // Older archives remain readable, but cannot substitute for minute coverage.
    if (timeframe !== '1m') for (const candle of await this.store.getCandles(kind, symbol, timeframe, first, to)) {
      if (candle.isClosed && candle.closeTime < this.now()) byTime.set(candle.openTime, candle)
    }
    for (const candle of canonical) byTime.set(candle.openTime, candle)
    return [...byTime.values()].filter((candle) => candle.openTime >= from && candle.openTime <= to)
      .sort((a, b) => a.openTime - b.openTime)
  }

  async load(kind: CandleKind, symbol: string, timeframe: string, from: number, to: number, options: LoadCandlesOptions = {}): Promise<MarketCandle[]> {
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('行情请求时间必须为有效时间戳')
    symbol = symbol.toUpperCase()
    if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('交易对格式无效')
    if (from > to || to < 0) return []
    options.signal?.throwIfAborted()
    this.lastWarning = options.onWarning ?? this.lastWarning
    // A cached jump must not wait behind live REST or another month's download.
    const cachedFrom = Math.max(0, alignOpenTime(from, timeframe, 'ceil'))
    const visibleUntil = alignOpenTime(this.now(), '1m', 'floor')
    const cachedTo = Math.min(nextOpenTime(alignOpenTime(to, timeframe, 'floor'), timeframe) - MINUTE, visibleUntil - MINUTE)
    if (cachedFrom <= cachedTo) {
      const local = await this.local(kind, symbol, cachedFrom, cachedTo)
      options.signal?.throwIfAborted()
      if (findMissingRanges(local, '1m', cachedFrom, cachedTo).length === 0) {
        return aggregateMinuteCandles(local, timeframe, visibleUntil)
          .filter((candle) => candle.openTime >= from && candle.openTime <= to)
      }
    }
    const previous = this.queues.get(symbol) ?? Promise.resolve()
    const request = previous.catch(() => undefined).then(async () => {
      options.signal?.throwIfAborted()
      const info = (await this.store.getSymbols()).find((item) => item.symbol === symbol)
      const first = Math.max(0, alignOpenTime(from, timeframe, 'ceil'), alignOpenTime(info?.onboardDate ?? 0, '1m', 'ceil'))
      const last = Math.min(nextOpenTime(alignOpenTime(to, timeframe, 'floor'), timeframe) - MINUTE,
        alignOpenTime(this.now(), '1m', 'floor') - MINUTE)
      if (first > last) return []
      try {
        for (const month of historyMonths(first, last)) {
          await this.fillMonth(kind, symbol, month.year, month.month, month.from, month.to, options)
        }
      } catch (error) {
        if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
        const existing = await this.cached(kind, symbol, timeframe, from, to, true)
        if (existing.length === 0) throw error
        options.onWarning?.(`历史归档未完整取得，当前显示本地缓存：${error instanceof Error ? error.message : String(error)}`)
      }
      return this.cached(kind, symbol, timeframe, from, to, true)
    })
    this.queues.set(symbol, request)
    try { return await request } finally { if (this.queues.get(symbol) === request) this.queues.delete(symbol) }
  }

  private async fillMonth(kind: CandleKind, symbol: string, year: number, month: number, from: number, to: number, options: LoadCandlesOptions): Promise<void> {
    const key = this.monthKey(symbol, year, month)
    let gaps = findMissingRanges(await this.local(kind, symbol, from, to), '1m', from, to)
    if (gaps.length === 0) return
    const status = (source: string) => options.onStatus?.(`${symbol} ${year}-${String(month).padStart(2, '0')} ${kind === 'trade' ? '普通价格' : '标记价格'}：${source}`)
    if (this.services.cloud) {
      let read = this.cloudReads.get(key)
      if ((this.cloudReadTimes.get(key) ?? 0) + 60_000 < this.now()) {
        this.cloudReads.delete(key)
        read = undefined
      }
      if (read === undefined) {
        status('检查云端归档…')
        read = (async () => {
          try {
            const remote = await this.services.cloud!.loadMonth(symbol, year, month, { signal: options.signal })
            options.signal?.throwIfAborted()
            if (remote) {
              if (remote.symbolInfo) await this.store.putSymbols([remote.symbolInfo])
              await this.saveRows('trade', remote.tradeCandles)
              await this.saveRows('mark', remote.markCandles)
            }
          } catch (error) {
            this.cloudReads.delete(key)
            this.cloudReadTimes.delete(key)
            if (options.signal?.aborted) throw error
            options.onWarning?.(`云端归档读取失败，将检查币安归档：${error instanceof Error ? error.message : String(error)}`)
          }
        })()
        this.cloudReads.set(key, read)
        this.cloudReadTimes.set(key, this.now())
      }
      try { await read } catch (error) {
        this.cloudReads.delete(key)
        this.cloudReadTimes.delete(key)
        throw error
      }
      gaps = findMissingRanges(await this.local(kind, symbol, from, to), '1m', from, to)
      if (gaps.length === 0) return
    }
    const currentMonth = alignOpenTime(this.now(), '1M', 'floor')
    if (Date.UTC(year, month - 1) < currentMonth) {
      status('下载并校验月归档…')
      const archived = await this.services.archives.loadMonth(kind, symbol, year, month, { signal: options.signal })
      options.signal?.throwIfAborted()
      if (archived !== null) {
        await this.saveRows(kind, archived)
        this.queueUpload(symbol, year, month)
        gaps = findMissingRanges(await this.local(kind, symbol, from, to), '1m', from, to)
        if (gaps.length === 0) return
      }
    }
    const missingDays = new Set<number>()
    for (const gap of gaps) for (let day = Math.floor(gap.from / DAY) * DAY; day <= gap.to; day += DAY) missingDays.add(day)
    const recentFrom = Math.floor(this.now() / DAY) * DAY - DAY
    for (const dayTime of missingDays) {
      options.signal?.throwIfAborted()
      const date = new Date(dayTime)
      status(`检查 ${date.toISOString().slice(0, 10)} 日归档…`)
      const archived = await this.services.archives.loadDay(kind, symbol, year, month, date.getUTCDate(), { signal: options.signal })
      options.signal?.throwIfAborted()
      if (archived !== null) {
        await this.saveRows(kind, archived)
        this.queueUpload(symbol, year, month)
      } else if (dayTime >= recentFrom) {
        const dayFrom = Math.max(from, dayTime)
        const dayTo = Math.min(to, dayTime + DAY - MINUTE)
        const recentGaps = findMissingRanges(await this.local(kind, symbol, dayFrom, dayTo), '1m', dayFrom, dayTo)
        for (const gap of recentGaps) {
          status('近期尚未归档，使用分钟 API 补齐…')
          const rows = await this.client.downloadRange(kind, symbol, '1m', gap.from, gap.to, {
            ...options,
            onPage: async (page) => {
              await this.store.putCandles(kind, page.filter((candle) => candle.isClosed && candle.closeTime < this.now()))
              this.queueUpload(symbol, year, month)
            },
          })
          await this.store.putCandles(kind, rows.filter((candle) => candle.isClosed && candle.closeTime < this.now()))
          this.queueUpload(symbol, year, month)
        }
      }
    }
    const remaining = findMissingRanges(await this.local(kind, symbol, from, to), '1m', from, to)
    if (remaining.length > 0) throw new Error(`${symbol} ${kind === 'trade' ? '普通价格' : '标记价格'} 归档仍有 ${remaining.length} 个缺失区间，首个缺口 ${new Date(remaining[0].from).toISOString()}；旧历史不会改用 API。`)
  }

  async prepare(symbol: string, from: number, to: number, options: PrepareHistoryOptions = {}): Promise<{ from: number; to: number }> {
    const info = (await this.store.getSymbols()).find((item) => item.symbol === symbol.toUpperCase())
    const range = expandHistoryRange(from, to, this.now(), info?.onboardDate ?? 0)
    this.resetRequests()
    for (const month of historyMonths(range.from, range.to)) {
      for (const kind of options.kinds ?? ['trade', 'mark']) {
        await this.load(kind, symbol, '1m', month.from, month.to, options)
        options.signal?.throwIfAborted()
        const missing = findMissingRanges(await this.local(kind, symbol.toUpperCase(), month.from, month.to), '1m', month.from, month.to)
        if (missing.length > 0) throw new Error(`${symbol} 所选完整区间仍有 ${missing.length} 个缺口，未缩短结束范围。`)
      }
    }
    return range
  }

  resetRequests(): void { this.cloudReads.clear(); this.cloudReadTimes.clear() }
  getPendingUploadCount(): number { return this.pending.size }
  private persistPending(): void {
    try { this.services.pendingStorage?.setItem(PENDING_KEY, JSON.stringify([...this.pending.values()])) } catch { /* Local cache remains usable. */ }
  }
  private queueUpload(symbol: string, year: number, month: number): void {
    if (!this.services.cloud || this.services.cloud.canWrite?.() === false) return
    this.pending.set(this.monthKey(symbol, year, month), { symbol, year, month, revision: ++this.revision })
    this.persistPending()
    this.startUploads()
  }
  private startUploads(): void {
    if (this.uploading !== null) return
    const revision = this.revision
    this.uploading = Promise.resolve().then(() => this.flushUploads()).finally(() => {
      this.uploading = null
      if (this.pending.size > 0 && this.revision > revision) this.startUploads()
    })
  }
  private async flushUploads(): Promise<void> {
    if (!this.services.cloud || this.services.cloud.canWrite?.() === false) return
    const attempted = new Set<string>()
    while (true) {
      const job = [...this.pending.entries()].find(([key]) => !attempted.has(key))
      if (!job) break
      const [key, entry] = job
      attempted.add(key)
      try {
        const from = Date.UTC(entry.year, entry.month - 1)
        const to = Date.UTC(entry.year, entry.month) - MINUTE
        const [trade, mark, symbols] = await Promise.all([
          this.local('trade', entry.symbol, from, to), this.local('mark', entry.symbol, from, to), this.store.getSymbols(),
        ])
        if (trade.length + mark.length === 0) { this.pending.delete(key); this.persistPending(); continue }
        await this.services.cloud.saveMonth(entry.symbol, entry.year, entry.month, trade, mark, symbols.find((item) => item.symbol === entry.symbol))
        // A negative read made before this upload must not hide the new cloud
        // month when the user subsequently clears their local cache.
        this.cloudReads.delete(key)
        this.cloudReadTimes.delete(key)
        if (this.pending.get(key)?.revision === entry.revision) this.pending.delete(key)
        else attempted.delete(key)
      } catch (error) {
        this.lastWarning?.(`已缓存，待上传：${error instanceof Error ? error.message : String(error)}`)
      }
      this.persistPending()
    }
  }
  private async waitForUploads(): Promise<void> { if (this.uploading !== null) await this.uploading }
  async retryPendingUploads(): Promise<void> {
    await this.waitForUploads()
    this.uploading = this.flushUploads().finally(() => { this.uploading = null })
    await this.uploading
  }
}
