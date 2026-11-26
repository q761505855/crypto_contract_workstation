import type { CTraderTick } from '../market-data/ctrader-market'
import type { MarketCandle } from '../market-data/models'
import { CTraderReplayBars, type CTraderReplayMarket } from './ctrader-replay-bars'
import { SECOND_STEP_MS, type FineStepPeriod } from './step-periods'

const WINDOW_MS = 10 * 60_000
const MAX_WINDOWS = 6
type Direction = 1 | -1
type IndexedTick = CTraderTick & { index: number }
export type ReplayPriceCandle = MarketCandle & { tickIndex?: number; tickTimeUs?: number; tradeUntilUs?: number }

interface TickWindow {
  from: number
  to: number
  ticks: IndexedTick[]
}

function priceCandle(
  source: MarketCandle['source'], symbol: string, timeframe: FineStepPeriod | '1m',
  openTime: number, closeTime: number, ticks: IndexedTick[],
): ReplayPriceCandle {
  const first = ticks[0]
  let high = first.price
  let low = first.price
  let volume = 0
  let turnover = 0
  for (const tick of ticks) {
    if (Number(tick.price) > Number(high)) high = tick.price
    if (Number(tick.price) < Number(low)) low = tick.price
    volume += tick.size ?? 0
    turnover += Number(tick.price) * (tick.size ?? 0)
  }
  return {
    symbol, timeframe, openTime, closeTime, open: first.price, high, low, close: ticks.at(-1)!.price,
    ...(source === 'ctrader' ? { volume: '', quoteVolume: '', tradeCount: 0, tickVolume: ticks.length }
      : { volume: String(volume), quoteVolume: String(turnover), tradeCount: ticks.length }),
    isClosed: true, source,
    ...(timeframe === 'tick' ? { tickIndex: first.index, tickTimeUs: first.timeUs } : {}),
  }
}

function lowerBound(ticks: IndexedTick[], timestamp: number, index = 0): number {
  let low = 0
  let high = ticks.length
  while (low < high) {
    const mid = (low + high) >>> 1
    const tick = ticks[mid]
    if (tick.timestamp < timestamp || (tick.timestamp === timestamp && tick.index < index)) low = mid + 1
    else high = mid
  }
  return low
}

export class CTraderReplayTicks {
  private readonly windows = new Map<string, TickWindow>()
  private revision?: number

  constructor(private readonly service: CTraderReplayMarket, private readonly nativeBars = new CTraderReplayBars(service)) {}

  async readFormingMinute(symbol: string, from: number, to: number, signal: AbortSignal | undefined, tickIndex?: number) {
    if (!this.service.loadTicks) return undefined
    const { ticks } = await this.readWindow(symbol, to, signal)
    const end = tickIndex === undefined ? lowerBound(ticks, to + 1) : lowerBound(ticks, to, tickIndex + 1)
    const revealed = ticks.slice(lowerBound(ticks, from), end)
    if (revealed.length > 0) return priceCandle(this.service.source ?? 'ctrader', symbol, '1m', from, to, revealed)
  }

  async find(
    symbol: string, timeframe: FineStepPeriod, from: number, to: number, direction: Direction,
    signal: AbortSignal, tickIndex?: number,
  ): Promise<ReplayPriceCandle | undefined> {
    let position = direction === 1 ? from : to
    while (position >= from && position <= to) {
      signal.throwIfAborted()
      const window = await this.readWindow(symbol, position, signal)
      const duration = timeframe === 'tick' ? 1 : SECOND_STEP_MS[timeframe]
      const { ticks } = window
      const earliest = Math.ceil(from / duration) * duration
      const latest = Math.floor((to + 1) / duration) * duration
      const first = lowerBound(ticks, earliest, direction === 1 ? (tickIndex ?? -1) + 1 : 0)
      const end = direction === -1 && tickIndex !== undefined
        ? lowerBound(ticks, to, tickIndex) : lowerBound(ticks, latest)
      const row = direction === 1 ? first : end - 1
      const next = first < end ? ticks[row] : undefined
      if (next !== undefined) {
        const start = Math.floor(next.timestamp / duration) * duration
        const close = start + duration - 1
        const quotes = timeframe === 'tick' ? [next] : ticks.slice(lowerBound(ticks, start), lowerBound(ticks, close + 1))
        const candle = priceCandle(this.service.source ?? 'ctrader', symbol, timeframe, start, close, quotes)
        if (timeframe === 'tick' && next.timeUs !== undefined) {
          // Order flow uses microsecond ranges. Reveal a tied group only after
          // its last trade, so the range cannot admit later trades.
          candle.tradeUntilUs = next.timeUs + Number(ticks[row + 1]?.timeUs !== next.timeUs)
        }
        return candle
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

  private async readWindow(symbol: string, position: number, signal?: AbortSignal): Promise<TickWindow> {
    signal?.throwIfAborted()
    const revision = this.service.historyRevision
    if (revision !== this.revision) {
      this.windows.clear()
      this.revision = revision
    }
    const width = this.service.tickWindowMs ?? WINDOW_MS
    const from = Math.floor(position / width) * width
    const key = `${symbol.toUpperCase()}:${from}`
    const cached = this.windows.get(key)
    if (cached && position <= cached.to) {
      this.windows.delete(key)
      this.windows.set(key, cached)
      return cached
    }
    if (!this.service.loadTicks) throw new Error('当前行情来源不提供历史 Tick')
    const to = Math.min(Date.now(), from + width - 1)
    const rows = await this.service.loadTicks(symbol, from, to, signal)
    signal?.throwIfAborted()
    let time = -1
    let index = 0
    const ticks = rows.filter(tick => tick.timestamp >= from && tick.timestamp <= to).map(tick => {
      index = tick.timestamp === time ? index + 1 : 0
      time = tick.timestamp
      return { ...tick, index }
    })
    const window = { from, to, ticks }
    this.windows.delete(key)
    if (revision === this.service.historyRevision) this.windows.set(key, window)
    if (this.windows.size > MAX_WINDOWS) this.windows.delete(this.windows.keys().next().value!)
    return window
  }
}
