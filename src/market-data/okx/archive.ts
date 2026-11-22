import { openDB, type DBSchema } from 'idb'
import { BYBIT_HOUR_MS, bybitDay, type BybitTrade } from '../bybit/trades'
import { defaultStorageTarget } from '../../github-sync/default-storage'
import type { GitHubRepositoryTarget } from '../../github-sync/github-client'
import { BybitArchive } from '../bybit/archive'
import { compareTrades, okxTrade, type OkxInstrument } from './trades'

const offset = 8 * BYBIT_HOUR_MS
export const okxArchiveDay = (time: number): string => bybitDay(time + offset)

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
  private readonly published = new Set<string>()
  private readonly present = new Set<string>()
  private readonly missing = new Map<string, number>()
  private readonly reads = new Map<string, Promise<BybitTrade[]>>()

  constructor(target: GitHubRepositoryTarget = defaultStorageTarget(), fetcher: typeof fetch = fetch, now = Date.now) {
    this.cloud = new BybitArchive<string>(target, fetcher, now, { root: 'data/okx-trades',
      firstDay: () => '2021-09-01', allowEmpty: true })
  }

  async hasCloudDay(instrument: OkxInstrument, day: string, ref?: string): Promise<boolean> {
    if (day < instrument.firstDay) return false
    const available = await this.cloud.hasDay(instrument.symbol, day, ref)
    if (available) this.published.add(instrument.symbol + ':' + day)
    return available
  }

  isCachedHour(instrument: OkxInstrument, start: number): boolean {
    return this.published.has(instrument.symbol + ':' + bybitDay(start)) || this.present.has(`${instrument.symbol}:${okxArchiveDay(start)}`)
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
      const trades = await this.cloud.loadHour(instrument.symbol, start)
      if (trades) return trades.map(trade => ({ ...trade, size: trade.size * instrument.contractValue, venue: 'OKX' }))
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
