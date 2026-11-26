import { ctraderStorage } from '../storage/ctrader-storage'
import { writePreference } from '../storage/preference-events'

export const SHOW_CANDLE_HOVER_DETAILS_KEY = 'chart.showCandleHoverDetails.v1'
export const DEFAULT_SHOW_CANDLE_HOVER_DETAILS = true

export function validateShowCandleHoverDetails(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('showCandleHoverDetails 必须是布尔值')
  return value
}

export function readShowCandleHoverDetails(storage: Pick<Storage, 'getItem'> = ctraderStorage): boolean {
  try {
    const saved = storage.getItem(SHOW_CANDLE_HOVER_DETAILS_KEY)
    if (saved !== null) return validateShowCandleHoverDetails(JSON.parse(saved))
  } catch { /* Use the default for damaged local preferences. */ }
  return DEFAULT_SHOW_CANDLE_HOVER_DETAILS
}

export function saveShowCandleHoverDetails(value: boolean, storage: Pick<Storage, 'setItem'> = ctraderStorage): void {
  writePreference(storage, SHOW_CANDLE_HOVER_DETAILS_KEY, JSON.stringify(validateShowCandleHoverDetails(value)))
}
