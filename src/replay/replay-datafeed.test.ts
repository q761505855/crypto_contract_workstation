import { describe, expect, it, vi } from 'vitest'
import type { Datafeed } from '@klinecharts/pro'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import type { MarketDataService } from '../market-data/market-data-service'
import { ReplayDatafeed } from './replay-datafeed'

describe('ReplayDatafeed', () => {
  it('never passes future candles to the chart during replay', async () => {
    const base: Datafeed = {
      searchSymbols: vi.fn(async () => []),
      getHistoryKLineData: vi.fn(async () => [
        { timestamp: 0, open: 1, high: 1, low: 1, close: 1 },
        { timestamp: 60_000, open: 1, high: 1, low: 1, close: 1 },
        { timestamp: 120_000, open: 1, high: 1, low: 1, close: 1 },
      ]),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    }
    const service = {} as MarketDataService
    const datafeed = new ReplayDatafeed(base, service)
    datafeed.setReplayContext({
      sessionId: 'one',
      symbol: 'BTCUSDT',
      timeframe: '1m',
      currentTime: 60_000,
    })

    const visible = await datafeed.getHistoryKLineData(
      DEFAULT_SYMBOL,
      SUPPORTED_PERIODS[0],
      0,
      180_000,
    )

    expect(base.getHistoryKLineData).toHaveBeenCalledWith(
      DEFAULT_SYMBOL,
      SUPPORTED_PERIODS[0],
      0,
      60_000,
    )
    expect(visible.map((item) => item.timestamp)).toEqual([0, 60_000])
  })

  it('rebases the initial chart window when wall-clock time is after replay time', async () => {
    const base: Datafeed = {
      searchSymbols: vi.fn(async () => []),
      getHistoryKLineData: vi.fn(async () => [
        {
          timestamp: 60_000,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
        },
      ]),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    }
    const datafeed = new ReplayDatafeed(base, {} as MarketDataService)
    datafeed.setReplayContext({
      sessionId: 'one',
      symbol: 'BTCUSDT',
      timeframe: '1m',
      currentTime: 60_000,
    })

    await datafeed.getHistoryKLineData(
      DEFAULT_SYMBOL,
      SUPPORTED_PERIODS[0],
      86_400_000,
      86_460_000,
    )

    expect(base.getHistoryKLineData).toHaveBeenCalledWith(
      DEFAULT_SYMBOL,
      SUPPORTED_PERIODS[0],
      60_000 - 499 * 60_000,
      60_000,
    )
  })

  it('restarts an in-flight live request when replay becomes active', async () => {
    let resolveLive!: (value: Array<{
      timestamp: number
      open: number
      high: number
      low: number
      close: number
    }>) => void
    const liveRequest = new Promise<Parameters<typeof resolveLive>[0]>(
      (resolve) => {
        resolveLive = resolve
      },
    )
    const base: Datafeed = {
      searchSymbols: vi.fn(async () => []),
      getHistoryKLineData: vi
        .fn()
        .mockReturnValueOnce(liveRequest)
        .mockResolvedValueOnce([
          { timestamp: 60_000, open: 1, high: 1, low: 1, close: 1 },
        ]),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    }
    const datafeed = new ReplayDatafeed(base, {} as MarketDataService)
    const pending = datafeed.getHistoryKLineData(
      DEFAULT_SYMBOL,
      SUPPORTED_PERIODS[0],
      86_400_000,
      86_460_000,
    )

    datafeed.setReplayContext({
      sessionId: 'one',
      symbol: 'BTCUSDT',
      timeframe: '1m',
      currentTime: 60_000,
    })
    resolveLive([
      {
        timestamp: 86_400_000,
        open: 2,
        high: 2,
        low: 2,
        close: 2,
      },
    ])

    await expect(pending).resolves.toEqual([
      { timestamp: 60_000, open: 1, high: 1, low: 1, close: 1 },
    ])
    expect(base.getHistoryKLineData).toHaveBeenCalledTimes(2)
  })

  it('pushes only the newly visible candle to the active subscription', async () => {
    const base: Datafeed = {
      searchSymbols: vi.fn(async () => []),
      getHistoryKLineData: vi.fn(async () => []),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    }
    const service = {
      loadCandles: vi.fn(async () => [
        {
          symbol: 'BTCUSDT',
          timeframe: '1m',
          openTime: 60_000,
          closeTime: 119_999,
          open: '1',
          high: '2',
          low: '0.5',
          close: '1.5',
          volume: '10',
          quoteVolume: '15',
          tradeCount: 2,
          isClosed: true,
          source: 'binance',
        },
      ]),
    } as unknown as MarketDataService
    const datafeed = new ReplayDatafeed(base, service)
    const callback = vi.fn()
    datafeed.subscribe(
      DEFAULT_SYMBOL,
      SUPPORTED_PERIODS[0],
      callback,
    )

    datafeed.setReplayContext({
      sessionId: 'one',
      symbol: 'BTCUSDT',
      timeframe: '1m',
      currentTime: 60_000,
    })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: 60_000, close: 1.5 }),
    )
  })

  it('blocks symbol changes while a replay session is active', async () => {
    const base: Datafeed = {
      searchSymbols: vi.fn(async () => []),
      getHistoryKLineData: vi.fn(async () => []),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    }
    const datafeed = new ReplayDatafeed(base, {} as MarketDataService)
    const warning = vi.fn()
    datafeed.setWarningListener(warning)
    datafeed.setReplayContext({
      sessionId: 'one',
      symbol: 'BTCUSDT',
      timeframe: '1m',
      currentTime: 60_000,
    })

    await expect(
      datafeed.getHistoryKLineData(
        { ...DEFAULT_SYMBOL, ticker: 'ETHUSDT' },
        SUPPORTED_PERIODS[0],
        0,
        60_000,
      ),
    ).resolves.toEqual([])
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('不能切换'))
  })

  it('switches the active chart subscription between live and replay', () => {
    const base: Datafeed = {
      searchSymbols: vi.fn(async () => []),
      getHistoryKLineData: vi.fn(async () => []),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    }
    const datafeed = new ReplayDatafeed(base, {} as MarketDataService)
    const callback = vi.fn()
    datafeed.subscribe(
      DEFAULT_SYMBOL,
      SUPPORTED_PERIODS[0],
      callback,
    )
    expect(base.subscribe).toHaveBeenCalledOnce()

    datafeed.setReplayContext({
      sessionId: 'one',
      symbol: 'BTCUSDT',
      timeframe: '1m',
      currentTime: 0,
    })
    expect(base.unsubscribe).toHaveBeenCalledWith(
      DEFAULT_SYMBOL,
      SUPPORTED_PERIODS[0],
    )

    datafeed.setReplayContext(null)
    expect(base.subscribe).toHaveBeenCalledTimes(2)
    expect(base.subscribe).toHaveBeenLastCalledWith(
      DEFAULT_SYMBOL,
      SUPPORTED_PERIODS[0],
      callback,
    )
  })
})
