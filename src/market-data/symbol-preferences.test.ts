import { ctraderStorage } from '../storage/ctrader-storage'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SYMBOL } from '../chart/chart-config'
import { readSelectedSymbol, saveSelectedSymbol, SELECTED_SYMBOL_STORAGE_KEY } from './symbol-preferences'
import { readFavoriteSymbols, saveFavoriteSymbols } from './favorites'

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
      ctraderStorage.setItem(SELECTED_SYMBOL_STORAGE_KEY, saved)
      expect(readSelectedSymbol()).toBeNull()
    }
    expect(readSelectedSymbol({ getItem: () => { throw new Error('unavailable') } })).toBeNull()
    expect(() => saveSelectedSymbol(DEFAULT_SYMBOL, { setItem: () => { throw new Error('full') } })).not.toThrow()
  })

  it('round-trips legacy Unicode and cTrader broker product codes', () => {
    for (const symbol of [{ ticker: '币安人生USDT' }, { exchange: 'CTRADER', ticker: '#ACME CFD' }]) {
      saveSelectedSymbol(symbol)
      saveFavoriteSymbols([symbol.ticker])
      expect(readSelectedSymbol()).toEqual(symbol)
      expect(readFavoriteSymbols()).toEqual([symbol.ticker])
    }
  })
})
