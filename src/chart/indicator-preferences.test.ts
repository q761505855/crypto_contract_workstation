import { describe, expect, it } from 'vitest'
import {
  CHART_INDICATORS_PREFERENCE,
  loadChartIndicatorPreferences,
  saveChartIndicatorPreferences,
  validateChartIndicatorPreferences,
} from './indicator-preferences'

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const preferences = {
  schemaVersion: 1 as const,
  main: [
    {
      name: 'MA',
      calcParams: [7, 25, 99],
      visible: true,
      styles: null,
    },
  ],
  sub: [
    {
      height: 160,
      indicators: [
        {
          name: 'RSI',
          calcParams: [6, 12, 24],
          visible: false,
          styles: { lines: [{ color: '#fff' }] },
        },
      ],
    },
  ],
}

describe('chart indicator preferences', () => {
  it('round-trips indicator selection, parameters, visibility, and pane size', () => {
    const storage = new MemoryStorage()
    saveChartIndicatorPreferences(preferences, storage)

    expect(loadChartIndicatorPreferences(storage)).toEqual(preferences)
    expect(storage.values.has(CHART_INDICATORS_PREFERENCE)).toBe(true)
  })

  it('rejects malformed parameters and ignores invalid local data', () => {
    const storage = new MemoryStorage()
    storage.setItem(CHART_INDICATORS_PREFERENCE, '{"schemaVersion":2}')

    expect(loadChartIndicatorPreferences(storage)).toBeNull()
    expect(() =>
      validateChartIndicatorPreferences({
        ...preferences,
        main: [{ ...preferences.main[0], calcParams: [Number.NaN] }],
      }),
    ).toThrow('无效数字')
  })
})
