import { describe, expect, it } from 'vitest'
import {
  CANDLE_TRANSPARENCY_KEY, readCandleTransparency, saveCandleTransparency,
  CANDLE_TYPE_KEY, CANDLE_TYPES, readCandleType, saveCandleType,
} from './candle-preferences'

describe('candle type preferences', () => {
  it('persists every supported type including the New York cash session', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    expect(readCandleType(storage)).toBe('candle_solid')
    for (const type of CANDLE_TYPES) {
      saveCandleType(type, storage)
      expect(readCandleType(storage)).toBe(type)
    }
    expect(CANDLE_TYPES).toContain('heikin_ashi')
    expect(CANDLE_TYPES).toContain('line')
    expect(CANDLE_TYPES).toContain('new_york_cash')
  })

  it.each([null, '', false, 0, [], {}, 'unknown'])('rejects invalid saves and tolerates corrupt local values (%j)', value => {
    const values = new Map([[CANDLE_TYPE_KEY, JSON.stringify(value)]])
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    expect(readCandleType(storage)).toBe('candle_solid')
    expect(() => saveCandleType(value as never, storage)).toThrow(/candleType/)
    expect(values.get(CANDLE_TYPE_KEY)).toBe(JSON.stringify(value))
  })
})

describe('candle transparency preferences', () => {
  it('recovers from corrupt local settings and persists an explicit zero', () => {
    let saved = 'null'
    const storage = {
      getItem: (key: string) => key === CANDLE_TRANSPARENCY_KEY ? saved : null,
      setItem: (key: string, value: string) => { if (key === CANDLE_TRANSPARENCY_KEY) saved = value },
    }
    expect(readCandleTransparency(storage)).toBe(0)
    saveCandleTransparency(100, storage)
    expect(readCandleTransparency(storage)).toBe(100)
    expect(() => saveCandleTransparency(101, storage)).toThrow(/candleTransparency/)
    expect(readCandleTransparency(storage)).toBe(100)
    saveCandleTransparency(0, storage)
    expect(saved).toBe('0')
  })
})
