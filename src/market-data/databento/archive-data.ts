import { readDatabentoTrades } from './dbn'
import { cmeTradingBounds } from './trading-day'
import { BYBIT_DAY_MS as DAY } from '../bybit/trades'
import { aggregateLocalBars, type LocalBar } from '../local-bars'
import { buildLocalTradeIndex, type LocalTradeIndex } from '../okx/local-trade-index'

export interface ArchiveTask {
  file: File
  product: string
  day: string
}

export interface ArchiveSummary {
  contracts: string[]
  volumes: [Map<string, number>, Map<string, number>]
}

type ArchiveBars = Record<'1m' | '1h' | '1d', LocalBar[]>
export type ArchiveRead = { kind: 'summary' } | { kind: 'bars' | 'trades'; contracts: [string | undefined, string | undefined] }
export type ArchiveResult = { kind: 'summary'; summary: ArchiveSummary } |
  { kind: 'bars'; bars: ArchiveBars } | { kind: 'trades'; index: LocalTradeIndex }
type Minute = LocalBar & { first: number; last: number }

export async function readArchive(task: ArchiveTask, request: ArchiveRead, signal?: AbortSignal): Promise<ArchiveResult> {
  const start = Date.parse(task.day)
  const boundary = cmeTradingBounds(task.day).to
  const data = new Uint8Array(await task.file.arrayBuffer())
  signal?.throwIfAborted()
  const scan = (accept: Parameters<typeof readDatabentoTrades>[3]) => readDatabentoTrades(data, task.product, task.day,
    (contract, trade) => {
      if (trade.time < start || trade.time >= start + DAY) return
      accept(contract, trade)
    })
  if (request.kind === 'summary') {
    const volumes: ArchiveSummary['volumes'] = [new Map(), new Map()]
    const contracts = scan((contract, trade) => {
      const target = volumes[Number(trade.time >= boundary)]
      target.set(contract, (target.get(contract) ?? 0) + trade.size)
    })
    return { kind: 'summary', summary: { contracts, volumes } }
  }
  const isSelected = (contract: string, time: number) => request.contracts[Number(time >= boundary)] === contract
  if (request.kind === 'trades') {
    const index = (await buildLocalTradeIndex(async accept => {
      scan((contract, trade) => {
        if (isSelected(contract, trade.time)) accept(trade)
      })
      return true
    }))!
    return { kind: 'trades', index }
  }
  const minutes = new Map<number, Minute>()
  scan((contract, trade) => {
    if (!isSelected(contract, trade.time)) return
    const openTime = Math.floor(trade.time / 60_000) * 60_000
    const { price, size, time } = trade
    const bar = minutes.get(openTime)
    if (!bar) {
      minutes.set(openTime, { openTime, open: price, high: price, low: price, close: price,
        tradeCount: 1, volume: size, quoteVolume: price * size, first: time, last: time })
      return
    }
    if (time < bar.first) { bar.first = time; bar.open = price }
    if (time >= bar.last) { bar.last = time; bar.close = price }
    bar.high = Math.max(bar.high, price)
    bar.low = Math.min(bar.low, price)
    bar.volume += size
    bar.quoteVolume += price * size
    bar.tradeCount++
  })
  const minuteBars = [...minutes.values()].sort((a, b) => a.openTime - b.openTime).map(({ first: _first, last: _last, ...bar }) => bar)
  const hours = aggregateLocalBars(minuteBars, '1h')
  return { kind: 'bars', bars: { '1m': minuteBars, '1h': hours, '1d': aggregateLocalBars(hours, '1d') } }
}
