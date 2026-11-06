import { writePreference } from '../storage/preference-events'

export const FAVORITE_SYMBOLS_STORAGE_KEY = 'marketData.favoriteSymbols'

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>

export function readFavoriteSymbols(
  storage: ReadableStorage = localStorage,
): string[] {
  try {
    const value = JSON.parse(
      storage.getItem(FAVORITE_SYMBOLS_STORAGE_KEY) ?? '[]',
    )
    if (!Array.isArray(value)) return []
    return [
      ...new Set(
        value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim().toUpperCase())
          .filter((item) => item.length > 0),
      ),
    ]
  } catch {
    return []
  }
}

export function saveFavoriteSymbols(
  favorites: readonly string[],
  storage: WritableStorage = localStorage,
): void {
  writePreference(storage,
    FAVORITE_SYMBOLS_STORAGE_KEY,
    JSON.stringify([
      ...new Set(
        favorites
          .map((item) => item.trim().toUpperCase())
          .filter((item) => item.length > 0),
      ),
    ]),
  )
}
