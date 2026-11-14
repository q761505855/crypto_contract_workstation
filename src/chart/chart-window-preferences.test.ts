import { describe, expect, it, vi } from 'vitest'
import {
  CHART_WINDOW_SIZE_KEY,
  DEFAULT_CHART_WINDOW_SIZE,
  readChartWindowSize,
  saveChartWindowSize,
} from './chart-window-preferences'

describe('default chart window size', () => {
  it('falls back when the saved value is missing, malformed or incomplete', () => {
    for (const value of [null, '', 'null', '{"width":900}']) {
      expect(readChartWindowSize({ getItem: () => value })).toEqual(DEFAULT_CHART_WINDOW_SIZE)
    }
  })

  it('validates the dimensions before writing and restores the saved size', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
    }
    const size = { width: 805, height: 570 }
    saveChartWindowSize(size, storage)
    expect(storage.setItem).toHaveBeenCalledWith(CHART_WINDOW_SIZE_KEY, JSON.stringify(size))
    expect(readChartWindowSize(storage)).toEqual(size)
    expect(() => saveChartWindowSize({ width: 0, height: 570 }, storage)).toThrow(/chartWindowSize/)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })
})
