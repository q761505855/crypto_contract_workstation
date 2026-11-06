import { describe, expect, it } from 'vitest'
import type { KLineData } from 'klinecharts'
import { calculateKeltner, keltnerIndicator } from './keltner'

const candles: KLineData[] = [
  [11, 9, 10], [12, 10, 11], [13, 11, 12], [17, 15, 16],
  [18, 16, 17], [13, 11, 12], [12, 10, 11],
].map(([high, low, close], index) => ({ timestamp: index * 60_000, open: close, high, low, close }))

describe('Keltner Channels', () => {
  it('matches hand-calculated SMA-seeded EMA and Wilder ATR including gaps', () => {
    const values = calculateKeltner(candles, 3, 1.5, 3)
    expect(values.slice(0, 3)).toEqual([{}, {}, { middle: 11, upper: 14, lower: 8 }])
    expect(values[3]).toEqual({ middle: 13.5, upper: 18, lower: 9 })
    expect(values[4]).toEqual({ middle: 15.25, upper: 19.25, lower: 11.25 })
    expect(values[5].upper).toBeCloseTo(19.291666666666668, 12)
  })

  it('waits for both independent periods and handles period one and flat prices', () => {
    expect(calculateKeltner(candles, 2, 1, 3).slice(0, 3))
      .toEqual([{}, {}, { middle: 11.5, upper: 13.5, lower: 9.5 }])
    expect(calculateKeltner(candles, 3, 1, 2)[3]).toEqual({ middle: 13.5, upper: 17, lower: 10 })
    expect(calculateKeltner(candles, 1, 1, 1)[3]).toEqual({ middle: 16, upper: 21, lower: 11 })
    const flat = candles.map(c => ({ ...c, open: 10, high: 10, low: 10, close: 10 }))
    expect(calculateKeltner(flat, 3, 1, 3)[2]).toEqual({ middle: 10, upper: 10, lower: 10 })
  })

  it('returns aligned empty results for insufficient history and invalid parameters', () => {
    expect(calculateKeltner([])).toEqual([])
    expect(calculateKeltner(candles)).toEqual(candles.map(() => ({})))
    for (const params of [[0, 1, 3], [1.5, 1, 3], [3, 0, 3], [3, Infinity, 3], [3, 1, -1]]) {
      expect(calculateKeltner(candles, ...params as [number, number, number])).toEqual(candles.map(() => ({})))
    }
  })

  it('never changes past results when future candles or a live update arrive', () => {
    const original = structuredClone(candles)
    const result = calculateKeltner(candles, 3, 1.5, 3)
    for (let end = 1; end <= candles.length; end++) {
      expect(calculateKeltner(candles.slice(0, end), 3, 1.5, 3)).toEqual(result.slice(0, end))
    }
    expect(calculateKeltner([...candles.slice(0, -1), { ...candles.at(-1)!, high: 30, close: 29 }], 3, 1.5, 3).slice(0, -1))
      .toEqual(result.slice(0, -1))
    expect(candles).toEqual(original)
  })

  it('uses edited parameters in the registered template', async () => {
    const configured = { calcParams: [3, 1.5, 3] } as Parameters<typeof keltnerIndicator.calc>[1]
    expect((await keltnerIndicator.calc(candles, configured))[3]).toEqual({ middle: 13.5, upper: 18, lower: 9 })
  })
})
