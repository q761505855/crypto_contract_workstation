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
  symbol: BybitSymbol
  day: string
  rows: number
  parts: ArchivePart[]
}

const BYBIT_ARCHIVE_ROOT = 'data/bybit-trades'
const ARCHIVE_PART_MAX = 17 * 1024 ** 2

function manifest(value: unknown, symbol: BybitSymbol, day: string): ArchiveManifest {
  const item = value as Partial<ArchiveManifest> | null
  if (!item || item.version !== 1 || item.symbol !== symbol || item.day !== day ||
      !Number.isSafeInteger(item.rows) || !Array.isArray(item.parts) || !item.parts.length) {
    throw new Error('Bybit 日成交清单无效')
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

export function parseBybitArchivePart(text: string, partStart: number, rows: number): BybitTrade[] {
  const trades: BybitTrade[] = []
  const startUs = partStart * 1000
  const endUs = (partStart + BYBIT_HOUR_MS) * 1000
  let from = 0
  let previous = 0
  while (from < text.length) {
    const end = text.indexOf('\n', from)
    const [timestamp, id, side, price, size, extra] = text.slice(from, end < 0 ? undefined : end).split(',')
    const trade = bybitTrade(bybitTradeTime(timestamp), id, side, price, size)
    if (extra !== undefined || trade.timeUs < startUs || trade.timeUs >= endUs || trade.timeUs < previous) {
      throw new Error('Bybit 成交分片的时间或字段无效')
    }
    trades.push(trade)
    previous = trade.timeUs
    if (end < 0) break
    from = end + 1
  }
  if (trades.length !== rows) throw new Error('Bybit 成交分片笔数不符')
  return trades
}

export class BybitArchive {
  private readonly manifests = new Map<string, Promise<ArchiveManifest | null>>()
  private readonly hours = new Map<string, Promise<BybitTrade[]>>()
  private readonly root: string

  constructor(target: GitHubRepositoryTarget = defaultStorageTarget(), private readonly fetcher: typeof fetch = fetch,
    private readonly now = Date.now) {
    this.root = 'https://raw.githubusercontent.com/' +
      [target.owner, target.repository, target.branch, ...(target.root ?? '').split('/').filter(Boolean)]
        .map(encodeURIComponent).join('/') + '/' + BYBIT_ARCHIVE_ROOT
  }

  private getManifest(symbol: BybitSymbol, day: string): Promise<ArchiveManifest | null> {
    const path = `${symbol}/${day}`
    const cached = this.manifests.get(path)
    if (cached) return cached
    const pending = (async () => {
      const response = await this.fetcher(`${this.root}/${path}/manifest.json`, { signal: AbortSignal.timeout(20_000) })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`读取 Bybit 日成交清单失败（HTTP ${response.status}）`)
      return manifest(await response.json(), symbol, day)
    })()
    this.manifests.set(path, pending)
    if (this.manifests.size > 128) this.manifests.delete(this.manifests.keys().next().value!)
    void pending.then(result => { if (!result && this.manifests.get(path) === pending) this.manifests.delete(path) },
      () => { if (this.manifests.get(path) === pending) this.manifests.delete(path) })
    return pending
  }

  async hasDay(symbol: BybitSymbol, day: string): Promise<boolean> {
    return bybitDayStart(day) + BYBIT_DAY_MS <= this.now() && day >= bybitFirstDay(symbol) &&
      (await this.getManifest(symbol, day)) !== null
  }

  async loadHour(symbol: BybitSymbol, start: number): Promise<BybitTrade[] | null> {
    if (start % BYBIT_HOUR_MS !== 0) throw new Error('Bybit 归档小时无效')
    const day = bybitDay(start)
    if (bybitDayStart(day) + BYBIT_DAY_MS > this.now() || day < bybitFirstDay(symbol)) return null
    const meta = await this.getManifest(symbol, day)
    if (!meta) return null
    const key = `${symbol}/${start}`
    const cached = this.hours.get(key)
    if (cached) {
      this.hours.delete(key)
      this.hours.set(key, cached)
      return cached
    }
    const hour = new Date(start).getUTCHours()
    const pending = this.readParts(symbol, day, start, meta.parts.filter(part => part.hour === hour))
    this.hours.set(key, pending)
    if (this.hours.size > 6) this.hours.delete(this.hours.keys().next().value!)
    void pending.catch(() => { if (this.hours.get(key) === pending) this.hours.delete(key) })
    return pending
  }

  private async readParts(symbol: BybitSymbol, day: string, start: number, parts: ArchivePart[]): Promise<BybitTrade[]> {
    const trades: BybitTrade[] = []
    for (const part of parts) {
      const response = await this.fetcher(`${this.root}/${symbol}/${day}/${part.file}`, { signal: AbortSignal.timeout(45_000) })
      if (!response.ok) throw new Error(`Bybit 成交分片读取失败（HTTP ${response.status}）`)
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength !== part.bytes || await sha256(buffer) !== part.sha256) {
        throw new Error(`Bybit 成交分片校验失败：${part.file}`)
      }
      const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
      const rows = parseBybitArchivePart(await new Response(stream).text(), start, part.rows)
      if ((trades.at(-1)?.timeUs ?? 0) > (rows[0]?.timeUs ?? Infinity)) throw new Error('Bybit 成交分片顺序无效')
      for (const trade of rows) trades.push(trade)
    }
    return trades
  }
}
