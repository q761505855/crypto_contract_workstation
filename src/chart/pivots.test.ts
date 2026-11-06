import { describe, expect, it } from 'vitest'
import type { KLineData } from 'klinecharts'
import {
  calculatePivotLevels, calculatePivots, PIVOT_TYPES, PIVOT_LEVELS,
  PIVOTS_DEFAULT_PARAMS, pivotSettings, pivotPeriodStart, resolvePivotAnchor, shiftPivotPeriod, validatePivotParams,
} from './pivots'

const day = 86_400_000
const jan = Date.UTC(2026, 0, 1)
const previous = { open: 100, high: 120, low: 90, close: 105 }
const bar = (timestamp: number, values = previous): KLineData => ({ timestamp, ...values })
const hours = (days: number) => Array.from({ length: days * 24 }, (_, index) => bar(jan + index * day / 24))

describe('standard pivot levels', () => {
  it.each([
    ['Traditional', [105, 120, 90, 135, 75, 150, 60, 165, 45, 180, 30]],
    ['Fibonacci', [105, 116.46, 93.54, 123.54, 86.46, 135, 75]],
    ['Woodie', [107.5, 125, 95, 137.5, 77.5, 155, 65, 185, 35]],
    ['Classic', [105, 120, 90, 135, 75, 165, 45, 195, 15]],
    ['DM', [108.75, 127.5, 97.5]],
    ['Camarilla', [105, 107.75, 102.25, 110.5, 99.5, 113.25, 96.75, 121.5, 88.5, 140, 70]],
  ] as const)('matches hand-calculated %s levels', (type, expected) => {
    const levels = calculatePivotLevels(type, previous, 110)
    expect(Object.keys(levels)).toHaveLength(expected.length)
    expected.forEach((value, index) => expect(levels[PIVOT_LEVELS[index]]).toBeCloseTo(value, 10))
  })

  it('covers all DM branches and protects Camarilla against division by zero', () => {
    expect(calculatePivotLevels('DM', { ...previous, open: 105 }, 0)).toEqual({ P: 105, R1: 120, S1: 90 })
    expect(calculatePivotLevels('DM', { ...previous, open: 110 }, 0)).toEqual({ P: 101.25, R1: 112.5, S1: 82.5 })
    expect(calculatePivotLevels('Camarilla', { ...previous, low: 0 }, 0).R5).toBeUndefined()
  })
})

describe('pivot periods and history', () => {
  it('follows the supplied script Auto mapping and UTC calendar boundaries', () => {
    expect(['1m', '15m', '30m', '1h', '12h', '1d', '3d', '1w', '1M'].map((tf) => resolvePivotAnchor('Auto', tf)))
      .toEqual(['Daily', 'Daily', 'Weekly', 'Weekly', 'Weekly', 'Monthly', 'Monthly', 'Yearly', 'Yearly'])
    expect(pivotPeriodStart(Date.UTC(2026, 0, 4, 23), 'Weekly')).toBe(Date.UTC(2025, 11, 29))
    expect(pivotPeriodStart(Date.UTC(2026, 4, 31), 'Quarterly')).toBe(Date.UTC(2026, 3, 1))
    expect(shiftPivotPeriod(Date.UTC(2024, 1, 1), 'Monthly', 1)).toBe(Date.UTC(2024, 2, 1))
    expect(pivotPeriodStart(Date.UTC(2025, 11, 31), 'Biyearly')).toBe(Date.UTC(2024, 0, 1))
    expect(pivotPeriodStart(Date.UTC(2026, 4, 1), 'Triyearly')).toBe(Date.UTC(2025, 0, 1))
    expect(shiftPivotPeriod(Date.UTC(2020, 0, 1), 'Decennially', 1)).toBe(Date.UTC(2030, 0, 1))
    expect(pivotPeriodStart(Date.UTC(2026, 0, 1), 'Quinquennially')).toBe(Date.UTC(2025, 0, 1))
  })

  it('holds levels fixed within a period and uses the previous complete OHLC only', () => {
    const input = hours(3)
    const settings = pivotSettings(['Traditional', 'Daily'])
    const full = calculatePivots(input, '1h', settings)
    expect(full.slice(0, 24).every((value) => value.P === undefined)).toBe(true)
    expect(full[24].P).toBe(105)
    expect(full[47].P).toBe(105)
    expect(full[24].segment).toEqual({ start: jan + day, end: jan + 2 * day, levels: calculatePivotLevels('Traditional', previous, 100) })
    for (const length of [25, 30, 48, 49, 60]) {
      expect(calculatePivots(input.slice(0, length), '1h', settings).map(({ P }) => P))
        .toEqual(full.slice(0, length).map(({ P }) => P))
    }
    const changed = structuredClone(input)
    changed[30].high = 9999
    changed[30].close = 9998
    expect(calculatePivots(changed, '1h', settings)[47].P).toBe(105)
    expect(calculatePivots(changed, '1h', settings)[48].P).toBeGreaterThan(105)
    expect(input[30].high).toBe(120)
  })

  it('rejects incomplete first periods and periods containing missing candles', () => {
    const input = hours(3)
    const settings = pivotSettings(['Traditional', 'Daily'])
    expect(calculatePivots(input.slice(1, 26), '1h', settings).at(-1)?.P).toBeUndefined()
    expect(calculatePivots(input.filter((_, index) => index !== 12), '1h', settings)[24].P).toBeUndefined()
    expect(calculatePivots(input.slice(1), '1h', settings).at(-1)?.P).toBe(105)
    expect(calculatePivots([bar(jan)], '1w', settings)[0].message).toContain('不能小于')
  })

  it('uses higher-timeframe data and the true current period open for Woodie', () => {
    const input = [bar(jan + day + 12 * day / 24, { ...previous, open: 999 })]
    const source = [bar(jan), bar(jan + day, { ...previous, open: 110 }), bar(jan + 2 * day, { ...previous, high: 9999 })]
    expect(calculatePivots(input, '1h', pivotSettings(['Woodie', 'Daily']), source, '1d')[0].P).toBe(107.5)
    expect(calculatePivots(input, '1h', pivotSettings(['Traditional', 'Daily']), source, '1d')[0].P).toBe(105)
    expect(calculatePivots(input, '1h', pivotSettings(['Woodie', 'Daily']), source.slice(0, 1), '1d')[0].P).toBeUndefined()
  })

  it('limits history to the configured count and 500 drawings and supports hidden levels', () => {
    const input = Array.from({ length: 100 }, (_, index) => bar(jan + index * day))
    const settings = pivotSettings(['Traditional', 'Daily', 200])
    const result = calculatePivots(input, '1d', settings)
    expect(result.filter((value) => value.segment)).toHaveLength(45)
    settings.history = 2
    settings.levels.R1.visible = false
    const limited = calculatePivots(input, '1d', settings)
    expect(limited.filter((value) => value.segment)).toHaveLength(2)
    expect(limited.at(-1)?.R1).toBeUndefined()
  })

  it('projects next pivots only after a confirmed period close, with no future prices', () => {
    const input = hours(2)
    const settings = pivotSettings(['Traditional', 'Daily', 1])
    const before = calculatePivots(input, '1h', settings, input, '1h', jan + 2 * day - 1)
    expect(before.at(-1)?.projection).toBeUndefined()
    const closed = calculatePivots(input, '1h', settings, input, '1h', jan + 2 * day)
    expect(closed.at(-1)?.projection?.start).toBe(jan + 2 * day)
    expect(closed.at(-1)?.projection?.levels.P).toBe(105)
    expect(closed.filter((value) => value.segment)).toHaveLength(0)
    settings.type = 'Woodie'
    expect(calculatePivots(input, '1h', settings, input, '1h', jan + 2 * day).at(-1)?.projection).toBeUndefined()
  })

  it('validates persisted settings and exposes only levels each formula supports', () => {
    const settings = pivotSettings(['unknown', 'unknown', -1, false, false, false, 'Right', 101, false, 'invalid'])
    expect(settings).toMatchObject({ type: 'Traditional', anchor: 'Auto', history: 15, dailyBased: false, labels: false, prices: false, labelPosition: 'Right', width: 1 })
    expect(settings.levels.P).toEqual({ visible: false, color: '#fb8c00' })
    expect(PIVOTS_DEFAULT_PARAMS).toHaveLength(37)
    expect(PIVOT_TYPES.map((type) => Object.keys(calculatePivotLevels(type, previous, 110)).length)).toEqual([11, 7, 9, 9, 3, 11])
  })

  it('groups P/R/S colors, preserves per-level switches, and migrates legacy colors once', () => {
    const legacy = [...PIVOTS_DEFAULT_PARAMS.slice(0, 30)]
    legacy[11] = '#112233'
    legacy[13] = '#445566'
    legacy[10] = false
    const migrated = validatePivotParams(legacy)
    expect(migrated.slice(30)).toEqual(['#fb8c00', '#112233', '#445566', false, '#a78bfa', '#f59e0b', '#38bdf8'])
    expect(validatePivotParams(migrated)).toEqual(migrated)
    expect(legacy).toHaveLength(30)
    const settings = pivotSettings(migrated)
    expect(settings.levels.R1).toEqual({ visible: false, color: '#112233' })
    expect(settings.levels.R5.color).toBe('#112233')
    expect(settings.levels.S3.color).toBe('#445566')
    expect(settings.showPrevious).toBe(false)
  })

  it('carries the preceding period levels into only the current period even with history one', () => {
    const source = [bar(jan), bar(jan + day, { open: 110, high: 150, low: 100, close: 140 }), bar(jan + 2 * day)]
    const params = [...PIVOTS_DEFAULT_PARAMS]
    params[1] = 'Daily'; params[2] = 1; params[33] = true
    const settings = pivotSettings(params)
    const result = calculatePivots([bar(jan + 2 * day + 3_600_000)], '1h', settings, source, '1d')
    expect(result[0].P).toBe(130)
    expect(result[0].previousP).toBe(105)
    expect(result[0].segment?.previous?.R1).toBe(120)
    const live = structuredClone(source)
    live[2].high = 9999
    live[2].close = 9998
    expect(calculatePivots([bar(jan + 2 * day + 3_600_000)], '1h', settings, live, '1d')).toEqual(result)
    settings.type = 'Woodie'
    const woodie = calculatePivots([bar(jan + 2 * day)], '1h', settings, source, '1d')
    expect(woodie[0].previousP).toBe(107.5)
    settings.showPrevious = false
    expect(calculatePivots([bar(jan + 2 * day)], '1h', settings, source, '1d')[0].previousP).toBeUndefined()
    settings.showPrevious = true
    expect(calculatePivots([bar(jan + 2 * day)], '1h', settings, source.slice(1), '1d')[0].previousP).toBeUndefined()
  })

  it('carries levels into a confirmed projection and respects gaps and the drawing limit', () => {
    const params = [...PIVOTS_DEFAULT_PARAMS]
    params[1] = 'Daily'; params[2] = 1; params[33] = true
    const settings = pivotSettings(params)
    const input = hours(2)
    const projected = calculatePivots(input, '1h', settings, input, '1h', jan + 2 * day)
    expect(projected.at(-1)?.projection?.previous?.P).toBe(105)
    expect(projected.at(-1)?.previousP).toBe(105)
    const gap = input.filter((_, index) => index !== 12)
    expect(calculatePivots(gap, '1h', settings, gap, '1h', jan + 2 * day).at(-1)?.projection?.previous).toBeUndefined()
    settings.history = 200
    const daily = Array.from({ length: 100 }, (_, i) => bar(jan + i * day))
    const result = calculatePivots(daily, '1d', settings)
    const segments = result.flatMap(v => v.segment ? [v.segment] : [])
    expect(segments.filter(s => s.previous)).toHaveLength(1)
    expect(segments.reduce((sum, s) => sum + Object.keys(s.levels).length + Object.keys(s.previous ?? {}).length, 0)).toBeLessThanOrEqual(500)
  })

  it('rejects bad toggle, group colors and partial new settings before persistence', () => {
    for (const [index, value] of [[33, 0], [30, null], [31, '#nope'], [36, false], [2, 0]] as const) {
      const params: unknown[] = [...PIVOTS_DEFAULT_PARAMS]
      params[index] = value
      expect(() => validatePivotParams(params)).toThrow(/PIVOTS/)
    }
    expect(() => validatePivotParams(PIVOTS_DEFAULT_PARAMS.slice(0, 31))).toThrow()
  })
})
