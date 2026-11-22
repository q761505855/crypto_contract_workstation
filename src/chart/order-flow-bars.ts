import { openDB, type DBSchema } from 'idb'
import { nextOpenTime } from '../market-data/intervals'
import type { CombinedBybitSource, TradeRange } from '../market-data/bybit/combined-source'
import { BYBIT_HOUR_MS, type BybitTrade } from '../market-data/bybit/trades'

export interface TradeBubble { trade: BybitTrade }

interface BubbleRange {
  points: readonly TradeBubble[]
  from: number
  until: number
}

export interface TradeBar {
  cursor: number
  volume: number
  firstPrice?: number
  firstBybitPrice?: number
  pointRanges: BubbleRange[]
  complete: boolean
}

export function* tradeBubbles(bar: TradeBar): Iterable<TradeBubble> {
  for (const { points, from, until } of bar.pointRanges) {
    for (let index = from; index < until; index++) yield points[index]
  }
}

export interface HourSamples {
  times: ArrayLike<number>
  volume: ArrayLike<number>
  firstPrices: ArrayLike<number>
  bybitTimes?: ArrayLike<number>
  bybitPrices?: ArrayLike<number>
  points: TradeBubble[]
}

export class AccumulatedHour implements HourSamples {
  readonly times: number[] = []
  readonly volume: number[] = [0]
  readonly firstPrices: number[] = []
  readonly bybitTimes: number[] = []
  readonly bybitPrices: number[] = []
  readonly points: TradeBubble[] = []

  add(trade: BybitTrade, hour: number, minimum: number): void {
    const offset = Math.floor(trade.timeUs / 1000) - hour
    this.addSample(offset, trade.size, trade.price)
    if (!trade.venue && this.bybitTimes.at(-1) !== offset) {
      this.bybitTimes.push(offset)
      this.bybitPrices.push(trade.price)
    }
    if (trade.price * trade.size >= minimum) this.points.push({ trade })
  }

  append(other: HourSamples): void {
    const previousTotal = this.volume[this.times.length]
    for (let index = 0; index < other.times.length; index++) {
      const offset = other.times[index]
      if (offset !== this.times.at(-1)) {
        this.times.push(offset)
        this.firstPrices.push(other.firstPrices[index])
      }
      this.volume[this.times.length] = previousTotal + other.volume[index + 1]
    }
    for (let index = 0; index < (other.bybitTimes?.length ?? 0); index++) {
      const offset = other.bybitTimes![index]
      if (this.bybitTimes.at(-1) !== offset) {
        this.bybitTimes.push(offset)
        this.bybitPrices.push(other.bybitPrices![index])
      }
    }
    for (const point of other.points) this.points.push(point)
  }

  pack(): HourSamples {
    return { times: Uint32Array.from(this.times), volume: Float64Array.from(this.volume),
      firstPrices: Float64Array.from(this.firstPrices), bybitTimes: Uint32Array.from(this.bybitTimes),
      bybitPrices: Float64Array.from(this.bybitPrices), points: this.points }
  }

  private addSample(offset: number, size: number, price: number): void {
    const total = this.volume[this.times.length] + size
    if (offset !== this.times.at(-1)) {
      this.times.push(offset)
      this.firstPrices.push(price)
    }
    this.volume[this.times.length] = total
  }
}

function lowerBound(length: number, time: number, at: (index: number) => number): number {
  let lo = 0
  let hi = length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (at(mid) < time) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function includeHour(bar: TradeBar, section: HourSamples, hour: number, fromUs: number, untilUs: number): void {
  const lo = lowerBound(section.times.length, fromUs / 1000 - hour, index => section.times[index])
  const hi = lowerBound(section.times.length, untilUs / 1000 - hour, index => section.times[index])
  if (lo < hi) {
    bar.volume += section.volume[hi] - section.volume[lo]
    bar.firstPrice ??= section.firstPrices[lo]
    const times = section.bybitTimes ?? section.times
    const prices = section.bybitPrices ?? section.firstPrices
    const index = lowerBound(times.length, fromUs / 1000 - hour, item => times[item])
    if (times[index] < untilUs / 1000 - hour) bar.firstBybitPrice ??= prices[index]
  }
  const points = section.points
  const from = lowerBound(points.length, fromUs, index => points[index].trade.timeUs)
  const until = lowerBound(points.length, untilUs, index => points[index].trade.timeUs)
  if (from < until) bar.pointRanges.push({ points, from, until })
}

interface FlowHour {
  cursor: number
  samples: HourSamples
  complete: boolean
  archived: boolean
  fallbackArchive?: boolean
}

interface HourCache extends DBSchema {
  hours: { key: [string, number]; value: FlowHour & { hour: number } }
}

let cache: ReturnType<typeof openDB<HourCache>> | undefined
function database() {
  return cache ??= openDB<HourCache>('workstation-bybit-computed-hours', 1, {
    upgrade: db => db.createObjectStore('hours'),
  })
}

interface HourScan extends TradeRange {
  hour: number
  samples: AccumulatedHour
  complete: boolean
  archived: boolean
  fallbackArchive: boolean
}

const hourOf = (time: number) => Math.floor(time / BYBIT_HOUR_MS) * BYBIT_HOUR_MS

export class OrderFlowBars {
  private readonly hours = new Map<number, FlowHour>()
  private readonly checked = new Set<number>()
  private readonly bars = new Map<number, TradeBar>()

  constructor(readonly key: string, private readonly minimum: number) {}

  read(start: number, untilUs: number): TradeBar {
    const cached = this.bars.get(start)
    if (cached?.cursor === untilUs) return cached
    const bar: TradeBar = { cursor: untilUs, volume: 0, pointRanges: [], complete: true }
    for (let hour = hourOf(start); hour * 1000 < untilUs; hour += BYBIT_HOUR_MS) {
      const rangeEnd = Math.min((hour + BYBIT_HOUR_MS) * 1000, untilUs)
      const section = this.hours.get(hour)
      if (section) includeHour(bar, section.samples, hour, Math.max(start, hour) * 1000, Math.min(section.cursor, rangeEnd))
      bar.complete &&= !!section?.complete && section.cursor >= rangeEnd
    }
    this.bars.set(start, bar)
    return bar
  }

  invalidate(range: TradeRange): void {
    for (const [hour, section] of this.hours) {
      if ((!section.archived || section.fallbackArchive || range.replaceArchive) &&
          hour * 1000 < range.untilUs && (hour + BYBIT_HOUR_MS) * 1000 > range.fromUs) {
        this.hours.delete(hour)
        this.invalidateBars({ fromUs: hour * 1000, untilUs: (hour + BYBIT_HOUR_MS) * 1000 })
      }
    }
  }

  private invalidateBars({ fromUs, untilUs }: TradeRange): void {
    for (const [start, bar] of this.bars) {
      if (start * 1000 < untilUs && bar.cursor > fromUs) this.bars.delete(start)
    }
  }

  async load(starts: readonly number[], timeframe: string, cursor: number, source: CombinedBybitSource, signal: AbortSignal,
    onUpdate: (range?: TradeRange) => void): Promise<void> {
    const requested = new Set<number>()
    for (const start of starts) {
      if (start * 1000 >= cursor) break
      const end = Math.min(cursor, nextOpenTime(start, timeframe) * 1000)
      for (let hour = hourOf(start); hour * 1000 < end; hour += BYBIT_HOUR_MS) requested.add(hour)
    }
    const pending = [...requested].filter(hour => !this.checked.has(hour))
    if (pending.length) {
      await this.restore(pending, source, signal)
      onUpdate()
    }
    const groups: HourScan[][] = []
    for (const hour of requested) {
      const section = this.hours.get(hour)
      if (section?.fallbackArchive) source.requestRecentHours(hour, hour + BYBIT_HOUR_MS)
      const fromUs = section?.cursor ?? hour * 1000
      const untilUs = Math.min((hour + BYBIT_HOUR_MS) * 1000, cursor)
      if (untilUs <= fromUs) continue
      const scan = { hour, fromUs, untilUs, samples: new AccumulatedHour(), complete: true, archived: true, fallbackArchive: false }
      const group = groups.at(-1)
      if (group && group.length < 6 && group.at(-1)?.untilUs === fromUs) group.push(scan)
      else groups.push([scan])
    }
    for (const group of groups) {
      signal.throwIfAborted()
      const range = { fromUs: group[0].fromUs, untilUs: group.at(-1)!.untilUs }
      onUpdate(range)
      await this.scan(group, range, source, signal)
      onUpdate()
    }
  }

  private async restore(hours: readonly number[], source: CombinedBybitSource, signal: AbortSignal): Promise<void> {
    try {
      const db = await database()
      const range = IDBKeyRange.bound([this.key, hours[0]], [this.key, hours.at(-1)!])
      const restored = await db.getAll('hours', range)
      signal.throwIfAborted()
      for (const { hour, ...section } of restored) {
        if (section.fallbackArchive && await source.isOkxArchiveCachedAt(hour)) continue
        signal.throwIfAborted()
        this.hours.set(hour, section)
        this.checked.add(hour)
        this.invalidateBars({ fromUs: hour * 1000, untilUs: section.cursor })
      }
    } catch {
      signal.throwIfAborted()
    }
    for (const hour of hours) this.checked.add(hour)
  }

  private async scan(group: HourScan[], range: TradeRange, source: CombinedBybitSource, signal: AbortSignal): Promise<void> {
    let tradeIndex = 0
    let coverageIndex = 0
    let scannedUntil = range.fromUs
    await source.visitTrades(range, trade => {
      while (trade.timeUs >= group[tradeIndex].untilUs) tradeIndex++
      const { samples, hour } = group[tradeIndex]
      samples.add(trade, hour, this.minimum)
    }, signal, coverage => {
      scannedUntil = coverage.untilUs
      while (coverageIndex < group.length && group[coverageIndex].untilUs <= coverage.fromUs) coverageIndex++
      for (let index = coverageIndex; index < group.length && group[index].fromUs < coverage.untilUs; index++) {
        group[index].complete &&= coverage.complete
        group[index].archived &&= coverage.archived
        group[index].fallbackArchive ||= !!coverage.fallbackArchive
      }
    })
    signal.throwIfAborted()
    const persist: (FlowHour & { hour: number })[] = []
    for (const scan of group) {
      if (scannedUntil <= scan.fromUs) break
      const { hour } = scan
      const previous = this.hours.get(hour)
      const cursor = Math.min(scan.untilUs, scannedUntil)
      const samples = previous?.samples instanceof AccumulatedHour ? previous.samples : scan.samples
      if (samples !== scan.samples) samples.append(scan.samples)
      const complete = (previous?.complete ?? true) && scan.complete
      const archived = (previous?.archived ?? true) && scan.archived
      const sealed = archived && cursor === (hour + BYBIT_HOUR_MS) * 1000
      const fallbackArchive = (previous?.fallbackArchive ?? false) || scan.fallbackArchive
      const section = { cursor, samples: sealed ? samples.pack() : samples, complete, archived, fallbackArchive }
      this.hours.set(hour, section)
      if (sealed) persist.push({ ...section, hour })
    }
    this.invalidateBars({ fromUs: range.fromUs, untilUs: scannedUntil })
    if (persist.length) void this.save(persist)
  }

  private async save(hours: (FlowHour & { hour: number })[]): Promise<void> {
    try {
      const db = await database()
      const tx = db.transaction('hours', 'readwrite')
      await Promise.all([...hours.map(section => tx.store.put(section, [this.key, section.hour])), tx.done])
    } catch {
      // Computed data remains available in memory if storage is unavailable.
    }
  }
}
