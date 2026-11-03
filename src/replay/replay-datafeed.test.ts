import { describe, expect, it, vi } from 'vitest'
import type { Datafeed, Period } from '@klinecharts/pro'
import type { MarketDataService } from '../market-data/market-data-service'
import type { MarketCandle } from '../market-data/models'
import { nextOpenTime } from '../market-data/intervals'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import { ReplayDatafeed } from './replay-datafeed'
import { readIndicatorHistory } from '../market-data/indicator-history'

const minute = 60_000
const period = (text: string): Period => SUPPORTED_PERIODS.find((item) => item.text === text)!
const context = { sessionId: 'one', symbol: 'BTCUSDT', timeframe: '1m', currentTime: minute }

function candle(openTime: number, timeframe = '1m'): MarketCandle {
  return {
    symbol: 'BTCUSDT', timeframe, openTime, closeTime: nextOpenTime(openTime, timeframe) - 1,
    open: '10', high: '12', low: '9', close: '11', volume: '2', quoteVolume: '20',
    tradeCount: 1, isClosed: true, source: 'binance',
  }
}

function fixture(candles = Array.from({ length: 60 }, (_, index) => candle(index * minute))) {
  const base: Datafeed = {
    searchSymbols: vi.fn(async () => []),
    getHistoryKLineData: vi.fn(async () => { throw new Error('unexpected remote chart request') }),
    subscribe: vi.fn(), unsubscribe: vi.fn(),
  }
  const service = {
    loadCandles: vi.fn(async () => { throw new Error('unexpected remote candle request') }),
    loadReplayCandles: vi.fn(async () => []),
    loadCachedCandles: vi.fn(async (
      _kind: string, symbol: string, timeframe: string, from: number, to: number,
    ) => candles.filter((item) => item.symbol === symbol && item.timeframe === timeframe &&
      item.openTime >= from && item.openTime <= to)),
  } as unknown as MarketDataService
  const feed = new ReplayDatafeed(base, service)
  return { feed, base, service }
}

describe('ReplayDatafeed', () => {
  it('keeps indicator reads inside the replay boundary without changing chart selection', async () => {
    const { feed } = fixture()
    const selection = vi.fn()
    feed.setSelectionListener(selection)
    feed.setReplayContext(context)
    const result = await readIndicatorHistory(feed, DEFAULT_SYMBOL, period('1m'), 0, 60 * minute)
    expect(result.map((item) => item.timestamp)).toEqual([0, minute])
    expect(selection).not.toHaveBeenCalled()
  })

  it('reads replay history locally and filters out future candles', async () => {
    const { feed, base, service } = fixture()
    feed.setReplayContext(context)
    const visible = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1m'), 0, 30 * minute)
    expect(visible.map((item) => item.timestamp)).toEqual([0, minute])
    expect(service.loadCachedCandles).toHaveBeenCalledWith('trade', 'BTCUSDT', '1m', 0, minute)
    expect(base.getHistoryKLineData).not.toHaveBeenCalled()
    expect(service.loadCandles).not.toHaveBeenCalled()
  })

  it('uses completed local higher bars and builds the current bar without future OHLC', async () => {
    const { feed, service, base } = fixture([
      ...Array.from({ length: 12 }, (_, index) => candle(index * minute)),
      { ...candle(0, '5m'), high: '40', close: '30' },
      { ...candle(5 * minute, '5m'), high: '999', close: '999' },
    ])
    feed.setReplayContext({ ...context, currentTime: 7 * minute })
    const visible = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 0, 50 * minute)
    expect(visible).toEqual([
      expect.objectContaining({ timestamp: 0, high: 40, close: 30 }),
      expect.objectContaining({ timestamp: 5 * minute, high: 12, close: 11, volume: 6, turnover: 60 }),
    ])
    expect(base.getHistoryKLineData).not.toHaveBeenCalled()
    expect(service.loadCandles).not.toHaveBeenCalled()
  })

  it('reveals smaller cached bars only through the end of the known source candle', async () => {
    const { feed } = fixture()
    feed.setReplayContext({ ...context, timeframe: '15m', currentTime: 0 })
    const visible = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1m'), 0, 60 * minute)
    expect(visible.map((item) => item.timestamp)).toEqual(Array.from({ length: 15 }, (_, index) => index * minute))
  })

  it('requests missing smaller bars in a batch without inventing intrabar movement', async () => {
    const { feed, service, base } = fixture([candle(0, '15m')])
    const warning = vi.fn()
    feed.setWarningListener(warning)
    feed.setReplayContext({ ...context, timeframe: '15m', currentTime: 0 })
    await expect(feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1m'), 0, 60 * minute)).resolves.toEqual([])
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('数据仍不完整'))
    expect(service.loadReplayCandles).toHaveBeenCalledWith('trade', 'BTCUSDT', '1m', 0, 14 * minute, expect.any(Object))
    expect(service.loadCandles).not.toHaveBeenCalled()
    expect(base.getHistoryKLineData).not.toHaveBeenCalled()
  })

  it('builds incompatible period boundaries from cached minute bars', async () => {
    const { feed, service } = fixture()
    feed.setReplayContext({ ...context, timeframe: '3m', currentTime: 3 * minute })
    const visible = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 5 * minute, 60 * minute)
    expect(service.loadCachedCandles).toHaveBeenCalledWith('trade', 'BTCUSDT', '1m', 5 * minute, 6 * minute - 1)
    expect(visible.at(-1)).toMatchObject({ timestamp: 5 * minute, high: 12, close: 11, volume: 2 })
  })

  it('rebases the chart window to replay time and updates the partial local bar', async () => {
    const { feed } = fixture()
    feed.setReplayContext(context)
    const visible = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 86_400_000, 86_460_000)
    expect(visible.at(-1)).toMatchObject({ timestamp: 0, volume: 4 })
    const callback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('5m'), callback)
    feed.setReplayContext({ ...context, currentTime: 2 * minute })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 0, volume: 6 })))
  })

  it('pushes every smaller bar revealed by a replay step without remote reads', async () => {
    const { feed, base, service } = fixture(Array.from({ length: 12 }, (_, index) => candle(index * 5 * minute, '5m')))
    feed.setReplayContext({ ...context, timeframe: '15m', currentTime: 0 })
    const callback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('5m'), callback)
    feed.setReplayContext({ ...context, timeframe: '15m', currentTime: 15 * minute })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(4))
    expect(callback.mock.calls.map(([item]) => item.timestamp)).toEqual([10, 15, 20, 25].map((value) => value * minute))
    expect(base.getHistoryKLineData).not.toHaveBeenCalled()
    expect(service.loadCandles).not.toHaveBeenCalled()
  })

  it('discards delayed local updates after the chart switches periods', async () => {
    const { feed, service } = fixture()
    let resolve!: (items: MarketCandle[]) => void
    vi.mocked(service.loadCachedCandles).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    feed.setReplayContext(context)
    const oldCallback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('5m'), oldCallback)
    feed.setReplayContext({ ...context, currentTime: 2 * minute })
    feed.unsubscribe(DEFAULT_SYMBOL, period('5m'))
    feed.subscribe(DEFAULT_SYMBOL, period('15m'), vi.fn())
    resolve([candle(0, '5m')])
    await new Promise((done) => setTimeout(done, 0))
    expect(oldCallback).not.toHaveBeenCalled()
  })

  it('catches up steps that finish while a local period window is loading', async () => {
    const { feed, service } = fixture()
    feed.setReplayContext({ ...context, timeframe: '15m', currentTime: 0 })
    let resolve!: (items: MarketCandle[]) => void
    vi.mocked(service.loadCachedCandles).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1m'), 0, 60 * minute)
    feed.setReplayContext({ ...context, timeframe: '15m', currentTime: 15 * minute })
    resolve(Array.from({ length: 15 }, (_, index) => candle(index * minute)))
    await pending
    const callback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('1m'), callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(16))
    expect(callback.mock.calls.map(([item]) => item.timestamp)).toEqual(Array.from({ length: 16 }, (_, index) => (14 + index) * minute))
  })

  it('finalizes a previous higher bar and starts a partial bar at the boundary', async () => {
    const { feed } = fixture([...Array.from({ length: 10 }, (_, index) => candle(index * minute)), { ...candle(0, '5m'), high: '40' }])
    feed.setReplayContext({ ...context, currentTime: 3 * minute })
    const callback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('5m'), callback)
    feed.setReplayContext({ ...context, currentTime: 5 * minute })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2))
    expect(callback.mock.calls[0][0]).toMatchObject({ timestamp: 0, high: 40 })
    expect(callback.mock.calls[1][0]).toMatchObject({ timestamp: 5 * minute, high: 12, volume: 2 })
  })

  it('supports a locally built monthly bar across calendar boundaries', async () => {
    const start = Date.UTC(2026, 1, 1)
    const { feed } = fixture([candle(Date.UTC(2026, 0, 1), '1M'), candle(start, '1d')])
    feed.setReplayContext({ ...context, timeframe: '1d', currentTime: start })
    const visible = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1M'), Date.UTC(2026, 0, 1), Date.UTC(2026, 2, 1))
    expect(visible.map((item) => item.timestamp)).toEqual([Date.UTC(2026, 0, 1), start])
    expect(visible.at(-1)).toMatchObject({ volume: 2, high: 12, close: 11 })
  })

  it('restarts an in-flight live request locally when replay becomes active', async () => {
    const { feed, base, service } = fixture()
    let resolve!: (items: []) => void
    vi.mocked(base.getHistoryKLineData).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1m'), 86_400_000, 86_460_000)
    feed.setReplayContext(context)
    resolve([])
    await expect(pending).resolves.toEqual([expect.objectContaining({ timestamp: 0 }), expect.objectContaining({ timestamp: minute })])
    expect(base.getHistoryKLineData).toHaveBeenCalledOnce()
    expect(service.loadCandles).not.toHaveBeenCalled()
  })

  it('keeps source candles in memory during advancement even if IndexedDB is unavailable', async () => {
    const { feed, base, service } = fixture([])
    feed.setSessionCandles('one', Array.from({ length: 4 }, (_, index) => candle(index * minute)))
    feed.setReplayContext({ ...context, currentTime: 0 })
    const callback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('1m'), callback)
    feed.setReplayContext(context)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(expect.objectContaining({ timestamp: minute })))
    expect(service.loadCachedCandles).not.toHaveBeenCalled()
    expect(service.loadCandles).not.toHaveBeenCalled()
    expect(base.getHistoryKLineData).not.toHaveBeenCalled()
  })

  it('refuses to build a misleading bar from a source range with gaps', async () => {
    const { feed } = fixture([candle(0), candle(2 * minute)])
    feed.setReplayContext({ ...context, currentTime: 2 * minute })
    await expect(feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 0, 5 * minute)).resolves.toEqual([])
  })

  it('blocks a symbol change while replay is active', async () => {
    const { feed, base } = fixture()
    const warning = vi.fn()
    feed.setWarningListener(warning)
    feed.setReplayContext(context)
    await expect(feed.getHistoryKLineData({ ...DEFAULT_SYMBOL, ticker: 'ETHUSDT' }, period('1m'), 0, minute)).resolves.toEqual([])
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('不能切换'))
    expect(base.getHistoryKLineData).not.toHaveBeenCalled()
  })

  it('switches live subscriptions off and back on at replay boundaries', () => {
    const { feed, base } = fixture()
    const callback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('1m'), callback)
    feed.setReplayContext(context)
    expect(base.unsubscribe).toHaveBeenCalledWith(DEFAULT_SYMBOL, period('1m'))
    feed.setReplayContext(null)
    expect(base.subscribe).toHaveBeenCalledTimes(2)
  })
})
