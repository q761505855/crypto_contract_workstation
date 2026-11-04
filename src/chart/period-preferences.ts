import { SUPPORTED_PERIODS } from './chart-config'

export const PINNED_PERIODS_KEY = 'chart.pinnedPeriods.v1'
export const DEFAULT_PINNED_PERIODS: readonly string[] = ['5m', '15m', '1h', '4h']

export function validatePinnedPeriods(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((text) =>
    typeof text !== 'string' || !SUPPORTED_PERIODS.some((period) => period.text === text),
  )) {
    throw new Error('pinnedPeriods 必须是支持的图表周期数组')
  }
  if (new Set(value).size !== value.length) throw new Error('pinnedPeriods 包含重复周期')
  // Use the same display order when loading locally or restoring an archive.
  return SUPPORTED_PERIODS.filter(({ text }) => value.includes(text)).map(({ text }) => text)
}

export function readPinnedPeriods(storage: Pick<Storage, 'getItem'> = localStorage): string[] {
  try {
    const saved = storage.getItem(PINNED_PERIODS_KEY)
    if (saved !== null) return validatePinnedPeriods(JSON.parse(saved))
  } catch {
    // A damaged local preference must not stop the chart from opening.
  }
  return [...DEFAULT_PINNED_PERIODS]
}

export function savePinnedPeriods(periods: readonly string[], storage: Pick<Storage, 'setItem'> = localStorage): void {
  const validated = validatePinnedPeriods(periods)
  storage.setItem(PINNED_PERIODS_KEY, JSON.stringify(validated))
}
