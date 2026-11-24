import { CANDLE_TRADE_STRIDE, type OrderFlowTask, type OrderFlowTaskResult, type OrderFlowWorkerReply, type TradeColumns } from './order-flow-worker-tasks'
import type { TradeBar } from './order-flow-bars'
import type { BubbleResult, BubbleTask, FootprintTask } from './order-flow-worker-tasks'
import { largestTradeAmounts, type DisplayedTradeBubble } from './order-flow-bubbles'
import { footprintRowsFromLevels, mergeFootprintLevels } from './order-flow-metrics'
import { reserveWorker, workerCapacity } from '../market-data/worker-capacity'

interface Job {
  input: () => OrderFlowTask | Promise<OrderFlowTask>
  signal: AbortSignal
  resolve(result: OrderFlowTaskResult): void
  reject(error: unknown): void
  cancel(): void
}

interface Slot { worker: Worker; job?: Job; release?: () => void }

export class OrderFlowWorkers {
  readonly parallelism = workerCapacity
  private readonly slots = new Set<Slot>()
  private readonly waiting: Job[] = []
  private disabled = false

  get available(): boolean { return this.parallelism > 0 && !this.disabled }

  run<T extends OrderFlowTask>(input: () => T | Promise<T>, signal: AbortSignal, urgent = false): Promise<OrderFlowTaskResult<T>> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted()
      if (!this.available) throw new Error('后台计算不可用')
      const job: Job = { input, signal, resolve: result => resolve(result as OrderFlowTaskResult<T>), reject, cancel: () => {
        const slot = [...this.slots].find(slot => slot.job === job)
        if (slot) this.retire(slot)
        else {
          const index = this.waiting.indexOf(job)
          if (index >= 0) this.waiting.splice(index, 1)
        }
        signal.removeEventListener('abort', job.cancel)
        reject(signal.reason)
        this.pump()
      } }
      signal.addEventListener('abort', job.cancel, { once: true })
      if (urgent) this.waiting.unshift(job)
      else this.waiting.push(job)
      this.pump()
    })
  }

  private pump(): void {
    while (this.waiting.length > 0 && this.available) {
      let slot = [...this.slots].find(slot => !slot.job)
      if (!slot) {
        if (this.slots.size >= this.parallelism) return
        try {
          slot = { worker: new Worker(new URL('./order-flow-compute.worker.ts', import.meta.url), { type: 'module' }) }
          this.slots.add(slot)
        } catch (error) {
          this.disable(error)
          return
        }
      }
      this.start(slot, this.waiting.shift()!)
    }
  }

  private start(slot: Slot, job: Job): void {
    slot.job = job
    const finish = (receive: () => void) => {
      if (slot.job !== job) return
      job.signal.removeEventListener('abort', job.cancel)
      slot.job = undefined
      slot.release?.()
      slot.release = undefined
      receive()
      this.pump()
    }
    slot.worker.onmessage = ({ data }: MessageEvent<OrderFlowWorkerReply>) =>
      finish(() => 'result' in data ? job.resolve(data.result) : job.reject(new Error(data.error)))
    slot.worker.onerror = event => { event.preventDefault(); this.disable(new Error('无法启动订单流后台计算')) }
    slot.worker.onmessageerror = () => this.disable(new Error('无法读取订单流后台计算结果'))
    void reserveWorker(job.signal).then(async release => {
      if (slot.job !== job) { release(); return }
      slot.release = release
      const task = await job.input()
      if (slot.job === job) slot.worker.postMessage(task, [task.values.buffer])
    }).catch(error => finish(() => job.reject(error)))
  }

  private retire(slot: Slot): void {
    this.slots.delete(slot)
    slot.job = undefined
    slot.release?.()
    slot.release = undefined
    slot.worker.terminate()
  }

  private disable(error: unknown): void {
    this.disabled = true
    const running = [...this.slots].flatMap(slot => slot.job ? [slot.job] : [])
    for (const slot of this.slots) this.retire(slot)
    for (const job of [...running, ...this.waiting.splice(0)]) {
      job.signal.removeEventListener('abort', job.cancel)
      job.reject(error)
    }
  }
}

export const orderFlowWorkers = new OrderFlowWorkers()
export const WORKER_TRADE_THRESHOLD = 2048

export function candleTradeCount(bar: TradeBar): number {
  return bar.pointRanges.reduce((count, range) => count + range.until - range.from, 0)
}

const CANDLE_BATCH_ROWS = 32_768

function candleRanges(bar: TradeBar) {
  let first = 0
  return bar.pointRanges.map(range => {
    const begin = first
    first += range.until - range.from
    return { ...range, begin, end: first }
  })
}

function* candleBatches(ranges: ReturnType<typeof candleRanges>, wholeMilliseconds: boolean): Iterable<[number, number]> {
  const count = ranges.at(-1)?.end ?? 0
  const millisecondAt = (row: number) => {
    const range = ranges.find(item => item.end > row)!
    return Math.floor(range.points[range.from + row - range.begin].trade.timeUs / 1000)
  }
  for (let first = 0; first < count;) {
    let end = Math.min(count, first + CANDLE_BATCH_ROWS)
    if (wholeMilliseconds && end < count && millisecondAt(end - 1) === millisecondAt(end)) {
      // All trades at one millisecond must stay together for exact bubble aggregation.
      const time = millisecondAt(end)
      let high = count
      while (end < high) {
        const mid = (end + high) >>> 1
        if (millisecondAt(mid) <= time) end = mid + 1
        else high = mid
      }
    }
    yield [first, end]
    first = end
  }
}

async function packCandleTrades(ranges: ReturnType<typeof candleRanges>, first: number, end: number,
  signal: AbortSignal): Promise<TradeColumns> {
  const values = new Float64Array((end - first) * CANDLE_TRADE_STRIDE)
  let index = 0
  let nextYield = performance.now() + 8
  for (const range of ranges) {
    for (let row = Math.max(first, range.begin); row < Math.min(end, range.end); row++) {
      if ((index & 32767) === 0) {
        if (performance.now() >= nextYield) {
          await new Promise(resolve => setTimeout(resolve, 0))
          nextYield = performance.now() + 8
        }
        signal.throwIfAborted()
      }
      const { trade } = range.points[range.from + row - range.begin]
      values[index++] = trade.price
      values[index++] = trade.side === 'buy' ? trade.size : -trade.size
      values[index++] = trade.timeUs
      values[index++] = Number(trade.venue === 'OKX')
    }
  }
  return values
}

async function runCandleBatches<Task extends FootprintTask | BubbleTask>(bar: TradeBar, wholeMilliseconds: boolean,
  input: (values: TradeColumns, firstRow: number) => Task, signal: AbortSignal): Promise<OrderFlowTaskResult<Task>[]> {
  const ranges = candleRanges(bar)
  const controller = new AbortController()
  const taskSignal = AbortSignal.any([signal, controller.signal])
  try {
    return await Promise.all([...candleBatches(ranges, wholeMilliseconds)].map(([first, end]) =>
      orderFlowWorkers.run(async () => input(await packCandleTrades(ranges, first, end, taskSignal), first), taskSignal)))
  } finally {
    controller.abort()
  }
}

export async function parallelFootprint(bar: TradeBar, input: Omit<FootprintTask, 'kind' | 'values'>,
  targetRows: number, signal: AbortSignal) {
  const batches = await runCandleBatches(bar, false, values => ({ kind: 'footprint', values, ...input }), signal)
  signal.throwIfAborted()
  return footprintRowsFromLevels(mergeFootprintLevels(batches), input.settings, input.precision, targetRows)
}

export async function parallelBubbles(bar: TradeBar, input: Omit<BubbleTask, 'kind' | 'values' | 'firstRow'>,
  signal: AbortSignal): Promise<DisplayedTradeBubble[]> {
  const batches = await runCandleBatches(bar, input.mode === 'aggregate',
    (values, firstRow) => ({ kind: 'bubbles', values, firstRow, ...input }), signal)
  signal.throwIfAborted()
  function* ranked() { for (const batch of batches) yield* batch }
  return restoreBubbleTrades(bar, largestTradeAmounts(ranked(), input.limit))
}

function restoreBubbleTrades(bar: TradeBar, results: BubbleResult[]): DisplayedTradeBubble[] {
  const bubbles: DisplayedTradeBubble[] = []
  let firstRow = 0
  let index = 0
  for (const { points, from, until } of bar.pointRanges) {
    const end = firstRow + until - from
    while (index < results.length && results[index].row < end) {
      const { row, size, amount, count } = results[index++]
      const { trade } = points[from + row - firstRow]
      bubbles.push({ trade: trade.size === size ? trade : { ...trade, size }, amount, count })
    }
    firstRow = end
  }
  return bubbles
}

export class CandleWorkerResults<Result> {
  version = 0
  private results = new WeakMap<TradeBar, { key: string; result?: Result; failed?: boolean }>()
  private pending = new Map<TradeBar, AbortController>()

  constructor(private readonly changed: () => void) {}

  get(bar: TradeBar, key: string, calculate: (signal: AbortSignal) => Promise<Result>): Result | null | undefined {
    const existing = this.results.get(bar)
    if (existing?.key === key) return existing.failed ? undefined : existing.result ?? null
    if (!orderFlowWorkers.available || candleTradeCount(bar) < WORKER_TRADE_THRESHOLD) return
    this.pending.get(bar)?.abort()
    const controller = new AbortController()
    const state: { key: string; result?: Result; failed?: boolean } = { key }
    this.results.set(bar, state)
    this.pending.set(bar, controller)
    void calculate(controller.signal)
      .then(result => { state.result = result }, () => { state.failed = true }).finally(() => {
        if (controller.signal.aborted) return
        this.pending.delete(bar)
        this.version++
        this.changed()
      })
    return null
  }

  retain(visible: ReadonlySet<TradeBar>): void {
    for (const [bar, pending] of this.pending) {
      if (visible.has(bar)) continue
      pending.abort()
      this.pending.delete(bar)
      this.results.delete(bar)
    }
  }

  clear(): void {
    this.retain(new Set())
    this.results = new WeakMap()
    this.version++
  }
}
