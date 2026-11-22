import { gzip, unzip } from 'fflate'
import { openDB, type DBSchema } from 'idb'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, bybitDay, bybitDayStart, type BybitTrade } from '../bybit/trades'
import { compareTrades, okxTrade, type OkxInstrument } from './trades'

const offset = 8 * BYBIT_HOUR_MS
export const okxArchiveDay = (time: number): string => bybitDay(time + offset)
const archiveStart = (day: string): number => bybitDayStart(day) - offset

interface OkxArchiveDB extends DBSchema {
  days: { key: [string, string]; value: true }
  hours: { key: [string, number]; value: ArrayBuffer }
}

let db: ReturnType<typeof openDB<OkxArchiveDB>> | undefined
function database() {
  return db ??= openDB<OkxArchiveDB>('workstation-okx-trades', 1, {
    upgrade: store => {
      store.createObjectStore('days')
      store.createObjectStore('hours')
    },
  })
}

export function okxArchiveDays(start: number): string[] {
  return [okxArchiveDay(start), okxArchiveDay(start + BYBIT_DAY_MS - 1)]
}

function archiveSymbols(instrument: OkxInstrument, day: string): string[] {
  if (instrument.symbol !== 'XAU-USDT-SWAP' || day > '2026-01-15') return [instrument.symbol]
  if (day === '2026-01-15') return ['XAUT-USDT-SWAP', instrument.symbol]
  return ['XAUT-USDT-SWAP']
}

function csvHours(csv: string, symbol: string, instrument: OkxInstrument, start: number): string[][] {
  const headings = csv.slice(0, csv.indexOf('\n')).trim().replace(/^\uFEFF/, '').split(',')
  const names = ['instrument_name', 'trade_id', 'side', 'price', 'size', 'created_time']
  const indexes = names.map(name => headings.findIndex(heading => heading === name || heading.endsWith(name)))
  if (indexes.includes(-1)) throw new Error('OKX 日档字段无效')
  const hours = Array.from({ length: 24 }, (): string[] => [])
  let position = csv.indexOf('\n') + 1
  let rowCount = 0
  while (position < csv.length) {
    const newline = csv.indexOf('\n', position)
    const line = csv.slice(position, newline === -1 ? undefined : newline).trim()
    position = newline === -1 ? csv.length : newline + 1
    if (!line) continue
    const fields = line.split(',')
    const [name, id, side, price, size, timestamp] = indexes.map(index => fields[index])
    const trade = okxTrade(instrument, timestamp, id, side.toLowerCase(), price, size)
    const hour = Math.floor((trade.timeUs / 1000 - start) / BYBIT_HOUR_MS)
    if (name !== symbol || hour < 0 || hour >= 24) throw new Error('OKX 日档品种或时段无效')
    hours[hour].push(`${timestamp},${id},${trade.side},${price},${size}`)
    rowCount++
  }
  if (!rowCount) throw new Error('OKX 日档没有成交记录')
  return hours
}

export class OkxArchive {
  private readonly downloads = new Map<string, Promise<boolean>>()
  private readonly present = new Set<string>()
  private readonly missing = new Map<string, number>()
  private readonly reads = new Map<string, Promise<BybitTrade[]>>()

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  isCachedHour(instrument: OkxInstrument, start: number): boolean {
    return this.present.has(`${instrument.symbol}:${okxArchiveDay(start)}`)
  }

  async hasHour(instrument: OkxInstrument, start: number): Promise<boolean> {
    const day = okxArchiveDay(start)
    if (day < instrument.firstDay) return false
    const key = `${instrument.symbol}:${day}`
    if (this.present.has(key)) return true
    if ((this.missing.get(key) ?? 0) > Date.now()) return false
    const stored = await database().then(store => store.get('days', [instrument.symbol, day])).catch(() => undefined)
    if (stored) this.present.add(key)
    else {
      this.missing.set(key, Date.now() + 10_000)
      if (this.missing.size > 128) this.missing.delete(this.missing.keys().next().value!)
    }
    return !!stored
  }

  async loadHour(instrument: OkxInstrument, start: number): Promise<BybitTrade[] | null> {
    if (!await this.hasHour(instrument, start)) return null
    const key = `${instrument.symbol}:${start}`
    const pending = this.reads.get(key) ?? this.readHour(instrument, start)
    this.reads.delete(key)
    this.reads.set(key, pending)
    if (this.reads.size > 6) this.reads.delete(this.reads.keys().next().value!)
    try { return await pending }
    catch (error) {
      if (this.reads.get(key) === pending) this.reads.delete(key)
      throw error
    }
  }

  private async readHour(instrument: OkxInstrument, start: number): Promise<BybitTrade[]> {
    const bytes = await (await database()).get('hours', [instrument.symbol, start])
    if (!bytes) return []
    const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    const trades = new Map<string, BybitTrade>()
    for (const line of text.split('\n')) {
      const [timestamp, id, side, price, size] = line.split(',')
      if (trades.has(id)) continue
      trades.set(id, okxTrade(instrument, timestamp, id, side, price, size))
    }
    return [...trades.values()].sort(compareTrades)
  }

  download(instrument: OkxInstrument, day: string, signal: AbortSignal): Promise<boolean> {
    const key = `${instrument.symbol}:${day}`
    const pending = this.downloads.get(key)
    if (pending) return pending
    const work = this.downloadDay(instrument, day, signal).finally(() => this.downloads.delete(key))
    this.downloads.set(key, work)
    return work
  }

  private async downloadDay(instrument: OkxInstrument, day: string, signal: AbortSignal): Promise<boolean> {
    const start = archiveStart(day)
    if (day < instrument.firstDay) return false
    if (await this.hasHour(instrument, start)) return true
    const symbols = archiveSymbols(instrument, day)
    const families = symbols.map(symbol => symbol.replace(/-SWAP$/, '')).join(',')
    const query = new URLSearchParams({ module: '1', instType: 'SWAP', instFamilyList: families, dateAggrType: 'daily',
      begin: String(start), end: String(start) })
    const response = await this.fetcher.call(globalThis, `https://www.okx.com/api/v5/public/market-data-history?${query}`,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
    if (!response.ok) throw new Error(`读取 OKX 日档清单失败（HTTP ${response.status}）`)
    const result = await response.json()
    if (result.code !== '0' || !Array.isArray(result.data)) throw new Error('OKX 日档清单无效')
    const files = result.data.flatMap((group: { details: { groupDetails: unknown[] }[] }) => group.details.flatMap(item => item.groupDetails))
    const hours = Array.from({ length: 24 }, (): string[] => [])
    for (const symbol of symbols) {
      const filename = `${symbol}-trades-${day}.zip`
      const file = files.find((item: { filename?: string }) => item.filename === filename)
      if (!file) return false
      const url = new URL(file.url)
      if (url.origin !== 'https://static.okx.com' || !url.pathname.endsWith('/' + filename)) throw new Error('OKX 日档地址无效')
      const archive = await this.fetcher.call(globalThis, url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) })
      if (archive.status === 404) return false
      if (!archive.ok) throw new Error(`下载 OKX 日档失败（HTTP ${archive.status}）`)
      const bytes = new Uint8Array(await archive.arrayBuffer())
      const csv = await new Promise<Uint8Array>((resolve, reject) => {
        unzip(bytes, { filter: file => file.name.endsWith('.csv') }, (error, output) => {
          if (error) return reject(error)
          const entries = Object.values(output)
          if (entries.length !== 1) return reject(new Error('OKX 日档 ZIP 无效'))
          resolve(entries[0])
        })
      })
      signal.throwIfAborted()
      const rows = csvHours(new TextDecoder().decode(csv), symbol, instrument, start)
      for (const [hour, lines] of rows.entries()) if (lines.length) hours[hour].push(lines.join('\n'))
    }
    const compressed: [number, ArrayBuffer][] = []
    for (const [hour, lines] of hours.entries()) {
      if (!lines.length) continue
      signal.throwIfAborted()
      const input = new TextEncoder().encode(lines.join('\n'))
      lines.length = 0
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        gzip(input, { consume: true }, (error, output) => error ? reject(error) : resolve(Uint8Array.from(output).buffer))
      })
      compressed.push([hour, bytes])
    }
    signal.throwIfAborted()
    const transaction = (await database()).transaction(['days', 'hours'], 'readwrite')
    const writes = compressed.map(([hour, bytes]) =>
      transaction.objectStore('hours').put(bytes, [instrument.symbol, start + hour * BYBIT_HOUR_MS]))
    await Promise.all([...writes, transaction.objectStore('days').put(true, [instrument.symbol, day]), transaction.done])
    this.present.add(`${instrument.symbol}:${day}`)
    this.missing.delete(`${instrument.symbol}:${day}`)
    return true
  }
}
