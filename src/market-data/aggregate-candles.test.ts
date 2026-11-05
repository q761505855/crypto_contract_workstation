import { describe, expect, it } from 'vitest'
import { aggregateMinuteCandles } from './aggregate-candles'
import type { MarketCandle } from './models'

const minute = 60_000

function candle(openTime: number, patch: Partial<MarketCandle> = {}): MarketCandle {
  return {
    symbol: 'BTCUSDT', timeframe: '1m', openTime,
    closeTime: openTime + minute - 1,
    open: '10', high: '12', low: '8', close: '11',
    volume: '0.1', quoteVolume: '0.2', tradeCount: 2,
    isClosed: true, source: 'binance', ...patch,
  }
}

function minutes(from: number, to: number): MarketCandle[] {
  return Array.from({ length: (to - from) / minute }, (_, i) => candle(from + i * minute))
}

describe('canonical minute aggregation', () => {
  it.each([
    ['1m', 1], ['3m', 3], ['5m', 5], ['15m', 15], ['30m', 30],
    ['1h', 60], ['2h', 120], ['4h', 240], ['6h', 360], ['8h', 480],
    ['12h', 720], ['1d', 1440], ['3d', 4320],
  ] as const)('aggregates complete %s buckets using UTC alignment', (timeframe, count) => {
    const result = aggregateMinuteCandles(minutes(0, count * minute), timeframe)
    expect(result).toEqual([{
      ...candle(0), timeframe, closeTime: count * minute - 1,
      volume: String(count / 10), quoteVolume: String(count / 5), tradeCount: count * 2,
    }])
  })

  it('uses first/last prices, exact extrema and arbitrary precision sums without mutation', () => {
    const input = [
      candle(2 * minute, { close: '15', high: '15', volume: '0.000000000000000000000000000003' }),
      candle(0, { open: '9', low: '7', volume: '123456789012345678901234567890.1', quoteVolume: '0.01' }),
      candle(minute, { high: '12.000000000000000000000000001', volume: '0.2', quoteVolume: '0.02' }),
    ]
    const snapshot = structuredClone(input)
    const result = aggregateMinuteCandles(input, '3m')
    expect(result[0]).toMatchObject({
      open: '9', high: '15', low: '7', close: '15',
      volume: '123456789012345678901234567890.300000000000000000000000000003',
      quoteVolume: '0.23', tradeCount: 6,
    })
    expect(input).toEqual(snapshot)
    expect(result[0]).not.toBe(input[0])
  })

  it('preserves exact price comparisons beyond JavaScript floating point precision', () => {
    const input = minutes(0, 3 * minute)
    input[1] = candle(minute, { high: '12.000000000000000000000000001', low: '7.999999999999999999999999999' })
    expect(aggregateMinuteCandles(input, '3m')[0]).toMatchObject({
      high: '12.000000000000000000000000001', low: '7.999999999999999999999999999',
    })
  })

  it('aligns weekly buckets to Monday across months', () => {
    const start = Date.UTC(2025, 8, 29)
    const end = Date.UTC(2025, 9, 6)
    expect(aggregateMinuteCandles(minutes(start, end), '1w')).toEqual([{
      ...candle(start), timeframe: '1w', closeTime: end - 1,
      volume: '1008', quoteVolume: '2016', tradeCount: 20160,
    }])
  })

  it('aggregates natural leap-year months without treating March as future February data', () => {
    const start = Date.UTC(2024, 1, 1)
    const end = Date.UTC(2024, 2, 1)
    const result = aggregateMinuteCandles([...minutes(start, end), candle(end)], '1M')
    expect(result).toEqual([{
      ...candle(start), timeframe: '1M', closeTime: end - 1,
      volume: '4176', quoteVolume: '8352', tradeCount: 83520,
    }])
  })

  it('excludes unfinished minutes and never fills gaps or leading/trailing incomplete buckets', () => {
    const input = minutes(0, 12 * minute)
      .filter(({ openTime }) => openTime !== 0 && openTime !== 4 * minute)
      .map((row) => row.openTime === 8 * minute ? { ...row, isClosed: false } : row)
    expect(aggregateMinuteCandles(input, '3m').map(({ openTime }) => openTime)).toEqual([9 * minute])
    expect(aggregateMinuteCandles(minutes(0, 2 * minute), '3m')).toEqual([])
  })

  it('exposes only completed minutes before the exclusive replay boundary as a partial final bar', () => {
    const result = aggregateMinuteCandles(minutes(0, 9 * minute), '3m', 4 * minute + 30_000)
    expect(result).toEqual([
      { ...candle(0), timeframe: '3m', closeTime: 3 * minute - 1, volume: '0.3', quoteVolume: '0.6', tradeCount: 6 },
      { ...candle(3 * minute), timeframe: '3m', closeTime: 6 * minute - 1, isClosed: false },
    ])
    expect(aggregateMinuteCandles(minutes(0, 9 * minute), '3m', 3 * minute)).toHaveLength(1)
    expect(aggregateMinuteCandles(minutes(0, 9 * minute), '1m', minute)[0]).toEqual(candle(0))
  })

  it('does not label an unexplained missing tail or an internal gap as a partial replay bar', () => {
    expect(aggregateMinuteCandles([candle(0)], '3m', 2 * minute)).toEqual([])
    expect(aggregateMinuteCandles([candle(minute)], '3m', 2 * minute)).toEqual([])
    expect(aggregateMinuteCandles([candle(0), candle(2 * minute)], '5m', 3 * minute)).toEqual([])
  })

  it('deduplicates identical minutes and rejects conflicting duplicates and mixed symbols', () => {
    expect(aggregateMinuteCandles([candle(0), candle(0)], '1m')).toEqual([candle(0)])
    expect(() => aggregateMinuteCandles([candle(0), candle(0, { close: '10' })], '1m')).toThrow()
    expect(() => aggregateMinuteCandles([candle(0), candle(minute, { symbol: 'ETHUSDT' })], '1m')).toThrow()
  })

  it('returns independent canonical minute rows without rewriting exact decimal strings', () => {
    const first = candle(0, { volume: '0.1000', quoteVolume: '2e-7' })
    const second = candle(minute, { volume: '123456789012345678901234567890.123456789' })
    const result = aggregateMinuteCandles([second, first, { ...first }], '1m', 2 * minute)
    expect(result).toEqual([first, second])
    expect(result[0]).not.toBe(first)
    expect(result[1]).not.toBe(second)
    result[0].close = '9'
    expect(first.close).toBe('11')
  })

  it.each([
    { high: 'broken' }, { low: 'broken' }, { volume: 'broken' },
    { volume: '-0.1' }, { volume: 'Infinity' }, { quoteVolume: '-1' },
    { quoteVolume: 'NaN' }, { tradeCount: -1 }, { tradeCount: 1.1 },
    { tradeCount: Number.MAX_SAFE_INTEGER + 1 },
  ])('retains numeric input validation when reading canonical minutes: %j', (patch) => {
    expect(() => aggregateMinuteCandles([candle(0, patch)], '1m')).toThrow()
  })

  it('rejects unsupported periods, non-minute sources and malformed minute boundaries', () => {
    expect(() => aggregateMinuteCandles([], '2m')).toThrow()
    expect(() => aggregateMinuteCandles([candle(0, { timeframe: '3m' })], '1m')).toThrow()
    expect(() => aggregateMinuteCandles([candle(1)], '1m')).toThrow()
    expect(() => aggregateMinuteCandles([candle(0, { closeTime: minute })], '1m')).toThrow()
    expect(() => aggregateMinuteCandles([], '1m', NaN)).toThrow()
  })
})
