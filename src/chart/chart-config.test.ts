import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAIN_INDICATORS,
  DEFAULT_SUB_INDICATORS,
  DEFAULT_SYMBOL,
  SUPPORTED_PERIODS,
} from './chart-config'

describe('chart configuration', () => {
  it('uses BTCUSDT and exposes every approved period', () => {
    expect(DEFAULT_SYMBOL.ticker).toBe('BTCUSDT')
    expect(SUPPORTED_PERIODS.map((period) => period.text)).toEqual([
      '1m',
      '3m',
      '5m',
      '15m',
      '30m',
      '1h',
      '2h',
      '4h',
      '6h',
      '8h',
      '12h',
      '1d',
      '3d',
      '1w',
      '1M',
    ])
    expect(DEFAULT_MAIN_INDICATORS).toEqual(['MA'])
    expect(DEFAULT_SUB_INDICATORS).toEqual(['VOL', 'MACD'])
  })
})
