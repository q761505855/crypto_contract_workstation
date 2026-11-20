import type { CTraderTick } from '../market-data/ctrader-market'
import type { MarketCandle } from '../market-data/models'
import type { CTraderReplayBars, CTraderReplayMarket } from './ctrader-replay-bars'
import { SECOND_STEP_MS, type FineStepPeriod } from './step-periods'

const WINDOW_MS = 5 * 60_000
type Direction = 1 | -1
type IndexedTick = CTraderTick & { index: number }
export type ReplayPriceCandle = MarketCandle & { tickIndex?: number }

interface TickWindow {
  symbol: string
  from: number
  to: number
  ticks: IndexedTick[]
}

function priceCandle(
  symbol: string, timeframe: FineStepPeriod, openTime: number, closeTime: number, ticks: IndexedTick[],
): ReplayPriceCandle {
  const first = ticks[0]
  let high = first.price
  let low = first.price
  for (const tick of ticks) {
    if (Number(tick.price) > Number(high)) high = tick.price
    if (Number(tick.price) < Number(low)) low = tick.price
  }
  return {
    symbol, timeframe, openTime, closeTime, open: first.price, high, low, close: ticks.at(-1)!.price,
    volume: '', quoteVolume: '', tradeCount: 0, tickVolume: ticks.length, isClosed: true, source: 'ctrader',
    ...(timeframe === 'tick' ? { tickIndex: first.index } : {}),
  }
}

export class CTraderReplayTicks {
  private readonly windows = new Map<Direction, TickWindow>()

  constructor(private readonly service: CTraderReplayMarket, private readonly nativeBars: CTraderReplayBars) {}

  async find(
    symbol: string, timeframe: FineStepPeriod, from: number, to: number, direction: Direction,
    signal: AbortSignal, tickIndex?: number,
  ): Promise<ReplayPriceCandle | undefined> {
    let position = direction === 1 ? from : to
    while (position >= from && position <= to) {
      signal.throwIfAborted()
      const window = await this.readWindow(symbol, position, direction, signal)
      const duration = timeframe === 'tick' ? 1 : SECOND_STEP_MS[timeframe]
      const fits = (quote: IndexedTick) => {
        const start = Math.floor(quote.timestamp / duration) * duration
        if (start < from || start + duration - 1 > to) return false
        if (timeframe !== 'tick' || tickIndex === undefined) return true
        return direction === 1
          ? start !== from || quote.index > tickIndex
          : start !== to || quote.index < tickIndex
      }
      const ticks = window.ticks
      const next = direction === 1 ? ticks.find(fits) : [...ticks].reverse().find(fits)
      if (next !== undefined) {
        const start = Math.floor(next.timestamp / duration) * duration
        const end = start + duration - 1
        const quotes = timeframe === 'tick' ? [next] : ticks.filter(quote => quote.timestamp >= start && quote.timestamp <= end)
        return priceCandle(symbol, timeframe, start, end, quotes)
      }

      position = direction === 1 ? window.to + 1 : window.from - 1
      if (ticks.length === 0 && position >= from && position <= to) {
        // Native minute history skips closures. Keep the boundary window so
        // quotes inside a partially elapsed final minute can still be read.
        const bar = await this.nativeBars.find(symbol, '1m',
          direction === 1 ? position : from, direction === 1 ? to : position, direction, signal)
        position = bar === undefined ? (direction === 1 ? to : from)
          : direction === 1 ? bar.openTime : bar.closeTime
      }
    }
  }

  private async readWindow(symbol: string, position: number, direction: Direction, signal: AbortSignal): Promise<TickWindow> {
    const cached = this.windows.get(direction)
    if (cached?.symbol === symbol && position >= cached.from && position <= cached.to) return cached
    if (!this.service.loadTicks) throw new Error('当前行情来源不提供历史 Tick')
    const from = Math.floor(position / WINDOW_MS) * WINDOW_MS
    const to = Math.min(Date.now(), from + WINDOW_MS - 1)
    const rows = await this.service.loadTicks(symbol, from, to, signal)
    signal.throwIfAborted()
    let time = -1
    let index = 0
    const ticks = rows.map(tick => {
      index = tick.timestamp === time ? index + 1 : 0
      time = tick.timestamp
      return { ...tick, index }
    })
    const window = { symbol, from, to, ticks }
    this.windows.set(direction, window)
    return window
  }
}
