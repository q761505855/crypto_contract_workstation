import { writePreference } from '../storage/preference-events'
import { ctraderStorage } from '../storage/ctrader-storage'
import { validateSymbolTicker } from './symbol-preferences'

export const FAVORITE_SYMBOLS_STORAGE_KEY = 'marketData.favoriteSymbols'

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>

export function validateFavoriteSymbols(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('favoriteSymbols 必须是交易品种数组')
  const favorites = value.map(validateSymbolTicker)
  if (new Set(favorites).size !== favorites.length) throw new Error('收藏交易对包含重复项')
  return favorites
}

export function readFavoriteSymbols(
  storage: ReadableStorage = ctraderStorage,
): string[] {
  try {
    return validateFavoriteSymbols(JSON.parse(
      storage.getItem(FAVORITE_SYMBOLS_STORAGE_KEY) ?? '[]',
    ))
  } catch {
    return []
  }
}

export function saveFavoriteSymbols(
  favorites: readonly string[],
  storage: WritableStorage = ctraderStorage,
): void {
  writePreference(storage, FAVORITE_SYMBOLS_STORAGE_KEY, JSON.stringify(validateFavoriteSymbols(favorites)))
}
