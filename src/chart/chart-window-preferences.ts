import { writePreference } from '../storage/preference-events'
import { ctraderStorage } from '../storage/ctrader-storage'

export interface ChartWindowSize {
  width: number
  height: number
}

export const CHART_WINDOW_SIZE_KEY = 'chart.windowSize.v1'
export const DEFAULT_CHART_WINDOW_SIZE: Readonly<ChartWindowSize> = Object.freeze({ width: 1100, height: 760 })

export function validateChartWindowSize(value: unknown): ChartWindowSize {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('chartWindowSize 必须包含宽度和高度')
  }
  const { width, height } = value as Record<string, unknown>
  if (typeof width !== 'number' || !Number.isSafeInteger(width) || width <= 0 ||
      typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error('chartWindowSize 的宽度和高度必须是正整数')
  }
  return { width, height }
}

export function readChartWindowSize(storage?: Pick<Storage, 'getItem'>): ChartWindowSize {
  try {
    const saved = (storage ?? ctraderStorage).getItem(CHART_WINDOW_SIZE_KEY)
    if (saved !== null) return validateChartWindowSize(JSON.parse(saved))
  } catch {
    // Unavailable storage and invalid local values both use the built-in size.
  }
  return { ...DEFAULT_CHART_WINDOW_SIZE }
}

export function saveChartWindowSize(value: ChartWindowSize, storage: Pick<Storage, 'getItem' | 'setItem'> = ctraderStorage): void {
  writePreference(storage, CHART_WINDOW_SIZE_KEY, JSON.stringify(validateChartWindowSize(value)))
}
