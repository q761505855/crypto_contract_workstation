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

  it('returns identical candles for shared timestamps across overlapping windows', async () => {
    const now = 1_800_000_000_000
    const datafeed = new DemoDatafeed(() => now)
    const period = SUPPORTED_PERIODS.find((item) => item.text === '5m')
    expect(period).toBeDefined()

    const firstWindow = await datafeed.getHistoryKLineData(
      DEFAULT_SYMBOL,
      period!,
      now - 25 * 60_000,
      now - 5 * 60_000,
    )
    const secondWindow = await datafeed.getHistoryKLineData(
      DEFAULT_SYMBOL,
      period!,
      now - 15 * 60_000,
      now + 5 * 60_000,
    )

    expect(secondWindow.slice(0, 3)).toEqual(firstWindow.slice(2))
  })

  it('aligns an unaligned requested end and injected now to period boundaries', async () => {
    const now = 1_800_000_123_456
    const datafeed = new DemoDatafeed(() => now)
    const period = SUPPORTED_PERIODS.find((item) => item.text === '5m')
    expect(period).toBeDefined()

    const from = now - 600 * 5 * 60_000
    const to = now + 60_000
    const rows = await datafeed.getHistoryKLineData(
      DEFAULT_SYMBOL,
      period!,
      from,
      to,
    )

    expect(rows).not.toHaveLength(0)
    expect(rows).toHaveLength(500)
    expect(rows.every((row) => row.timestamp % (5 * 60_000) === 0)).toBe(true)
    expect(rows.every((row) => row.timestamp >= from && row.timestamp <= now)).toBe(
      true,
    )
    expect(rows.at(-1)?.timestamp).toBe(Math.floor(now / (5 * 60_000)) * 5 * 60_000)
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
