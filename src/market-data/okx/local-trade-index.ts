import type { BybitTrade } from '../bybit/trades'
import type { OkxLocalTrade } from './local-files'

const STRIDE = 4
const TIME = 0
const PRICE = 1
const SIGNED_SIZE = 2
const ID = 3

export interface LocalTradeIndex {
  columns: Float64Array<ArrayBuffer>
  order?: Uint32Array<ArrayBuffer>
  textIds: Map<number, string>
}

const compareIds = (a: string, b: string) => a.length - b.length || (a < b ? -1 : Number(a > b))
const readId = (index: LocalTradeIndex, row: number) => index.textIds.get(row) ?? String(index.columns[row * STRIDE + ID])

export async function buildLocalTradeIndex(scan: (accept: (trade: OkxLocalTrade) => void) => Promise<boolean>): Promise<LocalTradeIndex | undefined> {
  let columns = new Float64Array(4096 * STRIDE)
  const textIds = new Map<number, string>()
  let count = 0
  let ordered = true
  let previousId = ''
  const found = await scan(trade => {
    const offset = count * STRIDE
    if (offset === columns.length) {
      const grown = new Float64Array(columns.length * 2)
      grown.set(columns)
      columns = grown
    }
    const time = trade.time * 1000
    if (ordered && count) {
      const previousTime = columns[offset - STRIDE + TIME]
      ordered = time > previousTime || (time === previousTime && compareIds(previousId, trade.id) <= 0)
    }
    previousId = trade.id
    columns[offset + TIME] = time
    columns[offset + PRICE] = Number(trade.price)
    columns[offset + SIGNED_SIZE] = Number(trade.size) * (trade.side === 'Buy' ? 1 : -1)
    const id = Number(trade.id)
    if (Number.isSafeInteger(id) && String(id) === trade.id) columns[offset + ID] = id
    else textIds.set(count, trade.id)
    count++
  })
  if (!found) return
  const used = count * STRIDE
  if (columns.length - used > used / 4) columns = columns.slice(0, used)
  const index: LocalTradeIndex = { columns: columns.subarray(0, used), textIds }
  if (!ordered) {
    const order = Uint32Array.from({ length: count }, (_, row) => row)
    order.sort((a, b) => {
      const timeDifference = columns[a * STRIDE + TIME] - columns[b * STRIDE + TIME]
      if (timeDifference) return timeDifference
      return textIds.has(a) || textIds.has(b) ? compareIds(readId(index, a), readId(index, b))
        : columns[a * STRIDE + ID] - columns[b * STRIDE + ID]
    })
    index.order = order
  }
  return index
}

export function localTradeIndexBytes(index: LocalTradeIndex): number {
  let bytes = index.columns.buffer.byteLength + (index.order?.byteLength ?? 0)
  for (const id of index.textIds.values()) bytes += 48 + 2 * id.length
  return bytes
}

function tradeOffset(index: LocalTradeIndex, row: number): number {
  return (index.order?.[row] ?? row) * STRIDE
}

function lowerBound(index: LocalTradeIndex, target: number): number {
  let low = 0
  let high = index.columns.length / STRIDE
  while (low < high) {
    const mid = (low + high) >>> 1
    if (index.columns[tradeOffset(index, mid) + TIME] < target) low = mid + 1
    else high = mid
  }
  return low
}

export async function visitIndexedTrades(index: LocalTradeIndex, fromUs: number, untilUs: number, contractValue: number,
  accept: (trade: BybitTrade) => unknown, signal: AbortSignal): Promise<void> {
  const { columns } = index
  let nextYield = performance.now() + 12
  const stop = lowerBound(index, untilUs)
  for (let row = lowerBound(index, fromUs); row < stop; row++) {
    if ((row & 8191) === 0 && performance.now() >= nextYield) {
      await new Promise(resolve => setTimeout(resolve, 0))
      signal.throwIfAborted()
      nextYield = performance.now() + 12
    }
    const offset = tradeOffset(index, row)
    const size = columns[offset + SIGNED_SIZE]
    const backpressure = accept({ id: readId(index, offset / STRIDE), venue: 'OKX', side: size > 0 ? 'buy' : 'sell',
      timeUs: columns[offset + TIME], price: columns[offset + PRICE], size: Math.abs(size) * contractValue })
    if (backpressure instanceof Promise) {
      await backpressure
      signal.throwIfAborted()
    }
  }
}

export async function visitIndexedPriceSizes(index: LocalTradeIndex, fromUs: number, untilUs: number, contractValue: number,
  accept: (batch: Float64Array<ArrayBuffer>) => Promise<void>, signal: AbortSignal): Promise<void> {
  const stop = lowerBound(index, untilUs)
  for (let row = lowerBound(index, fromUs); row < stop;) {
    signal.throwIfAborted()
    const end = Math.min(stop, row + 32_768)
    const batch = new Float64Array((end - row) * 2)
    let write = 0
    while (row < end) {
      const offset = tradeOffset(index, row++)
      batch[write++] = index.columns[offset + PRICE]
      batch[write++] = index.columns[offset + SIGNED_SIZE] * contractValue
    }
    await accept(batch)
  }
}
