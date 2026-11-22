import { openDB, type DBSchema } from 'idb'
import { nextOpenTime } from '../market-data/intervals'
import type { CombinedBybitSource, TradeRange } from '../market-data/bybit/combined-source'
import type { BybitTrade } from '../market-data/bybit/trades'

export interface TradeBubble {
  offset: number
  trade: BybitTrade
}

export interface TradeBar {
  cursor: number
  volume: number
  firstPrice?: number
  points: TradeBubble[]
  complete: boolean
  archived: boolean
}

interface BarCache extends DBSchema {
  bars: { key: [string, number]; value: TradeBar & { start: number } }
}

let cache: ReturnType<typeof openDB<BarCache>> | undefined
function database() {
  return cache ??= openDB<BarCache>('workstation-bybit-computed-bars-v1', 1, {
    upgrade: db => db.createObjectStore('bars'),
  })
}

interface BarScan extends TradeRange {
  start: number
  end: number
  previous?: TradeBar
  delta: TradeBar
}

export class OrderFlowBars {
  private readonly bars = new Map<number, TradeBar>()
  private readonly checked = new Set<number>()
  private clipped?: { start: number; bar: TradeBar }

  constructor(readonly key: string, readonly timeframe: string, private readonly minimum: number) {}

  read(start: number, untilUs: number): TradeBar | undefined {
    const bar = this.bars.get(start)
    if (bar && bar.cursor <= untilUs) return bar
    if (this.clipped?.start === start && this.clipped.bar.cursor <= untilUs) return this.clipped.bar
  }

  invalidate({ fromUs, untilUs }: TradeRange): void {
    for (const [start, bar] of this.bars) {
      if (!bar.archived && start * 1000 < untilUs && nextOpenTime(start, this.timeframe) * 1000 > fromUs) this.bars.delete(start)
    }
    this.clipped = undefined
  }

  async load(starts: readonly number[], cursor: number, source: CombinedBybitSource, signal: AbortSignal,
    onUpdate: () => void): Promise<void> {
    const pending = starts.filter(start => start * 1000 < cursor && !this.checked.has(start))
    if (pending.length) {
      await this.restore(pending, signal)
      onUpdate()
    }
    const groups: BarScan[][] = []
    for (const start of starts) {
      if (start * 1000 >= cursor) break
      const end = nextOpenTime(start, this.timeframe) * 1000
      const untilUs = Math.min(end, cursor)
      const previous = this.read(start, untilUs)
      const fromUs = previous?.cursor ?? start * 1000
      if (untilUs <= fromUs) continue
      const scan = { start, end, fromUs, untilUs, previous,
        delta: { cursor: untilUs, volume: 0, points: [], complete: true, archived: true } }
      const group = groups.at(-1)
      if (group?.at(-1)?.untilUs === fromUs) group.push(scan)
      else groups.push([scan])
    }
    for (const group of groups) {
      signal.throwIfAborted()
      await this.scan(group, source, signal)
      onUpdate()
    }
  }

  private async restore(starts: readonly number[], signal: AbortSignal): Promise<void> {
    try {
      const db = await database()
      const range = IDBKeyRange.bound([this.key, starts[0]], [this.key, starts.at(-1)!])
      const restored = await db.getAll('bars', range)
      signal.throwIfAborted()
      for (const bar of restored) {
        const start = bar.start
        this.bars.set(start, bar)
      }
    } catch {
      signal.throwIfAborted()
    }
    for (const start of starts) this.checked.add(start)
  }

  private async scan(group: BarScan[], source: CombinedBybitSource, signal: AbortSignal): Promise<void> {
    let tradeIndex = 0
    let coverageIndex = 0
    let scannedUntil = group[0].fromUs
    await source.visitTrades({ fromUs: group[0].fromUs, untilUs: group.at(-1)!.untilUs }, trade => {
      while (trade.timeUs >= group[tradeIndex].untilUs) tradeIndex++
      const { start, end, delta } = group[tradeIndex]
      delta.volume += trade.size
      delta.firstPrice ??= trade.price
      if (trade.price * trade.size >= this.minimum) {
        const open = start * 1000
        delta.points.push({ trade, offset: (trade.timeUs - open) / (end - open) - 0.5 })
      }
    }, signal, coverage => {
      scannedUntil = coverage.untilUs
      while (coverageIndex < group.length && group[coverageIndex].untilUs <= coverage.fromUs) coverageIndex++
      for (let index = coverageIndex; index < group.length && group[index].fromUs < coverage.untilUs; index++) {
        group[index].delta.complete &&= coverage.complete
        group[index].delta.archived &&= coverage.archived
      }
    })
    signal.throwIfAborted()
    const persist: [number, TradeBar][] = []
    for (const { start, end, fromUs, delta, previous } of group) {
      if (scannedUntil <= fromUs) break
      delta.cursor = Math.min(delta.cursor, scannedUntil)
      if (previous) {
        previous.cursor = delta.cursor
        previous.volume += delta.volume
        previous.firstPrice ??= delta.firstPrice
        previous.complete &&= delta.complete
        previous.archived &&= delta.archived
        for (const point of delta.points) previous.points.push(point)
      }
      const bar = previous ?? delta
      if ((this.bars.get(start)?.cursor ?? -Infinity) > bar.cursor) {
        this.clipped = { start, bar }
      } else {
        this.bars.set(start, bar)
        if (this.clipped?.start === start) this.clipped = undefined
      }
      if (bar.archived && bar.cursor === end) persist.push([start, bar])
    }
    if (persist.length) void this.save(persist)
  }

  private async save(bars: [number, TradeBar][]): Promise<void> {
    try {
      const db = await database()
      const tx = db.transaction('bars', 'readwrite')
      await Promise.all([...bars.map(([start, bar]) => tx.store.put({ ...bar, start }, [this.key, start])), tx.done])
    } catch {
      // Computed data remains available in memory if storage is unavailable.
    }
  }
}
