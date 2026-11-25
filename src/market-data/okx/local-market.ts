import type { BybitTrade } from '../bybit/trades'
import type { LocalArchiveMarket } from '../local-archive-market'
import { aggregateLocalBars as aggregate, type LocalBar as Bar } from '../local-bars'
import { alignOpenTime, isCTraderTimeframe, nextOpenTime, shiftOpenTime } from '../intervals'
import type { MarketCandle, MarketSymbol } from '../models'
import type { OkxReplayRisk } from '../../simulation/okx-trading'
import { okxArchiveDay, okxArchiveDayStart as fileStart } from './archive'
import catalog from './instruments.json'
import type { OkxLocalFile, OkxLocalFiles, OkxLocalTrade } from './local-files'
import type { OkxMarketService } from './market'
import { orderFlowMapping } from './trades'
import { OkxLocalTradeCache } from './local-trade-cache'
import { visitIndexedPriceSizes, visitIndexedTrades, type LocalTradeIndex } from './local-trade-index'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const MINUTE_CACHE_DAYS = 24
const RECENT_BARS = 499

type BasePeriod = '1m' | '1h' | '1d'
type Minute = Bar & { first: OkxLocalTrade; last: OkxLocalTrade }
type FileBars = Record<'1h' | '1d', Bar[]> & { '1m'?: Bar[] }
type ArchiveFile = OkxLocalFile & { start: number }

const instruments = new Map<string, string>()
for (const [symbol, , first] of Object.values(catalog) as [string, number, string][]) instruments.set(symbol, first)

function basePeriod(timeframe: string): BasePeriod {
  if (timeframe.endsWith('m')) return '1m'
  if (timeframe.endsWith('h')) return '1h'
  return '1d'
}

function compareLocalTrades(a: OkxLocalTrade, b: OkxLocalTrade): number {
  return a.time - b.time || a.id.length - b.id.length || (a.id < b.id ? -1 : Number(a.id > b.id))
}

function addTrade(minutes: Map<number, Minute>, trade: OkxLocalTrade, contractValue: number): void {
  const openTime = alignOpenTime(trade.time, '1m', 'floor')
  const price = Number(trade.price)
  const volume = Number(trade.size) * contractValue
  const quoteVolume = price * volume
  const bar = minutes.get(openTime)
  if (!bar) {
    minutes.set(openTime, { openTime, open: price, high: price, low: price, close: price,
      tradeCount: 1, volume, quoteVolume, first: trade, last: trade })
    return
  }
  if (compareLocalTrades(trade, bar.first) < 0) {
    bar.first = trade
    bar.open = price
  }
  if (compareLocalTrades(trade, bar.last) > 0) {
    bar.last = trade
    bar.close = price
  }
  bar.high = Math.max(bar.high, price)
  bar.low = Math.min(bar.low, price)
  bar.volume += volume
  bar.quoteVolume += quoteVolume
  bar.tradeCount++
}

function offlineSymbol(symbol: string, onboardDate: number): MarketSymbol {
  const baseAsset = symbol.replace(/-USDT-SWAP$/, '')
  return { exchange: 'OKX', symbol, baseAsset, quoteAsset: 'USDT', contractType: 'PERPETUAL',
    status: 'TRADING', onboardDate, pricePrecision: baseAsset === 'BTC' || baseAsset === 'ETH' ? 1 : 8,
    quantityPrecision: 8, description: `${baseAsset} / USDT 永续合约` }
}

export class OkxLocalMarket implements LocalArchiveMarket {
  readonly source = 'okx-local'
  readonly archiveDay = okxArchiveDay
  readonly archiveDayStart = fileStart
  private readonly summaries = new Map<string, FileBars>()
  private readonly minutes = new Map<string, FileBars>()
  private readonly scans = new Map<string, Promise<FileBars | undefined>>()
  private readonly specs = new Map<string, MarketSymbol>()
  private readonly selectedDays = new Map<string, Set<string>>()
  private readonly selectionListeners = new Set<() => void>()
  private selectionRevision = 0
  private catalogRevision = -1
  private revision = -1
  private revisionAbort = new AbortController()
  private tradeCache: OkxLocalTradeCache
  private index?: Promise<ArchiveFile[]>

  constructor(readonly files: OkxLocalFiles, private readonly exchange: OkxMarketService) {
    this.tradeCache = new OkxLocalTradeCache(files, this.revisionAbort.signal)
  }

  get historyRevision(): number { return this.files.revision + this.selectionRevision }

  subscribeArchives(listener: () => void): () => void {
    this.selectionListeners.add(listener)
    const unsubscribeFiles = this.files.subscribe(listener)
    return () => {
      this.selectionListeners.delete(listener)
      unsubscribeFiles()
    }
  }

  activeDays(symbol: string): readonly string[] {
    return [...(this.selectedDays.get(symbol) ?? [])].sort()
  }

  setActiveDays(symbol: string, days: readonly string[], append = false): boolean {
    const previous = this.selectedDays.get(symbol)
    const next = new Set(append ? [...(previous ?? []), ...days] : days)
    if (next.size === (previous?.size ?? 0) && [...next].every(day => previous?.has(day))) return false
    if (next.size) this.selectedDays.set(symbol, next)
    else this.selectedDays.delete(symbol)
    this.selectionRevision++
    for (const listener of this.selectionListeners) listener()
    return true
  }

  clearActiveDays(): void {
    if (!this.selectedDays.size) return
    this.selectedDays.clear()
    this.selectionRevision++
    for (const listener of this.selectionListeners) listener()
  }

  private syncRevision(): void {
    if (this.catalogRevision !== this.files.revision) {
      this.catalogRevision = this.files.revision
      this.index = undefined
    }
    if (this.revision === this.files.scanRevision) return
    this.revision = this.files.scanRevision
    this.revisionAbort.abort()
    this.revisionAbort = new AbortController()
    this.tradeCache = new OkxLocalTradeCache(this.files, this.revisionAbort.signal)
    this.scans.clear()
    this.summaries.clear()
    this.minutes.clear()
  }

  private async archives(symbol?: string, signal?: AbortSignal): Promise<ArchiveFile[]> {
    signal?.throwIfAborted()
    await this.files.restore()
    signal?.throwIfAborted()
    this.syncRevision()
    const pending = this.index ??= this.files.list()
      .then(files => files.filter(file => file.symbol.endsWith('-USDT-SWAP'))
        .map(file => ({ ...file, start: fileStart(file.day) })).sort((a, b) => a.start - b.start))
    const rows = await pending.catch(error => {
      if (this.index === pending) this.index = undefined
      throw error
    })
    signal?.throwIfAborted()
    return symbol ? rows.filter(file => file.symbol === symbol) : rows
  }

  private async activeArchives(symbol: string, signal?: AbortSignal): Promise<ArchiveFile[]> {
    const days = this.selectedDays.get(symbol)
    if (!days?.size) return []
    return (await this.archives(symbol, signal)).filter(file => days.has(file.day))
  }

  async getSymbols({ forceRefresh = false, signal }: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<MarketSymbol[]> {
    const archiveFiles = await this.archives(undefined, signal)
    if (forceRefresh) await this.fetchSpecs(signal).catch(() => signal?.throwIfAborted())
    const symbols = new Map(this.specs)
    for (const [symbol, first] of instruments) {
      if (!symbols.has(symbol)) symbols.set(symbol, offlineSymbol(symbol, Date.parse(first)))
    }
    for (const file of archiveFiles) {
      if (!symbols.has(file.symbol)) symbols.set(file.symbol, offlineSymbol(file.symbol, file.start))
    }
    return [...symbols.values()]
  }

  private async fetchSpecs(signal?: AbortSignal): Promise<void> {
    for (const spec of await this.exchange.getSymbols({ signal })) this.specs.set(spec.symbol, spec)
  }

  private async contractValue(symbol: string, signal?: AbortSignal): Promise<number> {
    const lookup = () => orderFlowMapping({ ticker: symbol, exchange: 'OKX' })?.okx?.contractValue
    let value = lookup()
    if (value === undefined) {
      await this.fetchSpecs(signal).catch(() => signal?.throwIfAborted())
      value = lookup()
    }
    if (value === undefined) throw new Error(`无法读取 ${symbol} 的 OKX 合约面值`)
    return value
  }

  getReplayTradingTerms(symbol: string, start: number, signal?: AbortSignal) {
    return this.exchange.getReplayTradingTerms(symbol, start, signal)
  }

  async getReplayRisk(): Promise<OkxReplayRisk> {
    return { funding: [], warning: '本地回放按成交价估算强平，资金费未计入' }
  }

  subscribe(): () => void { return () => undefined }

  historyPageSize(timeframe: string): number {
    const base = basePeriod(timeframe)
    if (base === '1m') return RECENT_BARS
    if (base === '1h') return 100
    return timeframe === '1d' ? 30 : timeframe === '1w' ? 4 : 1
  }

  async historyBounds(symbol: string, signal?: AbortSignal): Promise<{ from: number; to: number } | undefined> {
    const files = await this.activeArchives(symbol, signal)
    if (files.length) return { from: files[0].start, to: files.at(-1)!.start + DAY - 1 }
  }

  private async readFile(file: ArchiveFile, base: BasePeriod, contractValue: number, signal?: AbortSignal) {
    const key = file.filename
    const cached = base === '1m' ? this.minutes.get(key) : this.summaries.get(key)
    if (cached) {
      if (base === '1m') {
        this.minutes.delete(key)
        this.minutes.set(key, cached)
      }
      return cached[base]
    }
    let pending = this.scans.get(key)
    if (!pending) {
      const revision = this.revision
      const abort = this.revisionAbort.signal
      pending = this.buildFile(file, contractValue, abort).then(rows => {
        if (!rows || abort.aborted) return undefined
        this.summaries.set(key, { '1h': rows['1h'], '1d': rows['1d'] })
        this.minutes.set(key, rows)
        if (this.minutes.size > MINUTE_CACHE_DAYS) this.minutes.delete(this.minutes.keys().next().value!)
        return rows
      }).finally(() => { if (this.revision === revision) this.scans.delete(key) })
      this.scans.set(key, pending)
    }
    const result = await pending
    signal?.throwIfAborted()
    return result?.[base]
  }

  private async buildFile(file: ArchiveFile, contractValue: number, signal: AbortSignal): Promise<FileBars | undefined> {
    const minutes = new Map<number, Minute>()
    const found = await this.files.scan(file.symbol, file.day, trade => {
      if (trade.time >= file.start && trade.time < file.start + DAY) addTrade(minutes, trade, contractValue)
    }, signal)
    if (!found) return
    const minuteBars = [...minutes.values()].sort((a, b) => a.openTime - b.openTime)
      .map(({ first: _first, last: _last, ...bar }) => bar)
    const hours = aggregate(minuteBars, '1h')
    return { '1m': minuteBars, '1h': hours, '1d': aggregate(hours, '1d') }
  }

  async loadCandles(_kind: 'trade', symbol: string, timeframe: string, from: number, to: number,
    { signal }: { signal?: AbortSignal } = {}): Promise<MarketCandle[]> {
    if (from > to || !isCTraderTimeframe(timeframe)) return []
    const start = alignOpenTime(from, timeframe, 'ceil')
    const end = nextOpenTime(alignOpenTime(to, timeframe, 'floor'), timeframe)
    const files = (await this.activeArchives(symbol, signal)).filter(file => file.start < end && file.start + DAY > start)
    return this.candlesFromFiles(files, symbol, timeframe, start, end, signal)
  }

  private async candlesFromFiles(files: ArchiveFile[], symbol: string, timeframe: string, start: number, end: number,
    signal?: AbortSignal): Promise<MarketCandle[]> {
    if (!files.length || start >= end) return []
    const base = basePeriod(timeframe)
    const value = await this.contractValue(symbol, signal)
    const covered = new Set<number>()
    const rows: Bar[] = []
    for (const file of files) {
      signal?.throwIfAborted()
      const bars = await this.readFile(file, base, value, signal)
      if (!bars) continue
      covered.add(file.start)
      rows.push(...bars.filter(bar => bar.openTime >= start && bar.openTime < end))
    }
    // Archive boundaries can split a UTC daily bar. Fragments arrive in file order.
    return aggregate(rows, timeframe).map(bar => {
      const closeTime = nextOpenTime(bar.openTime, timeframe) - 1
      let isClosed = true
      for (let day = fileStart(okxArchiveDay(bar.openTime)); day <= closeTime; day += DAY) {
        if (!covered.has(day)) { isClosed = false; break }
      }
      return { ...bar, symbol, source: this.source, timeframe, closeTime, isClosed,
        open: String(bar.open), high: String(bar.high), low: String(bar.low), close: String(bar.close),
        volume: String(Number(bar.volume.toPrecision(14))), quoteVolume: String(Number(bar.quoteVolume.toPrecision(14))) }
    })
  }

  async loadRecentCandles(symbol: string, timeframe: string, to: number, options: { signal?: AbortSignal }) {
    if (!isCTraderTimeframe(timeframe)) return []
    const files = await this.activeArchives(symbol, options.signal)
    let index = files.length - 1
    while (index >= 0 && files[index].start > to) index--
    const latest = files[index]
    if (!latest) return []
    const from = alignOpenTime(latest.start, timeframe, 'floor')
    const end = nextOpenTime(alignOpenTime(to, timeframe, 'floor'), timeframe)
    return this.candlesFromFiles([latest], symbol, timeframe, from, end, options.signal)
  }

  async loadRecentCandlesPage(symbol: string, timeframe: string, to: number, { signal }: { signal?: AbortSignal }) {
    if (!isCTraderTimeframe(timeframe)) return { candles: [], nextTo: -1 }
    const files = await this.activeArchives(symbol, signal)
    const key = alignOpenTime(to, timeframe, 'floor')
    const end = nextOpenTime(key, timeframe)
    const base = basePeriod(timeframe)
    let index = files.length - 1
    while (index >= 0 && files[index].start >= end) index--
    if (index >= 0) {
      const value = await this.contractValue(symbol, signal)
      for (; index >= 0; index--) {
        signal?.throwIfAborted()
        const bars = await this.readFile(files[index], base, value, signal)
        const last = bars?.filter(bar => bar.openTime < end).at(-1)
        if (!last) continue
        const latest = alignOpenTime(last.openTime, timeframe, 'floor')
        const earliest = shiftOpenTime(latest, timeframe, 1 - this.historyPageSize(timeframe))
        const candles = await this.loadCandles('trade', symbol, timeframe, earliest, latest, { signal })
        return { candles, nextTo: files[0].start < earliest ? earliest - 1 : -1 }
      }
    }
    return { candles: [], nextTo: -1 }
  }

  async tradeDays(symbol: string): Promise<Set<string>> {
    return new Set((await this.activeArchives(symbol)).map(file => file.day))
  }

  visitTrades(symbol: string, from: number, to: number, accept: (trade: BybitTrade) => unknown,
    signal: AbortSignal, onCoverage?: (from: number, to: number, found: boolean) => void): Promise<boolean> {
    return this.visitIndexedDays(symbol, from, to, (index, begin, end, size, readSignal) =>
      visitIndexedTrades(index, begin, end, size, accept, readSignal), signal, onCoverage)
  }

  visitPriceSizes(symbol: string, from: number, to: number, accept: (batch: Float64Array<ArrayBuffer>) => Promise<void>,
    signal: AbortSignal): Promise<boolean> {
    return this.visitIndexedDays(symbol, from, to, (index, begin, end, size, readSignal) =>
      visitIndexedPriceSizes(index, begin, end, size, accept, readSignal), signal)
  }

  private async visitIndexedDays(symbol: string, from: number, to: number,
    visit: (index: LocalTradeIndex, from: number, to: number, size: number, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal, onCoverage?: (from: number, to: number, found: boolean) => void): Promise<boolean> {
    if (from >= to) return true
    const files = new Map((await this.activeArchives(symbol, signal))
      .filter(file => file.start * 1000 < to && (file.start + DAY) * 1000 > from).map(file => [file.start, file]))
    const scanSignal = AbortSignal.any([signal, this.revisionAbort.signal])
    const value = files.size ? await this.contractValue(symbol, scanSignal) : 0
    const cache = this.tradeCache
    const jobs = new Map<number, ReturnType<OkxLocalTradeCache['read']>>()
    let complete = true
    for (let start = fileStart(okxArchiveDay(from / 1000)); start * 1000 < to; start += DAY) {
      scanSignal.throwIfAborted()
      for (let offset = 0; offset < cache.parallelism; offset++) {
        const day = start + offset * DAY
        const file = files.get(day)
        if (file && !jobs.has(day)) jobs.set(day, cache.read(file))
      }
      const begin = Math.max(from, start * 1000)
      const end = Math.min(to, (start + DAY) * 1000)
      const index = await jobs.get(start)
      jobs.delete(start)
      scanSignal.throwIfAborted()
      if (index) await visit(index, begin, end, value, scanSignal)
      onCoverage?.(begin, end, !!index)
      complete &&= !!index
    }
    return complete
  }
}
