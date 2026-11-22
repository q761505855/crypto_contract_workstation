import { openDB, type DBSchema } from 'idb'
import type { CombinedBybitSource, TradeRange } from '../market-data/bybit/combined-source'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS } from '../market-data/bybit/trades'
import { AccumulatedHour, includeHour, type HourSamples, type TradeBar } from './order-flow-bars'

interface ReplayFlowCache extends DBSchema {
  days: { key: [string, number]; value: HourSamples[] }
}

let cache: ReturnType<typeof openDB<ReplayFlowCache>> | undefined
function database() {
  return cache ??= openDB<ReplayFlowCache>('workstation-bybit-replay-flow', 1, {
    upgrade: db => db.createObjectStore('days'),
  })
}

type CapturedTrades = Pick<CombinedBybitSource, 'readReplayLive' | 'capturedFromUs' | 'capturedUntilUs'>

export class ReplayOrderFlow {
  private readonly days = new Map<number, HourSamples[]>()
  private readonly liveHours = new Map<number, { cursor: number; samples: AccumulatedHour }>()
  private readonly missing = new Map<number, number>()
  private readonly bars = new Map<number, TradeBar>()

  constructor(readonly key: string, private readonly minimum: number, private readonly legacyKeys: readonly string[] = []) {}

  invalidate(range: TradeRange): void {
    for (const [start, bar] of this.bars) {
      if (start * 1000 < range.untilUs && bar.cursor > range.fromUs) this.bars.delete(start)
    }
    for (const day of this.missing.keys()) {
      if (day * 1000 < range.untilUs && (day + BYBIT_DAY_MS) * 1000 > range.fromUs) this.missing.delete(day)
    }
    for (const [hour, section] of this.liveHours) {
      if (hour * 1000 < range.untilUs && section.cursor > range.fromUs) this.liveHours.delete(hour)
    }
  }

  async prepare(days: Iterable<number>, source: Pick<CombinedBybitSource, 'hasArchivedDay' | 'readArchivedHour'>, signal: AbortSignal,
    onUpdate: (range?: TradeRange) => void): Promise<void> {
    for (const day of days) {
      signal.throwIfAborted()
      if (this.days.has(day) || (this.missing.get(day) ?? 0) > Date.now()) continue
      const stored = await this.restoreDay(day).catch(() => undefined)
      signal.throwIfAborted()
      if (stored) {
        this.days.set(day, stored)
        this.invalidate({ fromUs: day * 1000, untilUs: (day + BYBIT_DAY_MS) * 1000 })
        onUpdate()
        continue
      }
      const available = await source.hasArchivedDay(day)
      signal.throwIfAborted()
      if (!available) {
        this.missing.set(day, Date.now() + 30_000)
        continue
      }
      const until = day + BYBIT_DAY_MS
      onUpdate({ fromUs: day * 1000, untilUs: until * 1000 })
      const hours: HourSamples[] = []
      for (let hour = day; hour < until; hour += BYBIT_HOUR_MS) {
        const trades = await source.readArchivedHour(hour)
        signal.throwIfAborted()
        if (trades === null) throw new Error('Bybit 日档尚未完整就绪')
        const samples = new AccumulatedHour()
        for (const trade of trades) samples.add(trade, hour, this.minimum)
        hours.push(samples.pack())
      }
      this.days.set(day, hours)
      this.invalidate({ fromUs: day * 1000, untilUs: until * 1000 })
      onUpdate()
      void database().then(db => db.put('days', hours, [this.key, day])).catch(() => undefined)
    }
  }

  private async restoreDay(day: number): Promise<HourSamples[] | undefined> {
    const db = await database()
    const cached = await db.get('days', [this.key, day])
    if (cached) return cached
    for (const key of this.legacyKeys) {
      const legacy = await db.get('days', [key, day])
      if (legacy) {
        void db.put('days', legacy, [this.key, day]).catch(() => undefined)
        return legacy
      }
    }
  }

  read(start: number, untilUs: number, source: CapturedTrades): TradeBar {
    const previous = this.bars.get(start)
    if (previous?.cursor === untilUs) return previous
    const bar: TradeBar = { cursor: untilUs, volume: 0, pointRanges: [], complete: true }
    for (let from = start; from * 1000 < untilUs;) {
      const day = Math.floor(from / BYBIT_DAY_MS) * BYBIT_DAY_MS
      const until = Math.min(untilUs / 1000, day + BYBIT_DAY_MS)
      const hours = this.days.get(day)
      bar.complete &&= !!hours
      for (let hour = Math.floor(from / BYBIT_HOUR_MS) * BYBIT_HOUR_MS; hour < until; hour += BYBIT_HOUR_MS) {
        const section = hours ? hours[(hour - day) / BYBIT_HOUR_MS] : this.readCapturedHour(hour, source)
        if (section) includeHour(bar, section, hour, Math.max(hour, from) * 1000, Math.min(hour + BYBIT_HOUR_MS, until) * 1000)
      }
      from = until
    }
    this.bars.set(start, bar)
    return bar
  }

  private readCapturedHour(hour: number, source: CapturedTrades): HourSamples | undefined {
    const untilUs = Math.min(source.capturedUntilUs, (hour + BYBIT_HOUR_MS) * 1000)
    let section = this.liveHours.get(hour)
    const fromUs = Math.max(section?.cursor ?? hour * 1000, source.capturedFromUs)
    if (untilUs <= fromUs) return section?.samples
    section ??= { cursor: fromUs, samples: new AccumulatedHour() }
    for (const trade of source.readReplayLive({ fromUs, untilUs })) section.samples.add(trade, hour, this.minimum)
    section.cursor = untilUs
    this.liveHours.set(hour, section)
    return section.samples
  }
}
