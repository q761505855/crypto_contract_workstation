import { describe, expect, it } from 'vitest'
import { alignOpenTime, lastClosedOpenTime, nextOpenTime, previousOpenTime } from './intervals'

describe('Binance 3d candle openings', () => {
  it('aligns and pages across Binance’s August 2023 transition', () => {
    const oldOpen = Date.UTC(2023, 7, 14)
    const newOpen = Date.UTC(2023, 7, 16)
    expect(alignOpenTime(Date.UTC(2023, 7, 15), '3d', 'floor')).toBe(oldOpen)
    expect(alignOpenTime(Date.UTC(2023, 7, 15), '3d', 'ceil')).toBe(newOpen)
    expect(previousOpenTime(newOpen, '3d')).toBe(oldOpen)
    expect(nextOpenTime(oldOpen, '3d')).toBe(newOpen)
    expect(lastClosedOpenTime(newOpen, '3d')).toBe(Date.UTC(2023, 7, 11))
    expect(lastClosedOpenTime(Date.UTC(2023, 7, 17), '3d')).toBe(oldOpen)
    expect(alignOpenTime(Date.UTC(2025, 8, 2), '3d', 'floor')).toBe(Date.UTC(2025, 8, 1))
  })
})
