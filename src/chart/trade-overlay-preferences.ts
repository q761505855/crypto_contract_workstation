import { writePreference } from '../storage/preference-events'
import { ctraderStorage } from '../storage/ctrader-storage'

export const SHOW_TRADE_OVERLAYS_KEY = 'chart.showTradeOverlays.v1'

export function validateShowTradeOverlays(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('showTradeOverlays 必须是布尔值')
  return value
}

export function readShowTradeOverlays(storage: Pick<Storage, 'getItem'> = ctraderStorage): boolean {
  try {
    const saved = storage.getItem(SHOW_TRADE_OVERLAYS_KEY)
    if (saved !== null) return validateShowTradeOverlays(JSON.parse(saved))
  } catch {
    // Damaged local preferences fall back to showing trade overlays.
  }
  return true
}

export function saveShowTradeOverlays(value: boolean, storage: Pick<Storage, 'setItem'> = ctraderStorage): void {
  writePreference(storage, SHOW_TRADE_OVERLAYS_KEY, JSON.stringify(validateShowTradeOverlays(value)))
}
