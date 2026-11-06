import { describe, expect, it } from 'vitest'
import { isChartColor, validateStyleColors } from './colors'
import { validateChartIndicatorPreferences } from './indicator-preferences'
import { PIVOTS_DEFAULT_PARAMS, pivotSettings, validatePivotParams } from './pivots'

describe('chart colors and RSI levels', () => {
  it('accepts legacy colors, alpha hex, bounded rgba and full transparency', () => {
    for (const color of ['#112233', '#11223300', '#aabbcc80', 'rgba(22, 119, 255, 0.15)', 'transparent']) {
      expect(isChartColor(color)).toBe(true)
      expect(() => validateStyleColors({ lines: [{ color, size: 0 }] })).not.toThrow()
    }
    for (const color of [null, false, 0, '#1122330', 'red', 'rgba(300, 0, 0, 1)', 'rgba(0, 0, 0, -1)', 'rgba(0,0,0,2)']) {
      expect(isChartColor(color)).toBe(false)
      expect(() => validateStyleColors({ bars: [{ positiveColor: color }] })).toThrow(/color/i)
    }
  })

  it('round trips alpha Pivots colors without falling back to opaque defaults', () => {
    const params = [...PIVOTS_DEFAULT_PARAMS]
    params[30] = '#11223300'; params[34] = '#abcdef80'
    expect(validatePivotParams(params)).toEqual(params)
    expect(pivotSettings(params).levels.P.color).toBe('#11223300')
    expect(pivotSettings(params).previousColors.P).toBe('#abcdef80')
  })

  const prefs = (levels: unknown) => ({ schemaVersion: 1, main: [], sub: [{ indicators: [{ name: 'RSI', calcParams: [6, 12, 24], visible: false, styles: { rsiLevels: levels, rsiLines: [{ color: '#12345600', size: 0 }] } }] }] })
  it('retains RSI levels and transparent lines in the existing indicator archive', () => {
    const value = prefs({ oversold: 0, overbought: 100 })
    expect(validateChartIndicatorPreferences(value)).toEqual(value)
  })
  it.each([null, {}, { oversold: 30 }, { oversold: -1, overbought: 70 }, { oversold: 50, overbought: 70 }, { oversold: 30, overbought: 50 }, { oversold: 30, overbought: 101 }, { oversold: '30', overbought: 70 }])('rejects invalid RSI levels %j', levels => {
    expect(() => validateChartIndicatorPreferences(prefs(levels))).toThrow(/RSI/)
  })
  it('preserves target RSI settings when old archives omit new style fields', () => {
    const previous = validateChartIndicatorPreferences(prefs({ oversold: 20, overbought: 80 }))
    const legacy = structuredClone(previous)
    legacy.sub[0].indicators[0].styles = null
    expect(validateChartIndicatorPreferences(legacy, previous).sub[0].indicators[0].styles).toEqual(previous.sub[0].indicators[0].styles)
  })
  it.each([false, {}, null, [false], [{ size: -1 }], [{ size: '1' }]])('rejects malformed RSI line styles %j', lines => {
    const value = prefs({ oversold: 20, overbought: 80 })
    value.sub[0].indicators[0].styles.rsiLines = lines as never
    expect(() => validateChartIndicatorPreferences(value)).toThrow(/RSI/)
  })
})
