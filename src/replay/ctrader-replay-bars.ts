import { isCTraderTimeframe, shiftOpenTime, type CTraderTimeframe } from '../market-data/intervals'
import type { MarketCandle } from '../market-data/models'
import type { CTraderTick } from '../market-data/ctrader-market'

export interface CTraderReplayMarket {
  loadTicks?(symbol: string, from: number, to: number, signal?: AbortSignal): Promise<CTraderTick[]>
  loadCandles(
    kind: 'trade',
    symbol: string,
    timeframe: string,
    from: number,
    to: number,
    options?: { signal?: AbortSignal; onStatus?: (message: string) => void },
  ): Promise<MarketCandle[]>
}

const CANDLES_PER_WINDOW = 500

export function requireNativeReplayPeriod(timeframe: string): asserts timeframe is CTraderTimeframe {
  if (!isCTraderTimeframe(timeframe)) {
    throw new Error(`cTrader 不支持回放周期 ${timeframe}`)
  }
}

export async function loadClosedReplayBars(
  service: CTraderReplayMarket, symbol: string, timeframe: string,
  from: number, to: number, signal?: AbortSignal,
): Promise<MarketCandle[]> {
  signal?.throwIfAborted()
  if (from > to) return []
  requireNativeReplayPeriod(timeframe)
  const bars = await service.loadCandles('trade', symbol, timeframe, from, to, { signal })
  signal?.throwIfAborted()
  const unique = new Map<number, MarketCandle>()
  for (const bar of bars) {
    if (
      bar.source === 'ctrader' && bar.isClosed && bar.symbol.toUpperCase() === symbol.toUpperCase() &&
      bar.timeframe === timeframe && bar.openTime >= from && bar.openTime <= to
    ) unique.set(bar.openTime, bar)
  }
  return [...unique.values()].sort((left, right) => left.openTime - right.openTime)
}

interface SearchWindow {
  symbol: string
  timeframe: string
  from: number
  to: number
  bars: MarketCandle[]
}

/** Scans bounded native windows and retains the most recent window in each direction. */
export class CTraderReplayBars {
  private readonly windows = new Map<1 | -1, SearchWindow>()

  constructor(private readonly service: CTraderReplayMarket) {}

  async find(
    symbol: string, timeframe: string, from: number, to: number, direction: 1 | -1, signal: AbortSignal,
  ): Promise<MarketCandle | undefined> {
    requireNativeReplayPeriod(timeframe)
    let position = direction === 1 ? from : to
    while (position >= from && position <= to) {
      signal.throwIfAborted()
      const cached = this.windows.get(direction)
      const window = cached?.symbol === symbol && cached.timeframe === timeframe &&
        cached.from <= position && cached.to >= position
        ? cached
        : await this.readWindow(symbol, timeframe, position, from, to, direction, signal)
      const fits = (bar: MarketCandle) =>
        bar.openTime >= (direction === 1 ? position : from) &&
        bar.closeTime <= to
      const bars = direction === 1 ? window.bars : [...window.bars].reverse()
      const bar = bars.find(fits)
      if (bar !== undefined) return bar
      position = direction === 1 ? window.to + 1 : window.from - 1
    }
  }

  private async readWindow(
    symbol: string, timeframe: string, position: number, min: number, max: number,
    direction: 1 | -1, signal: AbortSignal,
  ): Promise<SearchWindow> {
    const from = direction === 1 ? position : Math.max(min, shiftOpenTime(position, timeframe, -CANDLES_PER_WINDOW))
    const to = direction === 1 ? Math.min(max, shiftOpenTime(position, timeframe, CANDLES_PER_WINDOW) - 1) : position
    const bars = await loadClosedReplayBars(this.service, symbol, timeframe, from, to, signal)
    const window = { symbol, timeframe, from, to, bars }
    this.windows.set(direction, window)
    return window
  }
}
