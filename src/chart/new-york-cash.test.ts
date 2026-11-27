import { describe, expect, it } from 'vitest'
import { cashRanges, mergeCashCandles, readCashTradeBar } from './new-york-cash'
import type { TradeBar } from './order-flow-bars'

const utc = (date: string, time: string) => Date.parse(`${date}T${time}Z`)

describe('New York cash chart', () => {
  it.each([
    ['2026-11-20', '14:30', '21:00'],
    ['2026-07-06', '13:30', '20:00'],
    ['2026-11-27', '14:30', '18:00'],
    ['2024-07-03', '13:30', '17:00'],
  ])('clips to the cash session on %s', (date, open, close) => {
    expect(cashRanges(utc(date, '00:00'), utc(date, '23:59'))).toEqual([[utc(date, open), utc(date, close)]])
    expect(cashRanges(utc(date, '00:00'), utc(date, open))).toEqual([])
    expect(cashRanges(utc(date, close), utc(date, '23:59'))).toEqual([])
  })

  it.each(['2025-01-09', '2026-11-26', '2026-11-28'])('keeps closures blank on %s', date => {
    expect(cashRanges(utc(date, '00:00'), utc(date, '23:59'))).toEqual([])
  })

  it('aggregates only cash samples and preserves the original candle timestamp', () => {
    const date = '2026-11-20'
    const timestamp = utc(date, '14:00')
    const ranges = cashRanges(timestamp, utc(date, '15:00'))
    const candle = (time: string, price: number, volume: number) =>
      ({ timestamp: utc(date, time), open: price, high: price + 1, low: price - 1, close: price + 0.5, volume })
    const samples = [candle('14:00', 100, 1000), candle('14:30', 5, 10), candle('14:45', 7, 12), candle('15:00', 200, 2000)]
    expect(mergeCashCandles(timestamp, samples, ranges)).toEqual({
      timestamp, open: 5, high: 8, low: 4, close: 7.5, volume: 22,
    })
  })

  it('uses only cash trades across a weekend and never reads beyond the replay cursor', () => {
    const start = utc('2026-11-20', '20:30')
    const until = utc('2026-11-23', '14:45') * 1000 + 123
    const requested: number[][] = []
    const read = (from: number, to: number): TradeBar => {
      requested.push([from, to])
      return { cursor: to, volume: 10, firstPrice: 5, complete: true, pointRanges: [] }
    }
    expect(readCashTradeBar(start, until, read)).toMatchObject({ cursor: until, volume: 20, complete: true })
    expect(requested).toEqual([
      [start, utc('2026-11-20', '21:00') * 1000],
      [utc('2026-11-23', '14:30'), until],
    ])
  })
})
