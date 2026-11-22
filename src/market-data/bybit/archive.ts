import { defaultStorageTarget } from '../../github-sync/default-storage'
import type { GitHubRepositoryTarget } from '../../github-sync/github-client'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, bybitDay, bybitDayStart, bybitFirstDay, bybitTrade,
  bybitTradeTime, type BybitSymbol, type BybitTrade } from './trades'

interface ArchivePart {
  file: string
  hour: number
  rows: number
  bytes: number
  sha256: string
}

interface ArchiveManifest {
  version: 1
  symbol: string
  day: string
  rows: number
  parts: ArchivePart[]
}

export const BYBIT_ARCHIVE_ROOT = 'data/bybit-trades'
const ARCHIVE_PART_MAX = 17 * 1024 ** 2

function manifest(value: unknown, symbol: string, day: string, allowEmpty: boolean): ArchiveManifest {
  const item = value as Partial<ArchiveManifest> | null
  if (!item || item.version !== 1 || item.symbol !== symbol || item.day !== day ||
      !Number.isSafeInteger(item.rows) || !Array.isArray(item.parts) || (!allowEmpty && !item.parts.length)) {
    throw new Error('日成交清单无效')
  }
  let rows = 0
  let previousFile = ''
  for (const part of item.parts) {
    if (!part || typeof part.file !== 'string' || !/^\d\d-\d{3}\.csv\.gz$/.test(part.file) ||
        !Number.isInteger(part.hour) || part.hour < 0 || part.hour > 23 || Number(part.file.slice(0, 2)) !== part.hour ||
        !Number.isSafeInteger(part.rows) || part.rows <= 0 ||
        !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > ARCHIVE_PART_MAX ||
        typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(part.sha256) || part.file <= previousFile) {
      throw new Error('Bybit 日成交分片清单无效')
    }
    previousFile = part.file
    rows += part.rows
  }
  if (rows !== item.rows) throw new Error('Bybit 日成交笔数无效')
  return item as ArchiveManifest
}

async function sha256(buffer: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)),
    byte => byte.toString(16).padStart(2, '0')).join('')
}

function* archivePartTrades(text: string, partStart: number, rows: number): Generator<BybitTrade> {
  const startUs = partStart * 1000
  const endUs = (partStart + BYBIT_HOUR_MS) * 1000
  let from = 0
  let previous = 0
  let count = 0
  while (from < text.length) {
    const end = text.indexOf('\n', from)
    const [timestamp, id, side, price, size, extra] = text.slice(from, end < 0 ? undefined : end).split(',')
    const trade = bybitTrade(bybitTradeTime(timestamp), id, side, price, size)
    if (extra !== undefined || trade.timeUs < startUs || trade.timeUs >= endUs || trade.timeUs < previous) {
      throw new Error('Bybit 成交分片的时间或字段无效')
    }
    count++
    yield trade
    previous = trade.timeUs
    if (end < 0) break
    from = end + 1
  }
  if (count !== rows) throw new Error('Bybit 成交分片笔数不符')
}

export function parseBybitArchivePart(text: string, partStart: number, rows: number): BybitTrade[] {
  return [...archivePartTrades(text, partStart, rows)]
}

export class BybitArchive<Symbol extends string = BybitSymbol> {
  private readonly manifests = new Map<string, { meta: ArchiveManifest; root: string }>()
  private readonly manifestReads = new Map<string, Promise<{ meta: ArchiveManifest; root: string } | null>>()
  private readonly missing = new Map<string, number>()
  private readonly hours = new Map<string, Promise<BybitTrade[]>>()
  private readonly compressed = new Map<string, Promise<ArrayBuffer>>()
  private readonly waiting: (() => void)[] = []
  private downloading = 0

  constructor(private readonly target: GitHubRepositoryTarget = defaultStorageTarget(),
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now,
    private readonly source = { root: BYBIT_ARCHIVE_ROOT, firstDay: (symbol: Symbol) => bybitFirstDay(symbol as BybitSymbol), allowEmpty: false }) {}

  private archiveRoot(ref: string): string {
    const { owner, repository, root } = this.target
    return 'https://raw.githubusercontent.com/' + [owner, repository, ref, ...(root ?? '').split('/').filter(Boolean)]
      .map(encodeURIComponent).join('/') + '/' + this.source.root
  }

  private async getManifest(symbol: Symbol, day: string, ref?: string) {
    const path = `${symbol}/${day}`
    const cached = this.manifests.get(path)
    if (cached) return cached
    if (!ref && (this.missing.get(path) ?? 0) > this.now()) return null
    const root = this.archiveRoot(ref ?? this.target.branch)
    const url = `${root}/${path}/manifest.json`
    const ongoing = this.manifestReads.get(url)
    if (ongoing) return ongoing
    const pending = (async () => {
      const response = await this.fetcher.call(globalThis, url, { signal: AbortSignal.timeout(20_000), cache: 'no-store', credentials: 'omit' })
      if (response.status === 404) {
        if (!ref && !this.manifests.has(path)) {
          this.missing.set(path, this.now() + 30_000)
          if (this.missing.size > 256) this.missing.delete(this.missing.keys().next().value!)
        }
        return null
      }
      if (!response.ok) throw new Error(`读取日成交清单失败（HTTP ${response.status}）`)
      const archive = { meta: manifest(await response.json(), symbol, day, this.source.allowEmpty), root }
      this.manifests.set(path, archive)
      this.missing.delete(path)
      if (this.manifests.size > 128) this.manifests.delete(this.manifests.keys().next().value!)
      return archive
    })()
    this.manifestReads.set(url, pending)
    try { return await pending } finally { this.manifestReads.delete(url) }
  }

  async hasDay(symbol: Symbol, day: string, ref?: string): Promise<boolean> {
    return bybitDayStart(day) + BYBIT_DAY_MS <= this.now() && day >= this.source.firstDay(symbol) &&
      (await this.getManifest(symbol, day, ref)) !== null
  }

  private async hourParts(symbol: Symbol, start: number): Promise<{ root: string; parts: ArchivePart[] } | null> {
    if (start % BYBIT_HOUR_MS !== 0) throw new Error('Bybit 归档小时无效')
    const day = bybitDay(start)
    if (bybitDayStart(day) + BYBIT_DAY_MS > this.now() || day < this.source.firstDay(symbol)) return null
    const archive = await this.getManifest(symbol, day)
    if (!archive) return null
    const hour = new Date(start).getUTCHours()
    return { root: `${archive.root}/${symbol}/${day}`, parts: archive.meta.parts.filter(part => part.hour === hour) }
  }

  async prefetchHour(symbol: Symbol, start: number): Promise<boolean> {
    if (this.hours.has(`${symbol}/${start}`)) return true
    const files = await this.hourParts(symbol, start)
    if (!files) return false
    for (const part of files.parts) await this.compressedPart(`${files.root}/${part.file}`, part)
    return true
  }

  async loadHour(symbol: Symbol, start: number, contractValue?: number): Promise<BybitTrade[] | null> {
    const files = await this.hourParts(symbol, start)
    if (!files) return null
    if (!files.parts.length) return []
    const key = `${symbol}/${start}`
    const cached = this.hours.get(key)
    if (cached) {
      this.hours.delete(key)
      this.hours.set(key, cached)
      return cached
    }
    const pending = this.readParts(files.root, start, files.parts, contractValue)
    this.hours.set(key, pending)
    if (this.hours.size > 6) this.hours.delete(this.hours.keys().next().value!)
    void pending.catch(() => { if (this.hours.get(key) === pending) this.hours.delete(key) })
    return pending
  }

  private compressedPart(url: string, part: ArchivePart): Promise<ArrayBuffer> {
    const existing = this.compressed.get(url)
    if (existing) return existing
    const pending = this.downloadPart(url, part)
    this.compressed.set(url, pending)
    if (this.compressed.size > 8) this.compressed.delete(this.compressed.keys().next().value!)
    void pending.catch(() => { if (this.compressed.get(url) === pending) this.compressed.delete(url) })
    return pending
  }

  private async downloadPart(url: string, part: ArchivePart): Promise<ArrayBuffer> {
    if (this.downloading < 4) this.downloading++
    else await new Promise<void>(resolve => this.waiting.push(resolve))
    try {
      const response = await this.fetcher.call(globalThis, url, { signal: AbortSignal.timeout(45_000) })
      if (!response.ok) throw new Error(`Bybit 成交分片读取失败（HTTP ${response.status}）`)
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength !== part.bytes || await sha256(buffer) !== part.sha256) {
        throw new Error(`Bybit 成交分片校验失败：${part.file}`)
      }
      return buffer
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.downloading--
    }
  }

  private async readParts(root: string, start: number, parts: ArchivePart[], contractValue?: number): Promise<BybitTrade[]> {
    const trades: BybitTrade[] = []
    for (const part of parts) {
      const url = `${root}/${part.file}`
      const pending = this.compressedPart(url, part)
      const buffer = await pending
      if (this.compressed.get(url) === pending) this.compressed.delete(url)
      const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
      const text = await new Response(stream).text()
      let yieldAt = performance.now() + 10
      for (const trade of archivePartTrades(text, start, part.rows)) {
        if ((trades.at(-1)?.timeUs ?? 0) > trade.timeUs) throw new Error('Bybit 成交分片顺序无效')
        if (contractValue !== undefined) {
          trade.venue = 'OKX'
          trade.size *= contractValue
        }
        trades.push(trade)
        if (trades.length % 2048 === 0 && performance.now() >= yieldAt) {
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          yieldAt = performance.now() + 10
        }
      }
    }
    return trades
  }
}
