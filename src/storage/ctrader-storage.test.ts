import { afterEach, expect, it, vi } from 'vitest'
import { DRAWING_STORAGE_KEY, DrawingStore } from '../chart/drawings'
import { readFavoriteSymbols, saveFavoriteSymbols } from '../market-data/favorites'
import { CONFIG_PENDING_KEY, PREFERENCES_CHANGED } from './preference-events'

afterEach(() => localStorage.clear())

it('isolates experiment preferences, pending edits and drawings from production storage', async () => {
  localStorage.setItem('marketData.favoriteSymbols', '["BTCUSDT"]')
  localStorage.setItem(DRAWING_STORAGE_KEY, '{"legacy":true}')
  const changed = vi.fn()
  window.addEventListener(PREFERENCES_CHANGED, changed, { once: true })
  expect(readFavoriteSymbols()).toEqual([])
  saveFavoriteSymbols(['EURUSD', 'XAUUSD'])
  expect(readFavoriteSymbols()).toEqual(['EURUSD', 'XAUUSD'])
  expect(localStorage.getItem('marketData.favoriteSymbols')).toBe('["BTCUSDT"]')
  expect(localStorage.getItem(CONFIG_PENDING_KEY)).toBeNull()
  expect(changed).toHaveBeenCalledOnce()

  const drawings = new DrawingStore()
  expect(drawings.snapshot()).toBeNull()
  const drawing = { id: 'drawing-isolated', scope: 'live:EURUSD', name: 'horizontalStraightLine',
    points: [{ timestamp: 0, value: 1.1 }] }
  await drawings.save(drawing)
  expect(new DrawingStore().forScope('live:EURUSD')).toEqual([drawing])
  expect(localStorage.getItem(DRAWING_STORAGE_KEY)).toBe('{"legacy":true}')
})
