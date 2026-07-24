import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import type { MarketCandle } from '../market-data/models'
import { ReplayEngine } from './replay-engine'

function candle(openTime: number): MarketCandle {
  return {
    symbol: 'BTCUSDT',
    timeframe: '1m',
    openTime,
    closeTime: openTime + 59_999,
    open: '1',
    high: '2',
    low: '0.5',
    close: '1.5',
    volume: '10',
    quoteVolume: '15',
    tradeCount: 2,
    isClosed: true,
    source: 'binance',
  }
}

const input = {
  symbol: DEFAULT_SYMBOL,
  period: SUPPORTED_PERIODS[0],
  startTime: 0,
  endTime: 180_000,
} as const

describe('ReplayEngine', () => {
  it('creates a deterministic session and advances one candle at a time', () => {
    const now = vi.fn(() => 10)
    const engine = ReplayEngine.create(
      input,
      [candle(120_000), candle(0), candle(60_000), candle(180_000)],
      { id: 'session-1', now },
    )

    expect(engine.snapshot()).toMatchObject({
      id: 'session-1',
      currentTime: 0,
      currentIndex: 0,
      candleCount: 4,
      status: 'paused',
    })
    expect(engine.stepNext()?.openTime).toBe(60_000)
    expect(engine.snapshot().currentIndex).toBe(1)
  })

  it('allows stepping backward until a trade has occurred', () => {
    const engine = ReplayEngine.create(input, [
      candle(0),
      candle(60_000),
      candle(120_000),
    ])
    engine.stepNext()
    expect(engine.stepPrevious()?.openTime).toBe(0)
    engine.stepNext()
    engine.setHasTrades(true)
    expect(engine.stepPrevious()).toBeNull()
    expect(engine.snapshot().currentTime).toBe(60_000)
  })

  it('processes every intermediate candle when jumping to the end', () => {
    const engine = ReplayEngine.create(input, [
      candle(0),
      candle(60_000),
      candle(120_000),
      candle(180_000),
    ])
    const processed: number[] = []

    engine.jumpToEnd((item) => processed.push(item.openTime))

    expect(processed).toEqual([60_000, 120_000, 180_000])
    expect(engine.snapshot()).toMatchObject({
      currentIndex: 3,
      currentTime: 180_000,
      status: 'completed',
    })
  })

  it('uses every available candle when the end time is omitted', () => {
    const engine = ReplayEngine.create(
      { ...input, endTime: undefined },
      [
        candle(0),
        candle(60_000),
        candle(120_000),
        candle(240_000),
      ],
    )

    expect(engine.snapshot()).toMatchObject({
      startTime: 0,
      endTime: 240_000,
      candleCount: 4,
    })
  })

  it('restores the cursor from a saved session and can reset', () => {
    const original = ReplayEngine.create(
      input,
      [candle(0), candle(60_000), candle(120_000)],
      { id: 'restore-me' },
    )
    original.stepNext()
    const restored = ReplayEngine.restore(original.snapshot(), [
      candle(0),
      candle(60_000),
      candle(120_000),
    ])

    expect(restored.snapshot().currentIndex).toBe(1)
    expect(restored.reset().openTime).toBe(0)
    expect(restored.snapshot().currentIndex).toBe(0)
  })
})
