import { isCTraderTimeframe, shiftOpenTime, type CTraderTimeframe } from '../market-data/intervals'
import type { MarketCandle } from '../market-data/models'
import type { CTraderTick } from '../market-data/ctrader-market'
import type { PriceSource } from '../market-data/price-source-preferences'

export interface CTraderReplayMarket {
  readonly source?: PriceSource
  readonly historyRevision?: number
  readonly tickWindowMs?: number
  historyBounds?(symbol: string, signal?: AbortSignal): Promise<{ from: number; to: number } | undefined>
  historyPageSize?(timeframe: string): number
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
const MAX_WINDOW_SPAN_MS = 365 * 86_400_000
const MAX_WINDOWS = 8

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
      bar.source === (service.source ?? 'ctrader') && bar.isClosed && bar.symbol.toUpperCase() === symbol.toUpperCase() &&
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

/** Retains native history across direction and step-period changes. */
export class CTraderReplayBars {
  private readonly windows = new Map<string, SearchWindow>()
  private revision?: number

  constructor(private readonly service: CTraderReplayMarket) {}

  async find(
    symbol: string, timeframe: string, from: number, to: number, direction: 1 | -1, signal: AbortSignal,
  ): Promise<MarketCandle | undefined> {
    if (this.revision !== this.service.historyRevision) {
      this.windows.clear()
      this.revision = this.service.historyRevision
    }
    requireNativeReplayPeriod(timeframe)
    let position = direction === 1 ? from : to
    while (position >= from && position <= to) {
      signal.throwIfAborted()
      const window = this.cachedWindow(symbol, timeframe, position)
        ?? await this.readWindow(symbol, timeframe, position, from, to, direction, signal)
      const fits = (bar: MarketCandle) =>
        bar.openTime >= (direction === 1 ? position : from) &&
        (direction === 1 || bar.openTime <= position) &&
        bar.closeTime <= to
      const bars = direction === 1 ? window.bars : [...window.bars].reverse()
      const bar = bars.find(fits)
      if (bar !== undefined) return bar
      position = direction === 1 ? window.to + 1 : window.from - 1
    }
  }

  private cachedWindow(symbol: string, timeframe: string, position: number): SearchWindow | undefined {
    for (const [key, window] of this.windows) {
      if (window.symbol === symbol && window.timeframe === timeframe && window.from <= position && window.to >= position) {
        this.windows.delete(key)
        this.windows.set(key, window)
        return window
      }
    }
  }

  private async readWindow(
    symbol: string, timeframe: string, position: number, min: number, max: number,
    direction: 1 | -1, signal: AbortSignal,
  ): Promise<SearchWindow> {
    const count = this.service.historyPageSize?.(timeframe) ?? CANDLES_PER_WINDOW
    const from = direction === 1 ? position
      : Math.max(min, position - MAX_WINDOW_SPAN_MS + 1, shiftOpenTime(position, timeframe, -count))
    const to = direction === 1
      ? Math.min(max, position + MAX_WINDOW_SPAN_MS - 1, shiftOpenTime(position, timeframe, count) - 1) : position
    const bars = await loadClosedReplayBars(this.service, symbol, timeframe, from, to, signal)
    const window = { symbol, timeframe, from, to, bars }
    this.windows.set(`${symbol}:${timeframe}:${from}:${to}`, window)
    if (this.windows.size > MAX_WINDOWS) this.windows.delete(this.windows.keys().next().value!)
    return window
  }
}
