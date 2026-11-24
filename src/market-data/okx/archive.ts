import { openDB, type DBSchema } from 'idb'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, bybitDay, bybitDayStart, type BybitTrade } from '../bybit/trades'
import { defaultStorageTarget } from '../../github-sync/default-storage'
import type { GitHubContentsClient, GitHubRepositoryTarget } from '../../github-sync/github-client'
import { BybitArchive } from '../bybit/archive'
import { compareTrades, okxTrade, type OkxInstrument } from './trades'

const offset = 8 * BYBIT_HOUR_MS
export const okxArchiveDay = (time: number): string => bybitDay(time + offset)
export const okxArchiveDayStart = (day: string): number => bybitDayStart(day) - offset
export const okxArchiveDayEnd = (day: string): number => okxArchiveDayStart(day) + BYBIT_DAY_MS - 1

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

export class OkxArchive {
  private readonly cloud: BybitArchive<string>
  private readonly present = new Set<string>()
  private readonly missing = new Map<string, number>()
  private readonly reads = new Map<string, Promise<BybitTrade[]>>()

  constructor(target: GitHubRepositoryTarget | GitHubContentsClient = defaultStorageTarget(), private readonly fetcher: typeof fetch = fetch, now = Date.now) {
    this.cloud = new BybitArchive<string>(target, fetcher, now, { root: 'data/okx-trades',
      firstDay: () => '2021-09-01', allowEmpty: true })
  }

  async hasCloudDay(instrument: OkxInstrument, day: string, ref?: string): Promise<boolean> {
    if (day < instrument.firstDay) return false
    return this.cloud.hasDay(instrument.symbol, day, ref)
  }

  async hasSourceDay(instrument: OkxInstrument, day: string, signal: AbortSignal): Promise<boolean> {
    const start = bybitDayStart(day)
    const next = bybitDay(start + BYBIT_DAY_MS)
    const symbols = (date: string) => {
      if (instrument.symbol !== 'XAU-USDT-SWAP' || date > '2026-01-15') return [instrument.symbol]
      return date === '2026-01-15' ? ['XAUT-USDT-SWAP', instrument.symbol] : ['XAUT-USDT-SWAP']
    }
    // The source files are cut at UTC+8. A UTC day spans two files.
    const families = new Set([day, next].flatMap(symbols).map(symbol => symbol.replace(/-SWAP$/, '')))
    const query = new URLSearchParams({ module: '1', instType: 'SWAP', dateAggrType: 'daily', instFamilyList: [...families].join(','),
      begin: String(start - offset), end: String(start + BYBIT_DAY_MS - offset) })
    const response = await this.fetcher.call(globalThis, `https://www.okx.com/api/v5/public/market-data-history?${query}`,
      { credentials: 'omit', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) })
    if (!response.ok) throw new Error(`OKX 官方日档查询失败（HTTP ${response.status}）`)
    const result: { code?: string; data?: { details: { groupDetails: { filename: string }[] }[] }[] } = await response.json()
    if (result.code !== '0' || !Array.isArray(result.data)) throw new Error('OKX 官方日档查询返回无效结果')
    const files = new Set(result.data.flatMap(group => group.details.flatMap(item =>
      item.groupDetails.map(file => file.filename))))
    return [day, next].every(date => symbols(date).every(symbol => files.has(`${symbol}-trades-${date}.zip`)))
  }

  async hasHour(instrument: OkxInstrument, start: number): Promise<boolean> {
    if (await this.hasCloudDay(instrument, bybitDay(start)).catch(() => false)) return true
    return this.hasLocalHour(instrument, start)
  }

  private async hasLocalHour(instrument: OkxInstrument, start: number): Promise<boolean> {
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
    if (await this.hasCloudDay(instrument, bybitDay(start)).catch(() => false)) {
      const trades = await this.cloud.loadHour(instrument.symbol, start, instrument.contractValue)
      if (trades) return trades
    }
    if (!await this.hasLocalHour(instrument, start)) return null
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

  async prefetchHour(instrument: OkxInstrument, start: number): Promise<boolean> {
    if (bybitDay(start) < instrument.firstDay) return false
    return await this.cloud.prefetchHour(instrument.symbol, start) || this.hasLocalHour(instrument, start)
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
}
