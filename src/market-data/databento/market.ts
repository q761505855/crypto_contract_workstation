import type { LocalArchiveMarket } from '../local-archive-market'
import type { CTraderTick } from '../ctrader-market'
import { DATABENTO_PRICE_PRECISION, type MarketCandle, type MarketSymbol } from '../models'
import { BYBIT_DAY_MS as DAY, bybitDay, bybitDayStart, type BybitTrade } from '../bybit/trades'
import { alignOpenTime, isCTraderTimeframe, nextOpenTime, shiftOpenTime } from '../intervals'
import { aggregateLocalBars, type LocalBar } from '../local-bars'
import { appendIndexedReplayTicks, localTradeIndexBytes, visitIndexedPriceSizes, visitIndexedTrades, type LocalTradeIndex } from '../okx/local-trade-index'
import { reserveWorker, workerCapacity } from '../worker-capacity'
import { cmeTradingBounds, cmeTradingDay, nearestContract, previousCmeTradingDay } from './trading-day'
import { readArchive, type ArchiveRead, type ArchiveResult, type ArchiveTask } from './archive-data'
import type { ArchiveWorkerMessage, ArchiveWorkerReply } from './archive.worker'
import { DatabentoFiles, type DatabentoArchive } from './files'

type BarResult = Extract<ArchiveResult, { kind: 'bars' }>['bars']
type Summary = Extract<ArchiveResult, { kind: 'summary' }>['summary']
const INDEX_BUDGET = 96 * 1024 * 1024
const dateStart = (time: number) => Math.floor(time / DAY) * DAY
const fileKey = (file: DatabentoArchive) => `${file.symbol}:${file.day}`
const basePeriod = (timeframe: string) => timeframe.endsWith('m') ? '1m' : timeframe.endsWith('h') ? '1h' : '1d'

async function decode(task: ArchiveTask, request: ArchiveRead, signal: AbortSignal): Promise<ArchiveResult> {
  if (!workerCapacity) return readArchive(task, request, signal)
  const release = await reserveWorker(signal)
  try {
    signal.throwIfAborted()
    let worker: Worker
    try { worker = new Worker(new URL('./archive.worker.ts', import.meta.url), { type: 'module' }) }
    catch { return await readArchive(task, request, signal) }
    try {
      return await new Promise<ArchiveResult>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        worker.onmessage = ({ data }: MessageEvent<ArchiveWorkerReply>) => {
          signal.removeEventListener('abort', abort)
          if ('error' in data) reject(new Error(data.error))
          else resolve(data.result)
        }
        worker.onerror = event => {
          signal.removeEventListener('abort', abort)
          reject(new Error(event.message || '无法读取 Databento 日档'))
        }
        try { worker.postMessage({ task, request } satisfies ArchiveWorkerMessage) }
        catch (error) { signal.removeEventListener('abort', abort); reject(error) }
      })
    } finally { worker.terminate() }
  } finally { release() }
}

function cached<T>(entries: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let result = entries.get(key)
  if (!result) {
    result = read().catch(error => {
      if (entries.get(key) === result) entries.delete(key)
      throw error
    })
    entries.set(key, result)
  }
  return result
}

export class DatabentoMarket implements LocalArchiveMarket {
  readonly source = 'databento-cme'
  readonly tickWindowMs = 60_000
  readonly archiveDay = bybitDay
  readonly archiveDayStart = bybitDayStart
  private readonly selected = new Map<string, Set<string>>()
  private readonly listeners = new Set<() => void>()
  private readonly summaries = new Map<string, Promise<Summary>>()
  private readonly leaders = new Map<string, Promise<string | undefined>>()
  private readonly candles = new Map<string, Promise<BarResult>>()
  private readonly indexes = new Map<string, { data: LocalTradeIndex; bytes: number }>()
  private readonly pendingIndexes = new Map<string, Promise<LocalTradeIndex>>()
  private indexBytes = 0
  private selectionRevision = 0
  private cancelled = new AbortController()

  constructor(readonly files: DatabentoFiles) {
    files.subscribe(() => {
      this.cancelled.abort()
      this.cancelled = new AbortController()
      this.summaries.clear()
      this.leaders.clear()
      this.candles.clear()
      this.clearIndexes()
      this.notify()
    })
  }

  get historyRevision(): number { return this.files.revision + this.selectionRevision }

  subscribeArchives(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify() { for (const listener of this.listeners) listener() }

  private clearIndexes() {
    this.indexes.clear()
    this.pendingIndexes.clear()
    this.indexBytes = 0
  }

  activeDays(symbol: string) { return [...(this.selected.get(symbol) ?? [])].sort() }

  setActiveDays(symbol: string, days: readonly string[], append = false): boolean {
    const previous = this.selected.get(symbol)
    const next = new Set(append ? [...(previous ?? []), ...days] : days)
    if (next.size === (previous?.size ?? 0) && [...next].every(day => previous?.has(day))) return false
    if (next.size) this.selected.set(symbol, next)
    else this.selected.delete(symbol)
    this.selectionRevision++
    this.notify()
    return true
  }

  clearActiveDays(): void {
    if (!this.selected.size) return
    this.selected.clear()
    this.selectionRevision++
    this.notify()
  }

  async getSymbols({ forceRefresh = false, signal }: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<MarketSymbol[]> {
    const products = await this.files.list(forceRefresh)
    signal?.throwIfAborted()
    return [...products].map(([symbol, archives]) => ({
      exchange: 'CME', symbol, baseAsset: symbol, quoteAsset: '', contractType: 'FUTURES',
      status: 'TRADING', onboardDate: archives[0]?.start ?? 0, pricePrecision: DATABENTO_PRICE_PRECISION, quantityPrecision: 0,
    }))
  }

  async getReplayTradingTerms(): Promise<undefined> { return undefined }
  subscribe(): () => void { return () => undefined }

  historyPageSize(timeframe: string): number {
    switch (basePeriod(timeframe)) {
      case '1m': return 499
      case '1h': return 100
      default: return timeframe === '1d' ? 30 : timeframe === '1w' ? 4 : 1
    }
  }

  private async archives(symbol: string, signal?: AbortSignal) {
    const all = (await this.files.list()).get(symbol) ?? []
    signal?.throwIfAborted()
    const selected = this.selected.get(symbol)
    return { all, active: selected ? all.filter(file => selected.has(file.day)) : [] }
  }

  async historyBounds(symbol: string, signal?: AbortSignal) {
    const { active } = await this.archives(symbol, signal)
    if (active.length) return { from: active[0].start, to: active.at(-1)!.start + DAY - 1 }
  }

  private async read(file: DatabentoArchive, request: ArchiveRead, signal: AbortSignal) {
    try {
      const source = await file.handle.getFile()
      signal.throwIfAborted()
      return await decode({ file: source, product: file.symbol, day: file.day }, request, signal)
    } catch (error) {
      signal.throwIfAborted()
      throw new Error(`${file.filename}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private summary(file: DatabentoArchive, signal: AbortSignal): Promise<Summary> {
    return cached(this.summaries, fileKey(file), async () => {
      const result = await this.read(file, { kind: 'summary' }, signal)
      if (result.kind !== 'summary') throw new Error('未生成 Databento 成交量统计')
      return result.summary
    })
  }

  private leader(symbol: string, day: string, all: DatabentoArchive[], signal: AbortSignal) {
    if (!symbol.endsWith('.FUT')) return Promise.resolve(symbol)
    return cached(this.leaders, `${symbol}:${day}`, async () => {
      const { from, to } = cmeTradingBounds(day)
      const current = all.filter(file => file.start < to && file.start + DAY > from)
      if (!current.length) return
      const contracts = new Set((await this.summary(current[0], signal)).contracts)
      // Look back across closures and missing archives. Two UTC files cover one Chicago session.
      let prior = day
      for (let lookback = 0; lookback < 5; lookback++) {
        prior = previousCmeTradingDay(prior)
        const midnight = Date.parse(prior)
        const preceding = all.find(file => file.start === midnight - DAY)
        const daytime = all.find(file => file.start === midnight)
        if (!preceding || !daytime) continue
        const [eveningStats, dayStats] = await Promise.all([this.summary(preceding, signal), this.summary(daytime, signal)])
        let largest = 0
        let leading: string[] = []
        for (const contract of contracts) {
          const size = (eveningStats.volumes[1].get(contract) ?? 0) + (dayStats.volumes[0].get(contract) ?? 0)
          if (size === 0 || size < largest) continue
          if (size > largest) { largest = size; leading = [] }
          leading.push(contract)
        }
        if (leading.length) return nearestContract(leading, day) ?? leading.sort()[0]
      }
      return nearestContract(contracts, day)
    })
  }

  async contractAt(symbol: string, timestamp: number, signal?: AbortSignal): Promise<string | undefined> {
    const { all } = await this.archives(symbol, signal)
    if (!all.length) return
    const contract = await this.leader(symbol, cmeTradingDay(timestamp), all, this.cancelled.signal)
    signal?.throwIfAborted()
    return contract
  }

  private async contracts(file: DatabentoArchive, all: DatabentoArchive[], signal: AbortSignal) {
    const day = file.day
    const next = bybitDay(file.start + DAY)
    const pair: [string | undefined, string | undefined] = await Promise.all([
      this.leader(file.symbol, day, all, signal), this.leader(file.symbol, next, all, signal),
    ])
    return pair
  }

  private bars(file: DatabentoArchive, all: DatabentoArchive[]) {
    const signal = this.cancelled.signal
    return cached(this.candles, fileKey(file), async () => {
      const contracts = await this.contracts(file, all, signal)
      const result = await this.read(file, { kind: 'bars', contracts }, signal)
      if (result.kind !== 'bars') throw new Error('未生成 Databento K 线')
      if (this.candles.size > 40) this.candles.delete(this.candles.keys().next().value!)
      return result.bars
    })
  }

  async loadCandles(_kind: 'trade', symbol: string, timeframe: string, from: number, to: number,
    { signal }: { signal?: AbortSignal } = {}): Promise<MarketCandle[]> {
    if (from > to || !isCTraderTimeframe(timeframe)) return []
    const start = alignOpenTime(from, timeframe, 'ceil')
    const end = nextOpenTime(alignOpenTime(to, timeframe, 'floor'), timeframe)
    const { active, all } = await this.archives(symbol, signal)
    const selected = active.filter(file => file.start < end && file.start + DAY > start)
    return this.candlesFromFiles(selected, all, symbol, timeframe, start, end, signal)
  }

  async loadArchiveMinutes(symbol: string, days: readonly string[]): Promise<MarketCandle[]> {
    const signal = this.cancelled.signal
    const { all } = await this.archives(symbol, signal)
    const selected = all.filter(file => days.includes(file.day))
    if (!selected.length) return []
    return this.candlesFromFiles(selected, all, symbol, '1m', selected[0].start, selected.at(-1)!.start + DAY, signal)
  }

  private async candlesFromFiles(files: DatabentoArchive[], all: DatabentoArchive[], symbol: string, timeframe: string,
    start: number, end: number, signal?: AbortSignal): Promise<MarketCandle[]> {
    const rows: LocalBar[] = []
    const base = basePeriod(timeframe)
    const covered = new Set(files.map(file => file.start))
    const available = new Set(all.map(file => file.start))
    for (const file of files) {
      signal?.throwIfAborted()
      const bars = (await this.bars(file, all))[base]
      rows.push(...bars.filter(bar => bar.openTime >= start && bar.openTime < end))
    }
    signal?.throwIfAborted()
    return aggregateLocalBars(rows, timeframe).map(bar => {
      const closeTime = nextOpenTime(bar.openTime, timeframe) - 1
      let isClosed = closeTime < Date.now()
      for (let day = dateStart(bar.openTime); isClosed && day <= closeTime; day += DAY) {
        const weekday = new Date(day).getUTCDay()
        if (!covered.has(day) && (available.has(day) || (weekday !== 0 && weekday !== 6))) isClosed = false
      }
      return { ...bar, symbol, source: this.source, timeframe, closeTime, isClosed,
        open: String(bar.open), high: String(bar.high), low: String(bar.low), close: String(bar.close),
        volume: String(bar.volume), quoteVolume: String(Number(bar.quoteVolume.toPrecision(14))) }
    })
  }

  async loadRecentCandles(symbol: string, timeframe: string, to: number, { signal }: { signal?: AbortSignal }) {
    if (!isCTraderTimeframe(timeframe)) return []
    const { all, active } = await this.archives(symbol, signal)
    const latest = active.filter(file => file.start <= to).at(-1)
    if (!latest) return []
    const from = alignOpenTime(latest.start, timeframe, 'floor')
    const end = nextOpenTime(alignOpenTime(to, timeframe, 'floor'), timeframe)
    return this.candlesFromFiles([latest], all, symbol, timeframe, from, end, signal)
  }

  async loadRecentCandlesPage(symbol: string, timeframe: string, to: number, { signal }: { signal?: AbortSignal }) {
    if (!isCTraderTimeframe(timeframe)) return { candles: [], nextTo: -1 }
    const { all, active } = await this.archives(symbol, signal)
    const end = nextOpenTime(alignOpenTime(to, timeframe, 'floor'), timeframe)
    for (let index = active.length - 1; index >= 0; index--) {
      signal?.throwIfAborted()
      const file = active[index]
      if (file.start >= end) continue
      const last = (await this.bars(file, all))[basePeriod(timeframe)].filter(bar => bar.openTime < end).at(-1)
      if (!last) continue
      const latest = alignOpenTime(last.openTime, timeframe, 'floor')
      const earliest = shiftOpenTime(latest, timeframe, 1 - this.historyPageSize(timeframe))
      const candles = await this.loadCandles('trade', symbol, timeframe, earliest, latest, { signal })
      return { candles, nextTo: active[0].start < earliest ? earliest - 1 : -1 }
    }
    return { candles: [], nextTo: -1 }
  }

  async tradeDays(symbol: string) {
    return new Set((await this.archives(symbol)).active.map(file => file.day))
  }

  async loadTicks(symbol: string, from: number, to: number, signal = new AbortController().signal): Promise<CTraderTick[]> {
    const ticks: CTraderTick[] = []
    await this.visitDays(symbol, from * 1000, (to + 1) * 1000, async (index, begin, end) => {
      appendIndexedReplayTicks(index, begin, end, 1, ticks)
    }, signal)
    return ticks
  }

  visitTrades(symbol: string, from: number, to: number, accept: (trade: BybitTrade) => unknown,
    signal: AbortSignal, onCoverage?: (from: number, to: number, found: boolean) => void) {
    return this.visitDays(symbol, from, to,
      (index, begin, end) => visitIndexedTrades(index, begin, end, 1, accept, signal, 'CME'), signal, onCoverage)
  }

  visitPriceSizes(symbol: string, from: number, to: number, accept: (batch: Float64Array<ArrayBuffer>) => Promise<void>, signal: AbortSignal) {
    return this.visitDays(symbol, from, to,
      (index, begin, end) => visitIndexedPriceSizes(index, begin, end, 1, accept, signal), signal)
  }

  private async visitDays(symbol: string, from: number, to: number,
    visit: (index: LocalTradeIndex, from: number, to: number) => Promise<void>, signal: AbortSignal,
    coverage?: (from: number, to: number, found: boolean) => void) {
    if (from >= to) return true
    const { all, active } = await this.archives(symbol, signal)
    const files = new Map(active.map(file => [file.start, file]))
    const scanSignal = AbortSignal.any([signal, this.cancelled.signal])
    let complete = true
    for (let day = dateStart(from / 1000); day * 1000 < to; day += DAY) {
      scanSignal.throwIfAborted()
      const begin = Math.max(from, day * 1000)
      const end = Math.min(to, (day + DAY) * 1000)
      const file = files.get(day)
      if (file) await visit(await this.index(file, all), begin, end)
      else complete = false
      scanSignal.throwIfAborted()
      coverage?.(begin, end, !!file)
    }
    return complete
  }

  private index(file: DatabentoArchive, all: DatabentoArchive[]): Promise<LocalTradeIndex> {
    const key = fileKey(file)
    const index = this.indexes.get(key)
    if (index) {
      this.indexes.delete(key)
      this.indexes.set(key, index)
      return Promise.resolve(index.data)
    }
    const signal = this.cancelled.signal
    return cached(this.pendingIndexes, key, async () => {
      const contracts = await this.contracts(file, all, signal)
      const result = await this.read(file, { kind: 'trades', contracts }, signal)
      if (result.kind !== 'trades') throw new Error('未生成 Databento 逐笔索引')
      signal.throwIfAborted()
      this.pendingIndexes.delete(key)
      const bytes = localTradeIndexBytes(result.index)
      // Keep one oversized index rather than decode the same day for every window.
      while (this.indexes.size > 0 && this.indexBytes + bytes > INDEX_BUDGET) {
        const [first, item] = this.indexes.entries().next().value!
        this.indexes.delete(first)
        this.indexBytes -= item.bytes
      }
      this.indexes.set(key, { data: result.index, bytes })
      this.indexBytes += bytes
      return result.index
    })
  }
}
