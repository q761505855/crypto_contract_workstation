import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from './chart-config'
import { DemoDatafeed } from './demo-datafeed'

describe('DemoDatafeed', () => {
  it('filters symbols without case sensitivity', async () => {
    const datafeed = new DemoDatafeed()
    await expect(datafeed.searchSymbols('eth')).resolves.toEqual([
      expect.objectContaining({ ticker: 'ETHUSDT' }),
    ])
  })

  it('returns deterministic ascending candles inside the requested range', async () => {
    const now = 1_800_000_000_000
    const datafeed = new DemoDatafeed(() => now)
    const period = SUPPORTED_PERIODS.find((item) => item.text === '5m')
    expect(period).toBeDefined()

    const rows = await datafeed.getHistoryKLineData(
      DEFAULT_SYMBOL,
      period!,
      now - 15 * 60_000,
      now,
    )

    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.timestamp)).toEqual([
      now - 15 * 60_000,
      now - 10 * 60_000,
      now - 5 * 60_000,
      now,
    ])
    expect(rows.every((row) => row.high >= row.low)).toBe(true)
  })

  it('does not emit live updates in Phase 1', () => {
    const datafeed = new DemoDatafeed()
    const callback = vi.fn()
    datafeed.subscribe(DEFAULT_SYMBOL, SUPPORTED_PERIODS[0], callback)
    expect(callback).not.toHaveBeenCalled()
    expect(() =>
      datafeed.unsubscribe(DEFAULT_SYMBOL, SUPPORTED_PERIODS[0]),
    ).not.toThrow()
  })
})
