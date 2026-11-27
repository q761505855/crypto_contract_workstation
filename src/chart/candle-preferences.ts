import { writePreference } from '../storage/preference-events'
import { ctraderStorage } from '../storage/ctrader-storage'

export const CANDLE_TYPE_KEY = 'chart.candleType.v1'
export const CANDLE_TRANSPARENCY_KEY = 'chart.candleTransparency.v1'
export const DEFAULT_CANDLE_TRANSPARENCY = 0
export const NEW_YORK_CASH = 'new_york_cash'
export const CANDLE_TYPES = ['candle_solid', 'candle_stroke', 'candle_up_stroke', 'candle_down_stroke', 'ohlc', 'area', 'heikin_ashi', 'line', NEW_YORK_CASH] as const
export type ChartCandleType = typeof CANDLE_TYPES[number]

export function validateCandleType(value: unknown): ChartCandleType {
  if (typeof value !== 'string' || !CANDLE_TYPES.includes(value as ChartCandleType)) {
    throw new Error('candleType 必须是支持的蜡烛图类型')
  }
  return value as ChartCandleType
}

export function readCandleType(storage: Pick<Storage, 'getItem'> = ctraderStorage): ChartCandleType {
  try {
    const saved = storage.getItem(CANDLE_TYPE_KEY)
    if (saved !== null) return validateCandleType(JSON.parse(saved))
  } catch {
    // Damaged local preferences must not prevent opening the chart.
  }
  return 'candle_solid'
}

export function saveCandleType(value: ChartCandleType, storage: Pick<Storage, 'setItem'> = ctraderStorage): void {
  writePreference(storage, CANDLE_TYPE_KEY, JSON.stringify(validateCandleType(value)))
}

export function validateCandleTransparency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error('candleTransparency 必须是 0 至 100 的整数')
  }
  return value
}

export function readCandleTransparency(storage: Pick<Storage, 'getItem'> = ctraderStorage): number {
  try {
    const saved = storage.getItem(CANDLE_TRANSPARENCY_KEY)
    if (saved !== null) return validateCandleTransparency(JSON.parse(saved))
  } catch {
    // Damaged local preferences must not prevent opening the chart.
  }
  return DEFAULT_CANDLE_TRANSPARENCY
}

export function saveCandleTransparency(value: number, storage: Pick<Storage, 'setItem'> = ctraderStorage): void {
  writePreference(storage, CANDLE_TRANSPARENCY_KEY, JSON.stringify(validateCandleTransparency(value)))
}
