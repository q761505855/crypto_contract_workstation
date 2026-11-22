import { openDB, type DBSchema } from 'idb'
import type { CombinedBybitSource, TradeRange } from '../market-data/bybit/combined-source'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, type BybitTrade } from '../market-data/bybit/trades'
import type { TradeBar, TradeBubble } from './order-flow-bars'

interface PreparedHour {
  times: Uint32Array
  volume: Float64Array
  firstPrices: Float64Array
  points: TradeBubble[]
}

interface ReplayFlowCache extends DBSchema {
  days: { key: [string, number]; value: PreparedHour[] }
}

let cache: ReturnType<typeof openDB<ReplayFlowCache>> | undefined
function database() {
  return cache ??= openDB<ReplayFlowCache>('workstation-bybit-replay-flow', 1, {
    upgrade: db => db.createObjectStore('days'),
  })
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

function prepareHour(hour: number, trades: readonly BybitTrade[], minimum: number): PreparedHour {
  const times: number[] = []
  const volume: number[] = [0]
  const firstPrices: number[] = []
  const points: TradeBubble[] = []
  let total = 0
  for (const trade of trades) {
    const offset = Math.floor(trade.timeUs / 1000) - hour
    if (offset !== times.at(-1)) {
      times.push(offset)
      firstPrices.push(trade.price)
    }
    total += trade.size
    volume[times.length] = total
    if (trade.price * trade.size >= minimum) points.push({ trade })
  }
  return { times: Uint32Array.from(times), volume: Float64Array.from(volume),
    firstPrices: Float64Array.from(firstPrices), points }
}

export class ReplayOrderFlow {
  private readonly days = new Map<number, PreparedHour[]>()
  private readonly missing = new Map<number, number>()
  private readonly bars = new Map<number, TradeBar>()

  constructor(readonly key: string, private readonly minimum: number) {}

  invalidate(range: TradeRange): void {
    for (const [start, bar] of this.bars) {
      if (start * 1000 < range.untilUs && bar.cursor > range.fromUs) this.bars.delete(start)
    }
    for (const day of this.missing.keys()) {
      if (day * 1000 < range.untilUs && (day + BYBIT_DAY_MS) * 1000 > range.fromUs) this.missing.delete(day)
    }
  }

  async prepare(days: Iterable<number>, source: Pick<CombinedBybitSource, 'hasArchivedDay' | 'readArchivedHour'>, signal: AbortSignal,
    onUpdate: (range?: TradeRange) => void): Promise<void> {
    for (const day of days) {
      signal.throwIfAborted()
      if (this.days.has(day) || (this.missing.get(day) ?? 0) > Date.now()) continue
      const stored = await database().then(db => db.get('days', [this.key, day])).catch(() => undefined)
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
      const hours: PreparedHour[] = []
      for (let hour = day; hour < until; hour += BYBIT_HOUR_MS) {
        const trades = await source.readArchivedHour(hour)
        signal.throwIfAborted()
        if (trades === null) throw new Error('Bybit 日档尚未完整就绪')
        hours.push(prepareHour(hour, trades, this.minimum))
      }
      this.days.set(day, hours)
      this.invalidate({ fromUs: day * 1000, untilUs: until * 1000 })
      onUpdate()
      void database().then(db => db.put('days', hours, [this.key, day])).catch(() => undefined)
    }
  }

  read(start: number, untilUs: number, source: Pick<CombinedBybitSource, 'readReplayLive'>): TradeBar {
    const previous = this.bars.get(start)
    if (previous?.cursor === untilUs) return previous
    const pointRanges: NonNullable<TradeBar['pointRanges']> = []
    const bar: TradeBar = { cursor: untilUs, volume: 0, points: [], pointRanges, complete: true, archived: true }
    for (let from = start; from * 1000 < untilUs;) {
      const day = Math.floor(from / BYBIT_DAY_MS) * BYBIT_DAY_MS
      const until = Math.min(untilUs / 1000, day + BYBIT_DAY_MS)
      const hours = this.days.get(day)
      if (hours) {
        for (let hour = Math.floor(from / BYBIT_HOUR_MS) * BYBIT_HOUR_MS; hour < until; hour += BYBIT_HOUR_MS) {
          const section = hours[(hour - day) / BYBIT_HOUR_MS]
          const low = Math.max(hour, from)
          const high = Math.min(hour + BYBIT_HOUR_MS, until)
          const lo = lowerBound(section.times.length, low - hour, index => section.times[index])
          const hi = lowerBound(section.times.length, high - hour, index => section.times[index])
          if (lo < hi) {
            bar.volume += section.volume[hi] - section.volume[lo]
            bar.firstPrice ??= section.firstPrices[lo]
          }
          const points = section.points
          const first = lowerBound(points.length, low * 1000, index => points[index].trade.timeUs)
          const last = lowerBound(points.length, high * 1000, index => points[index].trade.timeUs)
          if (first < last) pointRanges.push({ points, from: first, until: last })
        }
      } else {
        bar.complete = false
        bar.archived = false
        const points: TradeBubble[] = []
        for (const trade of source.readReplayLive({ fromUs: from * 1000, untilUs: until * 1000 })) {
          bar.volume += trade.size
          bar.firstPrice ??= trade.price
          if (trade.price * trade.size >= this.minimum) points.push({ trade })
        }
        if (points.length) pointRanges.push({ points, from: 0, until: points.length })
      }
      from = until
    }
    this.bars.set(start, bar)
    return bar
  }
}
