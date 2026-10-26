import { describe, expect, it, vi } from 'vitest'
import type { Datafeed, Period } from '@klinecharts/pro'
import type { KLineData } from 'klinecharts'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import type { MarketDataService } from '../market-data/market-data-service'
import { ReplayDatafeed } from './replay-datafeed'
import { alignOpenTime, nextOpenTime } from '../market-data/intervals'
import type { MarketCandle } from '../market-data/models'

const minute = 60_000
const period = (text: string): Period => SUPPORTED_PERIODS.find(
  (candidate) => candidate.text === text,
)!

function candle(openTime: number, timeframe = '1m'): MarketCandle {
  return {
    symbol: 'BTCUSDT', timeframe, openTime,
    closeTime: nextOpenTime(openTime, timeframe) - 1,
    open: '10', high: '12', low: '9', close: '11',
    volume: '2', quoteVolume: '20', tradeCount: 1,
    isClosed: true, source: 'binance',
  }
}

function createPeriodFeed() {
  const base: Datafeed = {
    searchSymbols: vi.fn(async () => []),
    getHistoryKLineData: vi.fn(async (
      _symbol, selectedPeriod, from, to,
    ): Promise<KLineData[]> => {
      const result: KLineData[] = []
      for (let time = alignOpenTime(from, selectedPeriod.text, 'ceil');
        time <= to; time = nextOpenTime(time, selectedPeriod.text)) {
        result.push({ timestamp: time, open: 10, high: 99, low: 1, close: 80 })
      }
      return result
    }),
    subscribe: vi.fn(), unsubscribe: vi.fn(),
  }
  const service = {
    loadCandles: vi.fn(async (
      _kind: string, _symbol: string, timeframe: string, from: number, to: number,
    ) => {
      const result: MarketCandle[] = []
      for (let time = alignOpenTime(from, timeframe, 'ceil'); time <= to;
        time = nextOpenTime(time, timeframe)) result.push(candle(time, timeframe))
      // Include an extra future candle to verify defensive filtering.
      result.push({ ...candle(nextOpenTime(to, timeframe), timeframe), high: '999' })
      return result
    }),
  } as unknown as MarketDataService
  return { base, service, feed: new ReplayDatafeed(base, service) }
}

describe('ReplayDatafeed', () => {
  it('switches to a higher period at the same time without revealing its future OHLC', async () => {
    const { feed, base } = createPeriodFeed()
    const context = { sessionId: 'one', symbol: 'BTCUSDT', timeframe: '1m', currentTime: 2 * minute }
    feed.setReplayContext(context)

    const visible = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), -5 * minute, 50 * minute)

    expect(visible).toEqual([
      { timestamp: -5 * minute, open: 10, high: 99, low: 1, close: 80 },
      { timestamp: 0, open: 10, high: 12, low: 9, close: 11, volume: 6, turnover: 60 },
    ])
    expect(base.getHistoryKLineData).toHaveBeenCalledWith(DEFAULT_SYMBOL, period('5m'), -5 * minute, -5 * minute)
    expect(feed.getReplayContext()).toEqual(context)
  })

  it('reveals all smaller candles within the source candle and no later candles', async () => {
    const { feed } = createPeriodFeed()
    feed.setReplayContext({ sessionId: 'one', symbol: 'BTCUSDT', timeframe: '15m', currentTime: 0 })
    const visible = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1m'), 0, 60 * minute)
    expect(visible.map((item) => item.timestamp)).toEqual(Array.from({ length: 15 }, (_, index) => index * minute))
  })

  it('uses minute data when the chart bucket does not align with the source period', async () => {
    const { feed, service } = createPeriodFeed()
    feed.setReplayContext({ sessionId: 'one', symbol: 'BTCUSDT', timeframe: '3m', currentTime: 3 * minute })
    const visible = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 0, 60 * minute)
    expect(service.loadCandles).toHaveBeenCalledWith('trade', 'BTCUSDT', '1m', 5 * minute, 6 * minute - 1)
    expect(visible.at(-1)).toMatchObject({ timestamp: 5 * minute, high: 12, close: 11, volume: 2 })
  })

  it('rebases a new period around replay time and updates the partial candle while advancing', async () => {
    const { feed } = createPeriodFeed()
    const context = { sessionId: 'one', symbol: 'BTCUSDT', timeframe: '1m', currentTime: minute }
    feed.setReplayContext(context)
    const visible = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 86_400_000, 86_460_000)
    expect(visible).toHaveLength(499)
    expect(visible.at(-1)).toMatchObject({ timestamp: 0, volume: 4 })
    const callback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('5m'), callback)
    feed.setReplayContext({ ...context, currentTime: 2 * minute })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 0, volume: 6 })))
  })

  it('pushes every newly visible lower-period candle on each replay step', async () => {
    const { feed } = createPeriodFeed()
    const context = { sessionId: 'one', symbol: 'BTCUSDT', timeframe: '15m', currentTime: 0 }
    feed.setReplayContext(context)
    const callback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('5m'), callback)
    feed.setReplayContext({ ...context, currentTime: 15 * minute })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(4))
    expect(callback.mock.calls.map(([item]) => item.timestamp)).toEqual([10, 15, 20, 25].map((value) => value * minute))
  })

  it('discards in-flight updates after the chart switches periods', async () => {
    const { feed, service } = createPeriodFeed()
    let resolve!: (candles: MarketCandle[]) => void
    vi.mocked(service.loadCandles).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const context = { sessionId: 'one', symbol: 'BTCUSDT', timeframe: '1m', currentTime: 0 }
    feed.setReplayContext(context)
    const oldCallback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('5m'), oldCallback)
    feed.setReplayContext({ ...context, currentTime: minute })
    feed.unsubscribe(DEFAULT_SYMBOL, period('5m'))
    feed.subscribe(DEFAULT_SYMBOL, period('15m'), vi.fn())
    resolve([candle(0), candle(minute)])
    await new Promise((done) => setTimeout(done, 0))
    expect(oldCallback).not.toHaveBeenCalled()
  })

  it('catches up playback steps that finish while a new period is loading', async () => {
    const { feed, base } = createPeriodFeed()
    const context = { sessionId: 'one', symbol: 'BTCUSDT', timeframe: '15m', currentTime: 0 }
    feed.setReplayContext(context)
    let resolve!: (candles: KLineData[]) => void
    vi.mocked(base.getHistoryKLineData).mockImplementationOnce(
      () => new Promise((done) => { resolve = done }),
    )
    const pending = feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1m'), 0, 60 * minute)
    feed.setReplayContext({ ...context, currentTime: 15 * minute })
    resolve(Array.from({ length: 15 }, (_, index) => ({
      timestamp: index * minute, open: 10, high: 12, low: 9, close: 11,
    })))
    await pending
    const callback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('1m'), callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(16))
    expect(callback.mock.calls.map(([item]) => item.timestamp)).toEqual(
      Array.from({ length: 16 }, (_, index) => (14 + index) * minute),
    )
  })

  it('updates the completed previous bucket when playback crosses into a new one', async () => {
    const { feed } = createPeriodFeed()
    const context = { sessionId: 'one', symbol: 'BTCUSDT', timeframe: '1m', currentTime: 3 * minute }
    feed.setReplayContext(context)
    const callback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('5m'), callback)
    feed.setReplayContext({ ...context, currentTime: 5 * minute })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2))
    expect(callback.mock.calls[0][0]).toMatchObject({ timestamp: 0, high: 99, close: 80 })
    expect(callback.mock.calls[1][0]).toMatchObject({ timestamp: 5 * minute, high: 12, close: 11, volume: 2 })
  })

  it('supports a partial monthly candle across a month boundary', async () => {
    const { feed } = createPeriodFeed()
    const start = Date.UTC(2026, 1, 1)
    feed.setReplayContext({ sessionId: 'one', symbol: 'BTCUSDT', timeframe: '1d', currentTime: start })
    const visible = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1M'), Date.UTC(2026, 0, 1), Date.UTC(2026, 2, 1))
    expect(visible.map((item) => item.timestamp)).toEqual([Date.UTC(2026, 0, 1), start])
    expect(visible.at(-1)).toMatchObject({ timestamp: start, volume: 2, high: 12, close: 11 })
  })

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
      60_000 - 498 * 60_000,
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
