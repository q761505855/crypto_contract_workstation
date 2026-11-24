import { describe, expect, it } from 'vitest'
import { PIVOTS_DEFAULT_PARAMS } from './pivots'
import { marketSessionStyles } from './market-session-styles'
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
  it('persists independent visible Profile settings and preserves missing fields from legacy archives', () => {
    const legacy = { ...preferences, main: [{ name: 'VISIBLE_VOLUME_PROFILE', calcParams: [], visible: false, styles: null }],
      orderFlow: { profile: { rows: 35 } } }
    const visibleProfile = { placement: 'left' as const, offset: 0, width: 20, rows: 64, showHeaders: false, volumeColor: '#12345600',
      showPoc: false, showValueArea: true, valueArea: 81, showLabels: false, pocColor: '#123789', levelColor: '#abddff',
      valueAreaColor: '#abc12300' }
    const value = { ...legacy, orderFlow: { ...legacy.orderFlow, visibleProfile } }
    const storage = new MemoryStorage()
    saveChartIndicatorPreferences(value, storage)
    expect(loadChartIndicatorPreferences(storage)).toEqual(value)
    expect(validateChartIndicatorPreferences(legacy, value)).toEqual(value)
    expect(validateChartIndicatorPreferences(legacy)).toEqual(legacy)
    const oldViewport = { ...legacy, orderFlow: { ...legacy.orderFlow, visibleProfile: { placement: 'left' as const, offset: 0 } } }
    expect(validateChartIndicatorPreferences(oldViewport, value)).toEqual(value)
    expect(validateChartIndicatorPreferences(oldViewport)).toEqual(oldViewport)
    const resetOffset = { ...legacy, orderFlow: { visibleProfile: { offset: 0 } } }
    expect(validateChartIndicatorPreferences(resetOffset, { ...value, orderFlow: {
      ...value.orderFlow, visibleProfile: { ...visibleProfile, offset: 10 },
    } })).toEqual(value)
    for (const invalid of [null, [], { placement: 'center' }, { rows: 0 }, { width: 55 }, { offset: -1 }, { type: '' }, { showHeaders: null },
      { volumeColor: 'invalid' }, { showPoc: 0 }, { valueArea: 70.5 }, { showLabels: null }, { levelColor: '' }]) {
      expect(() => validateChartIndicatorPreferences({ ...legacy, orderFlow: { visibleProfile: invalid } })).toThrow(/orderFlow.visibleProfile/)
    }
  })

  it('preserves explicit bubble scaling switches, restores old archives and validates fixed radius', () => {
    const legacy = { ...preferences, orderFlow: { bubbles: { marker: 'square' as const, showText: false, minRadius: 0 } } }
    const bubbles = { ...legacy.orderFlow.bubbles, sizeByVolume: false, opacityByVolume: true, fixedRadius: 11, maxBubbles: 250 }
    const value = { ...legacy, orderFlow: { bubbles } }
    const storage = new MemoryStorage()
    saveChartIndicatorPreferences(value, storage)
    expect(loadChartIndicatorPreferences(storage)).toEqual(value)
    expect(validateChartIndicatorPreferences(legacy, value)).toEqual(value)
    expect(validateChartIndicatorPreferences(legacy)).toEqual(legacy)
    expect(validateChartIndicatorPreferences({ ...legacy, orderFlow: { bubbles: { opacityByVolume: false } } }, value).orderFlow?.bubbles)
      .toEqual({ ...bubbles, opacityByVolume: false })
    for (const invalid of [{ sizeByVolume: null }, { opacityByVolume: 0 }, { fixedRadius: 0 }, { fixedRadius: 1.5 }, { fixedRadius: 41 },
      ...[null, '', 0, -1, 1.5, 1001].map(maxBubbles => ({ maxBubbles }))]) {
      expect(() => validateChartIndicatorPreferences({ ...legacy, orderFlow: { bubbles: { ...bubbles, ...invalid } } })).toThrow(/orderFlow.bubbles/)
    }
  })

  it('keeps independent bubble thresholds, restores explicit zero and validates their units and ranges', () => {
    const legacy = { ...preferences, main: [{ name: 'BIG_TRADES', calcParams: [1200], visible: true, styles: null }] }
    const bubbles = { thresholdUnit: 'lots' as const, minLots: 0.02, maxLots: 0, minQuantity: 0, minContracts: 18 }
    const value = { ...legacy, orderFlow: { bubbles } }
    const storage = new MemoryStorage()
    saveChartIndicatorPreferences(value, storage)
    expect(loadChartIndicatorPreferences(storage)).toEqual(value)
    expect(validateChartIndicatorPreferences(legacy, value)).toEqual(value)
    expect(validateChartIndicatorPreferences(legacy)).toEqual(legacy)
    for (const patch of [{ thresholdUnit: null }, { thresholdUnit: '' }, { thresholdUnit: 'margin' },
      { minLots: -1 }, { minLots: null }, { maxLots: 0.01 }, { maxContracts: 2 }, { minQuantity: [] }]) {
      expect(() => validateChartIndicatorPreferences({ ...legacy, orderFlow: { bubbles: { ...bubbles, ...patch } } })).toThrow(/orderFlow.bubbles/)
    }
  })

  it.each(['VWAP', 'VISIBLE_VOLUME_PROFILE'])('saves %s visibility locally and validates its main-pane configuration', name => {
    const indicator = { name, calcParams: [], visible: false, styles: null }
    const value = { ...preferences, main: [indicator] }
    const storage = new MemoryStorage()
    saveChartIndicatorPreferences(value, storage)
    expect(loadChartIndicatorPreferences(storage)).toEqual(value)
    expect(validateChartIndicatorPreferences(preferences, value)).toEqual(preferences)
    expect(() => validateChartIndicatorPreferences({ ...value, main: [indicator, indicator] })).toThrow(name)
    expect(() => validateChartIndicatorPreferences({ ...value, main: [], sub: [{ indicators: [indicator] }] })).toThrow(name)
    for (const invalid of [{ calcParams: null }, { calcParams: [0] }, { visible: null }, { styles: [] }, { styles: { rows: 0 } }]) {
      expect(() => validateChartIndicatorPreferences({ ...value, main: [{ ...indicator, ...invalid }] })).toThrow()
    }
  })

  it('defaults to all markets, restores explicit false and retains the settings for legacy archives', () => {
    const storage = new MemoryStorage()
    const legacy = { schemaVersion: 1 as const, main: [{ name: 'MARKET_SESSIONS', calcParams: [], visible: true, styles: null }], sub: [] }
    const value = {
      ...legacy, main: [{ ...legacy.main[0], styles: { sessionVisibility: [false, false, false] } }],
    }
    expect(marketSessionStyles(validateChartIndicatorPreferences(legacy).main[0].styles).sessionVisibility)
      .toEqual([true, true, true])
    saveChartIndicatorPreferences(value, storage)
    expect(loadChartIndicatorPreferences(storage)).toEqual(value)
    expect(validateChartIndicatorPreferences(legacy, value)).toEqual(value)
  })

  it.each([
    { value: null }, { value: [] }, { value: [true, false] }, { value: [true, 0, false] },
    { value: [true, 'false', false] }, { value: { tokyo: true, london: false, newYork: false } },
  ])('rejects invalid per-market visibility $value', ({ value }) => {
    expect(() => validateChartIndicatorPreferences({ ...preferences, main: [{
      name: 'MARKET_SESSIONS', calcParams: [], visible: true, styles: { sessionVisibility: value },
    }] })).toThrow(/sessionVisibility/)
  })

  it('round-trips pivot group colors and explicit false and migrates old per-level settings', () => {
    const storage = new MemoryStorage()
    const legacy = [...PIVOTS_DEFAULT_PARAMS.slice(0, 30)]
    legacy[11] = '#112233'; legacy[13] = '#445566'; legacy[10] = false
    const value = { schemaVersion: 1 as const, main: [{ name: 'PIVOTS', calcParams: legacy, visible: false, styles: { size: 0 } }], sub: [] }
    saveChartIndicatorPreferences(value, storage)
    const migrated = loadChartIndicatorPreferences(storage)!
    expect(migrated.main[0].calcParams.slice(30)).toEqual(['#fb8c00', '#112233', '#445566', false, '#a78bfa', '#f59e0b', '#38bdf8'])
    expect(migrated.main[0]).toMatchObject({ visible: false, styles: { size: 0 } })
    migrated.main[0].calcParams[33] = true
    migrated.main[0].calcParams[35] = '#123abc'
    saveChartIndicatorPreferences(migrated, storage)
    expect(loadChartIndicatorPreferences(storage)).toEqual(migrated)
    const restored = validateChartIndicatorPreferences(value, migrated)
    expect(restored.main[0].calcParams.slice(33)).toEqual([true, '#a78bfa', '#123abc', '#38bdf8'])
    migrated.main[0].calcParams[33] = false
    expect(validateChartIndicatorPreferences(value, migrated).main[0].calcParams[33]).toBe(false)
  })
  it('upgrades previous Wave default colors without overwriting custom colors or mutating the archive', () => {
    const old = { schemaVersion: 1, main: [], sub: [{ indicators: [{
      name: 'TTM_WAVE_C', calcParams: [8, 233, 377], visible: false,
      styles: { bars: [
        { noChangeColor: '#26a69a', positiveColor: '#26a69a', negativeColor: '#ef5350', borderSize: 0 },
        { positiveColor: '#123456', negativeColor: '#abcdef' },
      ] },
    }] }] }
    const input = structuredClone(old)
    const migrated = validateChartIndicatorPreferences(old)
    expect(migrated.sub[0].indicators[0].styles).toEqual({ bars: [
      { noChangeColor: '#1b966e', positiveColor: '#1b966e', negativeColor: '#d33e62', borderSize: 0 },
      { positiveColor: '#123456', negativeColor: '#abcdef' },
    ] })
    expect(validateChartIndicatorPreferences(migrated)).toEqual(migrated)
    expect(old).toEqual(input)
    const originalColors = structuredClone(old)
    originalColors.sub[0].indicators[0].styles.bars[0].noChangeColor = '#ff0000'
    expect(validateChartIndicatorPreferences(originalColors).sub[0].indicators[0].styles)
      .toEqual(migrated.sub[0].indicators[0].styles)
  })
  it.each(['TTM_WAVE_A', 'TTM_WAVE_B', 'TTM_WAVE_C'])('round-trips %s with false and zero styles', name => {
    const storage = new MemoryStorage()
    const value = { schemaVersion: 1 as const, main: [], sub: [{ height: 180, indicators: [
      { name, calcParams: [5, 21, 34], visible: false, styles: { bars: [{ borderSize: 0, noChangeColor: '#123456', positiveColor: '#112233', negativeColor: '#445566' }] } },
    ] }] }
    saveChartIndicatorPreferences(value, storage)
    expect(loadChartIndicatorPreferences(storage)).toEqual(value)
  })

  it.each(['TTM_WAVE_A', 'TTM_WAVE_B', 'TTM_WAVE_C'].flatMap(name => [
    [], [8, 34], [8, 34, 55, 89], [0, 34, 55], [8, 34.5, 55], ['8', 34, 55],
    [8, null, 55], [8, 34, false], [8, 34, Infinity], [8, 34, 34], [34, 8, 55],
  ].map(calcParams => ({ name, calcParams }))))('rejects invalid $name periods $calcParams', ({ name, calcParams }) => {
    const invalid = { ...preferences, main: [], sub: [{ indicators: [{ name, calcParams, visible: true, styles: null }] }] }
    expect(() => validateChartIndicatorPreferences(invalid)).toThrow(/calcParams/)
  })

  it.each(['TTM_WAVE_A', 'TTM_WAVE_B', 'TTM_WAVE_C'])('rejects invalid %s signed colors without writing', name => {
    const storage = new MemoryStorage()
    saveChartIndicatorPreferences(preferences, storage)
    const before = storage.getItem(CHART_INDICATORS_PREFERENCE)
    for (const key of ['positiveColor', 'negativeColor']) {
      for (const value of [false, 0, null, '#zzzzzz', 'red']) {
        const invalid = { ...preferences, main: [{ name, calcParams: [8, 34, 55], visible: true, styles: { bars: [{ [key]: value }] } }] }
        expect(() => saveChartIndicatorPreferences(invalid, storage)).toThrow(/Color/)
        expect(storage.getItem(CHART_INDICATORS_PREFERENCE)).toBe(before)
      }
    }
  })

  it.each(['KC', 'TTM_SQUEEZE'])('persists %s with fractional parameters, false and zero styles', (name) => {
    const storage = new MemoryStorage()
    const settings = { ...preferences, main: [{ name, calcParams: [20, 2.5, 14], visible: false, styles: { borderSize: 0 } }], sub: [] }
    saveChartIndicatorPreferences(settings, storage)
    expect(loadChartIndicatorPreferences(storage)).toEqual(settings)
    saveChartIndicatorPreferences({ schemaVersion: 1, main: [], sub: [] }, storage)
    expect(loadChartIndicatorPreferences(storage)).toEqual({ schemaVersion: 1, main: [], sub: [] })
  })

  it.each(['KC', 'TTM_SQUEEZE'].flatMap(name => [
    [], [20, 2], [20, 2, 14, 1], [0, 2, 14], [1.5, 2, 14], ['20', 2, 14],
    [20, 0, 14], [20, -1, 14], [20, null, 14], [20, 2, 0], [20, 2, false],
    ...(name === 'KC' ? [[20, 2, 1.5]] : []),
  ].map(calcParams => ({ name, calcParams }))))('rejects invalid $name parameters $calcParams before saving', ({ name, calcParams }) => {
    const storage = new MemoryStorage()
    saveChartIndicatorPreferences(preferences, storage)
    const before = storage.getItem(CHART_INDICATORS_PREFERENCE)
    const invalid = { ...preferences, main: [{ name, calcParams, visible: true, styles: null }] }
    expect(() => saveChartIndicatorPreferences(invalid, storage)).toThrow(/calcParams/)
    expect(storage.getItem(CHART_INDICATORS_PREFERENCE)).toBe(before)
    storage.setItem(CHART_INDICATORS_PREFERENCE, JSON.stringify(invalid))
    expect(loadChartIndicatorPreferences(storage)).toBeNull()
  })

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
