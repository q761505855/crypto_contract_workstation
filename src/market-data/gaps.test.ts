import { describe, expect, it } from 'vitest'
import type { MarketCandle } from './models'
import { findMissingRanges } from './gaps'

function candle(openTime: number, timeframe = '1m'): MarketCandle {
  return {
    symbol: 'BTCUSDT',
    timeframe,
    openTime,
    closeTime: openTime + 59_999,
    open: '1',
    high: '1',
    low: '1',
    close: '1',
    volume: '1',
    quoteVolume: '1',
    tradeCount: 1,
    isClosed: true,
    source: 'binance',
  }
}

describe('historical data gap detection', () => {
  it('detects leading, middle, and trailing fixed-interval gaps', () => {
    const minute = 60_000
    expect(
      findMissingRanges(
        [candle(2 * minute), candle(4 * minute)],
        '1m',
        minute,
        5 * minute,
      ),
    ).toEqual([
      { from: minute, to: minute },
      { from: 3 * minute, to: 3 * minute },
      { from: 5 * minute, to: 5 * minute },
    ])
  })

  it('uses calendar boundaries for monthly candles', () => {
    const january = Date.UTC(2026, 0, 1)
    const february = Date.UTC(2026, 1, 1)
    const march = Date.UTC(2026, 2, 1)
    expect(
      findMissingRanges(
        [candle(january, '1M'), candle(march, '1M')],
        '1M',
        january,
        march,
      ),
    ).toEqual([{ from: february, to: february }])
  })
})
