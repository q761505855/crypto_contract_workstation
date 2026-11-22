import { openDB, type DBSchema } from 'idb'
import type { CombinedBybitSource, TradeRange } from '../market-data/bybit/combined-source'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS } from '../market-data/bybit/trades'
import { AccumulatedHour, HistoryPageSamples, archiveLookahead, includeHour, orderTradeHours, type HourSamples, type TradeBar } from './order-flow-bars'

interface ReplayFlowCache extends DBSchema {
  days: { key: [string, number]; value: HourSamples[] }
}

let cache: ReturnType<typeof openDB<ReplayFlowCache>> | undefined
function database() {
  return cache ??= openDB<ReplayFlowCache>('workstation-bybit-replay-flow', 1, {
    upgrade: db => db.createObjectStore('days'),
  })
}

type CapturedTrades = Pick<CombinedBybitSource, 'readSocketTrades' | 'capturedFromUs' | 'capturedUntilUs'> &
  Partial<Pick<CombinedBybitSource, 'hasCapturedCoverage' | 'historyPages'>>

export class ReplayOrderFlow {
  private readonly days = new Map<number, (HourSamples | null | undefined)[]>()
  private readonly liveHours = new Map<number, { cursor: number; samples: AccumulatedHour }>()
  private readonly history: HistoryPageSamples
  private readonly missing = new Map<number, number>()
  private readonly bars = new Map<number, TradeBar>()

  constructor(readonly key: string, private readonly minimum: number, private readonly legacyKeys: readonly string[] = []) {
    this.history = new HistoryPageSamples(minimum)
  }

  invalidate(range: TradeRange): void {
    if (range.replaceArchive) {
      for (const day of this.days.keys()) {
        if (day * 1000 < range.untilUs && (day + BYBIT_DAY_MS) * 1000 > range.fromUs) this.days.delete(day)
      }
    }
    this.invalidateBars(range)
    for (const day of this.missing.keys()) {
      if (day * 1000 < range.untilUs && (day + BYBIT_DAY_MS) * 1000 > range.fromUs) this.missing.delete(day)
    }
    for (const [hour, section] of this.liveHours) {
      if (hour * 1000 < range.untilUs && section.cursor > range.fromUs) this.liveHours.delete(hour)
    }
  }

  acceptHistory(range: TradeRange, source: CombinedBybitSource): void {
    this.history.accept(range, source)
    this.invalidateBars(range)
  }

  private invalidateBars(range: TradeRange): void {
    for (const [start, bar] of this.bars) {
      if (start * 1000 < range.untilUs && bar.cursor > range.fromUs) this.bars.delete(start)
    }
  }

  async prepare(days: Iterable<number>, source: Pick<CombinedBybitSource, 'hasArchivedDay' | 'readArchivedHour'> &
    Partial<Pick<CombinedBybitSource, 'shouldPersistArchiveDay' | 'downloadAnchorUs' | 'prefetchArchivedHour'>>, signal: AbortSignal,
    onUpdate: (range?: TradeRange) => void): Promise<void> {
    const pending: number[] = []
    for (const day of orderTradeHours(days, source.downloadAnchorUs)) {
      signal.throwIfAborted()
      let hours = this.days.get(day)
      if (!hours) {
        if ((this.missing.get(day) ?? 0) > Date.now()) continue
        const stored = await this.restoreDay(day).catch(() => undefined)
        signal.throwIfAborted()
        if (stored) {
          this.days.set(day, stored)
          this.invalidateBars({ fromUs: day * 1000, untilUs: (day + BYBIT_DAY_MS) * 1000 })
          onUpdate()
          continue
        }
        const available = await source.hasArchivedDay(day)
        signal.throwIfAborted()
        if (!available) {
          this.missing.set(day, Date.now() + 30_000)
          continue
        }
        hours = Array.from({ length: BYBIT_DAY_MS / BYBIT_HOUR_MS })
        this.days.set(day, hours)
      }
      for (let index = 0; index < hours.length; index++) {
        if (hours[index] === undefined) pending.push(day + index * BYBIT_HOUR_MS)
      }
    }

    const ordered = orderTradeHours(pending, source.downloadAnchorUs)
    const prefetch = archiveLookahead(ordered, source, signal)
    for (let index = 0; index < ordered.length; index++) {
      signal.throwIfAborted()
      prefetch(index)
      const hour = ordered[index]
      const day = Math.floor(hour / BYBIT_DAY_MS) * BYBIT_DAY_MS
      const hours = this.days.get(day)!
      const range = { fromUs: hour * 1000, untilUs: (hour + BYBIT_HOUR_MS) * 1000 }
      onUpdate(range)
      const trades = await source.readArchivedHour(hour)
      signal.throwIfAborted()
      const samples = new AccumulatedHour()
      for (const trade of trades ?? []) samples.add(trade, hour, this.minimum)
      hours[(hour - day) / BYBIT_HOUR_MS] = trades ? samples.pack() : null
      this.invalidateBars(range)
      onUpdate()
      if (hours.every(section => section !== undefined && section !== null) && await (source.shouldPersistArchiveDay?.(day) ?? true)) {
        const completed = [...hours]
        void database().then(db => db.put('days', completed, [this.key, day])).catch(() => undefined)
      }
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
      for (let hour = Math.floor(from / BYBIT_HOUR_MS) * BYBIT_HOUR_MS; hour < until; hour += BYBIT_HOUR_MS) {
        const hourEnd = Math.min(hour + BYBIT_HOUR_MS, until) * 1000
        const archived = hours?.[(hour - day) / BYBIT_HOUR_MS]
        const begin = Math.max(hour, from) * 1000
        const captured = source.hasCapturedCoverage?.(begin, hourEnd)
        bar.complete &&= !!archived || !!captured
        if (archived) includeHour(bar, archived, hour, begin, hourEnd)
        else this.history.include(bar, source.historyPages?.(hour) ?? [], this.readCapturedHour(hour, source), hour, begin, hourEnd)
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
    for (const trade of source.readSocketTrades(fromUs, untilUs)) section.samples.add(trade, hour, this.minimum)
    section.cursor = untilUs
    this.liveHours.set(hour, section)
    return section.samples
  }
}
