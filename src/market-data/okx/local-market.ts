import type { BybitTrade } from '../bybit/trades'
import type { ChartPriceMarket } from '../ctrader-datafeed'
import { alignOpenTime, isCTraderTimeframe, nextOpenTime, shiftOpenTime } from '../intervals'
import type { MarketCandle, MarketSymbol } from '../models'
import type { OkxReplayRisk } from '../../simulation/okx-trading'
import { okxArchiveDay } from './archive'
import catalog from './instruments.json'
import type { OkxLocalFile, OkxLocalFiles, OkxLocalTrade } from './local-files'
import type { OkxMarketService } from './market'
import { compareTrades, orderFlowMapping } from './trades'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const OFFSET = 8 * HOUR
const MINUTE_CACHE_DAYS = 24
const RECENT_BARS = 499

type BasePeriod = '1m' | '1h' | '1d'
type Bar = Pick<MarketCandle, 'openTime' | 'tradeCount'> & {
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number
}
type Minute = Bar & { first: OkxLocalTrade; last: OkxLocalTrade }
type FileBars = Record<'1h' | '1d', Bar[]> & { '1m'?: Bar[] }
type ArchiveFile = OkxLocalFile & { start: number }

const instruments = new Map<string, string>()
for (const [symbol, , first] of Object.values(catalog) as [string, number, string][]) instruments.set(symbol, first)
const fileStart = (day: string) => Date.parse(day) - OFFSET

function basePeriod(timeframe: string): BasePeriod {
  if (timeframe.endsWith('m')) return '1m'
  if (timeframe.endsWith('h')) return '1h'
  return '1d'
}

function aggregate(rows: Iterable<Bar>, timeframe: string): Bar[] {
  const groups = new Map<number, Bar>()
  for (const row of rows) {
    const openTime = alignOpenTime(row.openTime, timeframe, 'floor')
    const bar = groups.get(openTime)
    if (!bar) {
      groups.set(openTime, { ...row, openTime })
      continue
    }
    bar.high = Math.max(bar.high, row.high)
    bar.low = Math.min(bar.low, row.low)
    bar.close = row.close
    bar.volume += row.volume
    bar.quoteVolume += row.quoteVolume
    bar.tradeCount += row.tradeCount
  }
  return [...groups.values()]
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

export class OkxLocalMarket implements ChartPriceMarket {
  readonly source = 'okx-local'
  private readonly summaries = new Map<string, FileBars>()
  private readonly minutes = new Map<string, FileBars>()
  private readonly scans = new Map<string, Promise<FileBars | undefined>>()
  private readonly specs = new Map<string, MarketSymbol>()
  private revision = -1
  private revisionAbort = new AbortController()
  private index?: Promise<ArchiveFile[]>

  constructor(readonly files: OkxLocalFiles, private readonly exchange: OkxMarketService) {}

  get historyRevision(): number { return this.files.revision }

  private syncRevision(): void {
    if (this.revision === this.files.revision) return
    this.revision = this.files.revision
    this.revisionAbort.abort()
    this.revisionAbort = new AbortController()
    this.index = undefined
    this.scans.clear()
    this.summaries.clear()
    this.minutes.clear()
  }

  private async archives(symbol?: string, signal?: AbortSignal): Promise<ArchiveFile[]> {
    signal?.throwIfAborted()
    await this.files.restore()
    signal?.throwIfAborted()
    this.syncRevision()
    const rows = await (this.index ??= this.files.list()
      .then(files => files.filter(file => file.symbol.endsWith('-USDT-SWAP'))
        .map(file => ({ ...file, start: fileStart(file.day) })).sort((a, b) => a.start - b.start))
      .catch(error => { this.index = undefined; throw error }))
    signal?.throwIfAborted()
    return symbol ? rows.filter(file => file.symbol === symbol) : rows
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
    const files = await this.archives(symbol, signal)
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
    const files = (await this.archives(symbol, signal)).filter(file => file.start < end && file.start + DAY > start)
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
    return (await this.loadRecentCandlesPage(symbol, timeframe, to, options)).candles
  }

  async loadRecentCandlesPage(symbol: string, timeframe: string, to: number, { signal }: { signal?: AbortSignal }) {
    if (!isCTraderTimeframe(timeframe)) return { candles: [], nextTo: -1 }
    const files = await this.archives(symbol, signal)
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
    return new Set((await this.archives(symbol)).map(file => file.day))
  }

  async visitTrades(symbol: string, from: number, to: number, accept: (trade: BybitTrade) => void,
    signal: AbortSignal, onCoverage?: (from: number, to: number, found: boolean) => void): Promise<boolean> {
    const files = new Map((await this.archives(symbol, signal)).map(file => [file.start, file]))
    if (from >= to) return true
    const scanSignal = AbortSignal.any([signal, this.revisionAbort.signal])
    const value = files.size ? await this.contractValue(symbol, scanSignal) : 0
    let complete = true
    for (let start = fileStart(okxArchiveDay(from / 1000)); start * 1000 < to; start += DAY) {
      scanSignal.throwIfAborted()
      const file = files.get(start)
      const begin = Math.max(from, start * 1000)
      const end = Math.min(to, (start + DAY) * 1000)
      const rows: BybitTrade[] = []
      const found = file && await this.files.scan(symbol, file.day, trade => {
        const timeUs = trade.time * 1000
        if (timeUs >= begin && timeUs < end) rows.push({ timeUs, id: trade.id, price: Number(trade.price),
          size: Number(trade.size) * value, side: trade.side === 'Buy' ? 'buy' : 'sell', venue: 'OKX' })
      }, scanSignal)
      for (const row of rows.sort(compareTrades)) accept(row)
      onCoverage?.(begin, end, !!found)
      complete &&= !!found
    }
    return complete
  }
}
