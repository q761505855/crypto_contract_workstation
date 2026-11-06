import { describe, expect, it } from 'vitest'
import { CANDLE_TYPE_KEY, CANDLE_TYPES, readCandleType, saveCandleType } from './candle-preferences'

describe('candle type preferences', () => {
  it('persists every supported type including Heikin Ashi', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    expect(readCandleType(storage)).toBe('candle_solid')
    for (const type of CANDLE_TYPES) {
      saveCandleType(type, storage)
      expect(readCandleType(storage)).toBe(type)
    }
    expect(CANDLE_TYPES).toContain('heikin_ashi')
  })

  it.each([null, '', false, 0, [], {}, 'unknown'])('rejects invalid saves and tolerates corrupt local values (%j)', value => {
    const values = new Map([[CANDLE_TYPE_KEY, JSON.stringify(value)]])
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    expect(readCandleType(storage)).toBe('candle_solid')
    expect(() => saveCandleType(value as never, storage)).toThrow(/candleType/)
    expect(values.get(CANDLE_TYPE_KEY)).toBe(JSON.stringify(value))
  })
})
