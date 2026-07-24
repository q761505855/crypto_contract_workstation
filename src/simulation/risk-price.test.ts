import { describe, expect, it } from 'vitest'
import { classifyRiskPrice } from './risk-price'

describe('classifyRiskPrice', () => {
  it('classifies prices above and below a long position current price', () => {
    expect(classifyRiskPrice('long', 100, 110)).toBe('take-profit')
    expect(classifyRiskPrice('long', 100, 90)).toBe('stop-loss')
  })

  it('reverses the classification for a short position', () => {
    expect(classifyRiskPrice('short', 100, 90)).toBe('take-profit')
    expect(classifyRiskPrice('short', 100, 110)).toBe('stop-loss')
  })

  it('ignores prices equal to the current price, invalid, or non-positive', () => {
    expect(classifyRiskPrice('long', 100, 100)).toBeNull()
    expect(classifyRiskPrice('long', Number.NaN, 110)).toBeNull()
    expect(classifyRiskPrice('long', 100, 0)).toBeNull()
  })
})
