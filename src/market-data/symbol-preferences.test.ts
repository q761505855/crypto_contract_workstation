import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SYMBOL } from '../chart/chart-config'
import { readSelectedSymbol, saveSelectedSymbol, SELECTED_SYMBOL_STORAGE_KEY } from './symbol-preferences'

afterEach(() => localStorage.clear())

describe('selected product persistence', () => {
  it('restores the product with its display metadata and precision', () => {
    const symbol = { ...DEFAULT_SYMBOL, ticker: 'ETHUSDT', shortName: 'ETHUSDT', pricePrecision: 3, volumePrecision: 0 }
    saveSelectedSymbol(symbol)
    expect(readSelectedSymbol()).toEqual(symbol)
  })

  it('falls back safely for missing, malformed or unavailable storage', () => {
    expect(readSelectedSymbol()).toBeNull()
    for (const saved of ['{', 'null', '[]', '{"ticker":""}', '{"ticker":"ETHUSDT","pricePrecision":-1}', '{"ticker":"ETHUSDT","name":1}']) {
      localStorage.setItem(SELECTED_SYMBOL_STORAGE_KEY, saved)
      expect(readSelectedSymbol()).toBeNull()
    }
    expect(readSelectedSymbol({ getItem: () => { throw new Error('unavailable') } })).toBeNull()
    expect(() => saveSelectedSymbol(DEFAULT_SYMBOL, { setItem: () => { throw new Error('full') } })).not.toThrow()
  })
})
