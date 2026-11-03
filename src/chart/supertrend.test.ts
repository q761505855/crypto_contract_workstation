import { describe, expect, it } from 'vitest'
import type { KLineData } from 'klinecharts'
import {
  calculateSupertrend,
  supertrendIndicator,
} from './supertrend'

const candles: KLineData[] = [
  [11, 9, 10],
  [12, 10, 11],
  [13, 11, 12],
  [17, 15, 16],
  [18, 16, 17],
  [13, 11, 12],
  [12, 10, 11],
].map(([high, low, close], index) => ({
  timestamp: index * 60_000,
  open: close,
  high,
  low,
  close,
}))

describe('Supertrend', () => {
  it('matches hand-calculated Wilder ATR bands, gap ranges and both reversals', () => {
    const result = calculateSupertrend(candles, 3, 1)
    expect(result.slice(0, 3)).toEqual([{}, {}, { down: 14 }])
    expect(result[3]).toEqual({ up: 13 })
    expect(result[4].up).toBeCloseTo(43 / 3, 12)
    expect(result[5].down).toBeCloseTo(142 / 9, 12)
    expect(result[6].down).toBeCloseTo(383 / 27, 12)
    expect(result[4].down).toBeUndefined()
    expect(result[5].up).toBeUndefined()
  })

  it('keeps the direction when the close equals the band', () => {
    const equalUpper = { timestamp: 60_000, open: 12, high: 12, low: 10, close: 12 }
    expect(calculateSupertrend([candles[0], equalUpper], 1, 1))
      .toEqual([{ down: 12 }, { down: 12 }])
    const equalLower = { timestamp: 240_000, open: 13, high: 17, low: 13, close: 13 }
    expect(calculateSupertrend([...candles.slice(0, 4), equalLower], 3, 1)[4])
      .toEqual({ up: 13 })
  })

  it('does not change earlier values when future candles arrive or the live candle changes', () => {
    const original = structuredClone(candles)
    const full = calculateSupertrend(candles, 3, 1)
    for (let length = 1; length <= candles.length; length += 1) {
      expect(calculateSupertrend(candles.slice(0, length), 3, 1))
        .toEqual(full.slice(0, length))
    }
    const live = [...candles.slice(0, -1), { ...candles.at(-1)!, high: 22, close: 21 }]
    const updated = calculateSupertrend(live, 3, 1)
    expect(updated.slice(0, -1)).toEqual(full.slice(0, -1))
    expect(updated.at(-1)?.up).toBeDefined()
    expect(candles).toEqual(original)
  })

  it('supports fractional multipliers and waits for the full ATR seed', () => {
    expect(calculateSupertrend([])).toEqual([])
    expect(calculateSupertrend(candles)).toEqual(candles.map(() => ({})))
    const result = calculateSupertrend(candles, 3, 1.5)
    expect(result[2]).toEqual({ down: 15 })
    expect(result[3]).toEqual({ up: 11.5 })
    for (const [period, multiplier] of [[0, 3], [1.5, 3], [3, 0], [3, Infinity]]) {
      expect(calculateSupertrend(candles, period, multiplier)).toEqual(candles.map(() => ({})))
    }
  })

  it('calculates with the configured parameters', () => {
    expect(supertrendIndicator.calcParams).toEqual([10, 3])
    const indicator = { calcParams: [3, 1.5] } as Parameters<typeof supertrendIndicator.calc>[1]
    expect(supertrendIndicator.calc(candles, indicator))
      .toEqual(calculateSupertrend(candles, 3, 1.5))
  })
})
