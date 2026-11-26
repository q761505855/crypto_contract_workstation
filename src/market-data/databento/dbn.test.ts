import { describe, expect, it } from 'vitest'
import { readDatabentoTrades } from './dbn'
import { cmeTradingDay, previousCmeTradingDay } from './trading-day'
import { tradeDbn } from './dbn-test-fixture'

describe('CME Databento trades', () => {
  it('resolves outright contracts from DBN metadata without mixing calendar spreads', () => {
    const time = Date.parse('2026-11-23T15:00:00Z')
    const trades = tradeDbn([['NQZ6', time, 26000.25, 7, 'B'], ['NQZ6-NQH7', time, 300, 6, 'A'],
      ['NQH7', time, 26300, 11, 'N'], ['ESZ6', time, 6000, 1, 'B']])
    const result: unknown[] = []
    readDatabentoTrades(trades, 'NQ.FUT', '2026-11-23', (contract, trade) => result.push([contract, trade]))
    expect(result).toEqual([
      ['NQZ6', { id: '0', time, price: 26000.25, size: 7, side: 'Buy' }],
      ['NQH7', { id: '2', time, price: 26300, size: 11, side: undefined }],
    ])
  })

  it('uses the Chicago evening boundary and skips the weekend', () => {
    expect(cmeTradingDay(Date.parse('2026-11-22T22:59:59Z'))).toBe('2026-11-22')
    expect(cmeTradingDay(Date.parse('2026-11-22T23:00:00Z'))).toBe('2026-11-23')
    expect(cmeTradingDay(Date.parse('2026-07-01T22:00:00Z'))).toBe('2026-07-02')
    expect(previousCmeTradingDay('2026-11-23')).toBe('2026-11-20')
  })
})
