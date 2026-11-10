import { describe, expect, it, vi } from 'vitest'
import type { Datafeed, Period } from '@klinecharts/pro'
import type { MarketDataService } from '../market-data/market-data-service'
import type { MarketCandle } from '../market-data/models'
import { alignOpenTime, nextOpenTime } from '../market-data/intervals'
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
    getSymbolOnboardDate: vi.fn(async (): Promise<number | undefined> => undefined),
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
  it('bounds daily minute history to one year even on jumps and older pages', async () => {
    const previousDay = Date.UTC(2023, 11, 29)
    const firstAllowedDay = Date.UTC(2023, 11, 30)
    const rows = Array.from({ length: 2 * 1440 }, (_, index) => candle(previousDay + index * minute))
    const { feed, service } = fixture(rows)
    Object.assign(service, { usesMinuteHistory: () => true })
    vi.mocked(service.getSymbolOnboardDate).mockResolvedValue(Date.UTC(2020, 0, 1))
    const status = vi.fn()
    feed.setHistoryStatusListener(status)
    feed.setReplayContext({ ...context, currentTime: Date.UTC(2024, 11, 30) })

    const bars = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1d'), previousDay, firstAllowedDay)
    expect(bars.map(row => row.timestamp)).toEqual([firstAllowedDay])
    const outside = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1d'), previousDay, previousDay)
    expect(outside).toEqual([])
    await expect(feed.getOlderHistory(DEFAULT_SYMBOL, period('1d'), firstAllowedDay))
      .resolves.toEqual({ candles: [], hasMore: false })
    expect(status).toHaveBeenLastCalledWith('已到回放历史上限（1 年）')
  })

  it.each([
    ['3d', Date.UTC(2023, 11, 29)],
    ['1w', Date.UTC(2023, 11, 25)],
    ['1M', Date.UTC(2023, 11, 1)],
  ])('shows native %s history older than a year on jumps and older pages', async (timeframe, firstOpen) => {
    const { feed, service } = fixture([candle(firstOpen, timeframe)])
    Object.assign(service, { usesMinuteHistory: () => true })
    vi.mocked(service.getSymbolOnboardDate).mockResolvedValue(firstOpen)
    const status = vi.fn()
    feed.setHistoryStatusListener(status)
    feed.setReplayContext({ ...context, currentTime: Date.UTC(2024, 11, 30) })

    const bars = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period(timeframe), firstOpen, firstOpen)
    expect(bars.map(row => row.timestamp)).toEqual([firstOpen])
    await expect(feed.getOlderHistory(DEFAULT_SYMBOL, period(timeframe), Date.UTC(2024, 0, 1)))
      .resolves.toEqual({ candles: [expect.objectContaining({ timestamp: firstOpen })], hasMore: false })
    expect(status).toHaveBeenLastCalledWith('已到最早历史数据')
    expect(service.loadCachedCandles).not.toHaveBeenCalledWith('trade', 'BTCUSDT', '1m', expect.anything(), expect.anything())
  })

  it('pages daily minute archives backwards across multiple months to the listing boundary', async () => {
    const first = Date.UTC(2024, 6, 1)
    const before = Date.UTC(2024, 10, 4)
    const rows = Array.from({ length: (before - first) / minute }, (_, index) => candle(first + index * minute))
    const { feed, service } = fixture(rows)
    Object.assign(service, { usesMinuteHistory: () => true })
    vi.mocked(service.getSymbolOnboardDate).mockResolvedValue(first)
    const status = vi.fn()
    feed.setHistoryStatusListener(status)
    feed.setReplayContext({ ...context, currentTime: Date.UTC(2024, 11, 30) })

    const recent = await feed.getOlderHistory(DEFAULT_SYMBOL, period('1d'), before)
    expect(recent?.candles.at(0)?.timestamp).toBe(Date.UTC(2024, 9, 1))
    expect(recent?.candles.at(-1)?.timestamp).toBe(Date.UTC(2024, 10, 3))
    expect(recent?.hasMore).toBe(true)
    const earlier = await feed.getOlderHistory(DEFAULT_SYMBOL, period('1d'), recent!.candles[0].timestamp)
    expect(earlier?.candles.at(0)?.timestamp).toBe(Date.UTC(2024, 7, 1))
    expect(earlier?.hasMore).toBe(true)
    const earliest = await feed.getOlderHistory(DEFAULT_SYMBOL, period('1d'), earlier!.candles[0].timestamp)
    expect(earliest?.candles.at(0)?.timestamp).toBe(first)
    expect(earliest?.hasMore).toBe(false)
    expect(status).toHaveBeenLastCalledWith('已到最早历史数据')
    expect(service.loadCandles).not.toHaveBeenCalled()
  })

  it('leaves an empty failed page retryable and keeps its warning separate from the history boundary', async () => {
    const monday = Date.UTC(2024, 9, 28)
    const nextMonday = Date.UTC(2024, 10, 4)
    const rows: MarketCandle[] = []
    const { feed, service } = fixture(rows)
    Object.assign(service, { usesMinuteHistory: () => true })
    vi.mocked(service.getSymbolOnboardDate).mockResolvedValue(monday)
    vi.mocked(service.loadCandles).mockRejectedValueOnce(new Error('API temporarily unavailable'))
      .mockImplementationOnce(async () => {
        rows.push(candle(monday, '1w'))
        return []
      })
    const status = vi.fn()
    feed.setHistoryStatusListener(status)
    feed.setReplayContext({ ...context, currentTime: nextMonday })

    await expect(feed.getOlderHistory(DEFAULT_SYMBOL, period('1w'), nextMonday))
      .resolves.toEqual({ candles: [], hasMore: true })
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('可重试'))
    await expect(feed.getOlderHistory(DEFAULT_SYMBOL, period('1w'), nextMonday))
      .resolves.toEqual({ candles: [expect.objectContaining({ timestamp: monday })], hasMore: false })
    expect(status).toHaveBeenLastCalledWith('已到最早历史数据')
  })
  it('does not restore an old chart period when an in-flight request restarts after replay exits', async () => {
    const { feed, service, base } = fixture()
    const selection = vi.fn()
    feed.setSelectionListener(selection)
    feed.setReplayContext(context)
    let resolve!: (items: MarketCandle[]) => void
    vi.mocked(service.loadCachedCandles).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 0, 30 * minute)
    await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1m'), 0, minute)
    feed.setReplayContext(null)
    vi.mocked(base.getHistoryKLineData).mockResolvedValue([])
    resolve([candle(0, '5m')])
    await pending
    expect(selection.mock.calls.map(([item]) => item.period.text)).toEqual(['5m', '1m'])
  })

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

  it.each([
    ['1d', Date.UTC(2026, 0, 31), Date.UTC(2026, 1, 1)],
    ['1w', Date.UTC(2026, 0, 26), Date.UTC(2026, 1, 2)],
    ['1M', Date.UTC(2024, 1, 1), Date.UTC(2024, 2, 1)],
  ])('builds a partial %s only from revealed minutes across calendar boundaries', async (timeframe, start, end) => {
    const currentTime = end - 3 * minute
    const rows = Array.from({ length: (end - start) / minute + 1 }, (_, index) => {
      const openTime = start + index * minute
      return openTime >= end - minute ? { ...candle(openTime), high: '999', close: '900' } : candle(openTime)
    })
    const { feed, service } = fixture([...rows, { ...candle(start, timeframe), high: '999', close: '900' }])
    Object.assign(service, { usesMinuteHistory: () => true })
    feed.setReplayContext({ ...context, currentTime })
    const visible = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period(timeframe), start, end + 86_400_000)
    expect(visible).toEqual([expect.objectContaining({ timestamp: start, high: 12, close: 11, volume: ((end - start) / minute - 2) * 2 })])
    // Requesting an unfinished cached higher bucket can make the minute service
    // read its entire future tail before the replay layer discards the result.
    expect(vi.mocked(service.loadCachedCandles).mock.calls.filter((call) => call[2] === timeframe)
      .every((call) => nextOpenTime(call[4], timeframe) <= currentTime + minute)).toBe(true)
    const callback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period(timeframe), callback)
    feed.setReplayContext({ ...context, currentTime: currentTime + minute })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(expect.objectContaining({ timestamp: start, high: 12, close: 11, volume: ((end - start) / minute - 1) * 2 })))
    expect(callback.mock.calls.every(([bar]) => bar.high === 12)).toBe(true)
    expect(vi.mocked(service.loadCachedCandles).mock.calls.every((call) => call[4] < end - minute)).toBe(true)
  })

  it('does not publish stale subscription data after a session switches away and back', async () => {
    const { feed, service } = fixture()
    feed.setReplayContext({ ...context, currentTime: 0 })
    const callback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('1m'), callback)
    let resolve!: (rows: MarketCandle[]) => void
    vi.mocked(service.loadCachedCandles).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    feed.setReplayContext(context)
    feed.setReplayContext({ ...context, sessionId: 'two' })
    feed.setReplayContext(context)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    callback.mockClear()
    resolve([{ ...candle(minute), high: '999', close: '999' }])
    await new Promise((done) => setTimeout(done, 0))
    expect(callback).not.toHaveBeenCalled()
  })

  it('rechecks an in-flight history boundary after a rewind and return without restoring the old period', async () => {
    const { feed, service } = fixture()
    const selection = vi.fn()
    feed.setSelectionListener(selection)
    feed.setReplayContext(context)
    let resolve!: (rows: MarketCandle[]) => void
    vi.mocked(service.loadCachedCandles).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1m'), 0, 30 * minute)
    feed.setReplayContext({ ...context, currentTime: 0 })
    feed.setReplayContext(context)
    await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 0, 30 * minute)
    resolve([candle(0), { ...candle(minute), high: '999', close: '999' }])
    const result = await pending
    expect(result.map((bar) => bar.timestamp)).toEqual([0, minute])
    expect(result.every((bar) => bar.high === 12)).toBe(true)
    expect(selection.mock.calls.map(([item]) => item.period.text)).toEqual(['1m', '5m'])
  })

  it('keeps rejected symbols from changing the active selection', async () => {
    const { feed } = fixture()
    const selection = vi.fn()
    feed.setSelectionListener(selection)
    feed.setReplayContext(context)
    await expect(feed.getHistoryKLineData({ ...DEFAULT_SYMBOL, ticker: 'ETHUSDT' }, period('1h'), 0, minute)).resolves.toEqual([])
    expect(selection).not.toHaveBeenCalled()
  })

  it.each(SUPPORTED_PERIODS.filter((item) => item.text !== '1m').map((item) => item.text))('never substitutes a future complete %s cache for its revealed first minute', async (timeframe) => {
    const start = alignOpenTime(Date.UTC(2026, 5, 17, 12), timeframe, 'floor')
    const { feed, service } = fixture([
      candle(start), { ...candle(start + minute), high: '999', close: '999' },
      { ...candle(start, timeframe), high: '999', close: '999' },
    ])
    Object.assign(service, { usesMinuteHistory: () => true })
    feed.setReplayContext({ ...context, currentTime: start })
    const result = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period(timeframe), start, nextOpenTime(start, timeframe))
    expect(result).toEqual([expect.objectContaining({ timestamp: start, high: 12, close: 11, volume: 2 })])
    expect(vi.mocked(service.loadCachedCandles).mock.calls.every((call) => call[4] <= start + minute - 1)).toBe(true)
  })

  it('restarts a rejected old history request within the replacement session boundary', async () => {
    const { feed, service } = fixture()
    const selection = vi.fn()
    feed.setSelectionListener(selection)
    feed.setReplayContext(context)
    let reject!: (reason: Error) => void
    vi.mocked(service.loadCachedCandles).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const pending = feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1m'), 0, 30 * minute)
    feed.setReplayContext({ ...context, sessionId: 'two', currentTime: 0 })
    reject(new Error('old session database error'))
    await expect(pending).resolves.toEqual([expect.objectContaining({ timestamp: 0, high: 12 })])
    expect(selection).toHaveBeenCalledOnce()
  })

  it('does not publish warnings from a retired session subscription', async () => {
    const { feed, service } = fixture()
    const warning = vi.fn()
    feed.setWarningListener(warning)
    feed.setReplayContext({ ...context, currentTime: 0 })
    const callback = vi.fn()
    feed.subscribe(DEFAULT_SYMBOL, period('1m'), callback)
    let reject!: (reason: Error) => void
    vi.mocked(service.loadCachedCandles).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    feed.setReplayContext(context)
    feed.setReplayContext({ ...context, sessionId: 'two' })
    reject(new Error('retired request failed'))
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    expect(warning).not.toHaveBeenCalled()
  })

  it('stops an emission batch immediately if a callback rewinds the replay', async () => {
    const { feed } = fixture(Array.from({ length: 6 }, (_, index) => candle(index * 5 * minute, '5m')))
    const initial = { ...context, timeframe: '15m', currentTime: 0 }
    feed.setReplayContext(initial)
    const callback = vi.fn(() => { feed.setReplayContext(initial) })
    feed.subscribe(DEFAULT_SYMBOL, period('5m'), callback)
    feed.setReplayContext({ ...initial, currentTime: 15 * minute })
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    expect(callback).toHaveBeenCalledOnce()
    expect(callback.mock.calls[0]).toEqual([expect.objectContaining({ timestamp: 10 * minute })])
  })

  it('rejects an already-cancelled navigation before selection, warnings or cache work', async () => {
    const { feed, service, base } = fixture()
    const selection = vi.fn(), warning = vi.fn()
    feed.setSelectionListener(selection)
    feed.setWarningListener(warning)
    feed.setReplayContext(context)
    const controller = new AbortController()
    controller.abort()
    await expect(feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1h'), 0, 60 * minute, true, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(selection).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
    expect(service.loadCachedCandles).not.toHaveBeenCalled()
    expect(service.loadReplayCandles).not.toHaveBeenCalled()
    expect(base.getHistoryKLineData).not.toHaveBeenCalled()
  })

  it('stops a retired cached navigation before it starts archive gap filling', async () => {
    const { feed, service } = fixture([])
    const warning = vi.fn()
    feed.setWarningListener(warning)
    feed.setReplayContext(context)
    const controller = new AbortController()
    let resolve!: (rows: MarketCandle[]) => void
    vi.mocked(service.loadCachedCandles).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1h'), 0, 60 * minute, true, controller.signal)
    controller.abort()
    resolve([])
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.loadReplayCandles).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
  })

  it('passes navigation cancellation to archive work and suppresses its late warning and recursive reads', async () => {
    const { feed, service } = fixture([])
    const warning = vi.fn()
    feed.setWarningListener(warning)
    feed.setReplayContext(context)
    const controller = new AbortController()
    let finish!: () => void
    vi.mocked(service.loadReplayCandles).mockImplementationOnce(async (_kind, _symbol, _timeframe, _from, _to, options) => {
      await new Promise<void>((resolve) => { finish = resolve })
      options?.onWarning?.('retired archive warning')
      return []
    })
    const pending = feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1h'), 0, 60 * minute, true, controller.signal)
    await vi.waitFor(() => expect(service.loadReplayCandles).toHaveBeenCalledOnce())
    const reads = vi.mocked(service.loadCachedCandles).mock.calls.length
    controller.abort()
    finish()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.loadReplayCandles).toHaveBeenCalledWith('trade', 'BTCUSDT', '1m', 0, 2 * minute - 1, expect.objectContaining({ signal: controller.signal }))
    expect(service.loadCachedCandles).toHaveBeenCalledTimes(reads)
    expect(warning).not.toHaveBeenCalled()
  })

  it.each([true, false])('forwards a live history navigation signal while notifySelection is %s', async (notifySelection) => {
    const { feed, base } = fixture()
    vi.mocked(base.getHistoryKLineData).mockResolvedValue([])
    const selection = vi.fn()
    feed.setSelectionListener(selection)
    const controller = new AbortController()
    await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1m'), 0, minute, notifySelection, controller.signal)
    expect(base.getHistoryKLineData).toHaveBeenCalledWith(DEFAULT_SYMBOL, period('1m'), 0, minute, notifySelection, controller.signal)
    expect(selection).toHaveBeenCalledTimes(notifySelection ? 1 : 0)
  })

  it('does not restart a cancelled live request after replay becomes active', async () => {
    const { feed, base, service } = fixture()
    const controller = new AbortController()
    let resolve!: (rows: []) => void
    vi.mocked(base.getHistoryKLineData).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1m'), 0, 30 * minute, true, controller.signal)
    feed.setReplayContext(context)
    controller.abort()
    resolve([])
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.loadCachedCandles).not.toHaveBeenCalled()
    expect(base.getHistoryKLineData).toHaveBeenCalledOnce()
  })

  it('reuses revealed canonical minutes across hour, day, week, month and minute navigation', async () => {
    const start = Date.UTC(2025, 8, 1), shorter = Date.UTC(2025, 8, 10)
    const currentTime = Date.UTC(2025, 8, 15, 4, 15), boundary = currentTime + 15 * minute
    const { feed, service } = fixture([
      ...Array.from({ length: (boundary - start) / minute + 10 }, (_, index) => candle(start + index * minute)),
      candle(start, '1w'), candle(Date.UTC(2025, 8, 8), '1w'),
    ])
    Object.assign(service, { usesMinuteHistory: () => true })
    feed.setReplayContext({ ...context, timeframe: '15m', currentTime })
    await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1h'), shorter, boundary)
    await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1d'), start, boundary)
    await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1w'), start, boundary)
    const month = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1M'), start, boundary)
    const minutes = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1m'), currentTime, boundary)
    expect(month.at(-1)).toMatchObject({ timestamp: start, volume: 40_860, high: 12 })
    expect(minutes).toHaveLength(15)
    expect(vi.mocked(service.loadCachedCandles).mock.calls.filter(call => call[2] === '1m').map(call => call.slice(2))).toEqual([
      ['1m', shorter, boundary - minute], ['1m', start, shorter - minute],
    ])
    expect(service.loadReplayCandles).not.toHaveBeenCalled()
  })

  it('reads only newly revealed minute tails during canonical replay advancement', async () => {
    const { feed, service } = fixture()
    Object.assign(service, { usesMinuteHistory: () => true })
    feed.setReplayContext(context)
    await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 0, 10 * minute)
    feed.setReplayContext({ ...context, currentTime: 2 * minute })
    const result = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 0, 10 * minute)
    expect(result).toEqual([expect.objectContaining({ timestamp: 0, volume: 6 })])
    expect(vi.mocked(service.loadCachedCandles).mock.calls.map((call) => call.slice(2))).toEqual([
      ['1m', 0, minute], ['1m', 2 * minute, 2 * minute],
    ])
  })

  it.each(['rewind', 'session change'])('clears canonical minute reuse after a %s', async (restart) => {
    const { feed, service } = fixture()
    Object.assign(service, { usesMinuteHistory: () => true })
    feed.setReplayContext(context)
    await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 0, 10 * minute)
    await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('15m'), 0, 10 * minute)
    expect(service.loadCachedCandles).toHaveBeenCalledOnce()
    feed.setReplayContext(restart === 'rewind' ? { ...context, currentTime: 0 } : { ...context, sessionId: 'two' })
    await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 0, 10 * minute)
    expect(service.loadCachedCandles).toHaveBeenCalledTimes(2)
    expect(vi.mocked(service.loadCachedCandles).mock.calls[1]!.slice(2)).toEqual(['1m', 0, restart === 'rewind' ? 0 : minute])
  })

  it('does not let cancelled canonical reads populate the reusable minute pool', async () => {
    const { feed, service } = fixture()
    Object.assign(service, { usesMinuteHistory: () => true })
    feed.setReplayContext(context)
    const controller = new AbortController()
    let resolve!: (rows: MarketCandle[]) => void
    vi.mocked(service.loadCachedCandles).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 0, 10 * minute, true, controller.signal)
    controller.abort()
    resolve([candle(0), { ...candle(minute), high: '999', close: '999' }])
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const result = await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('5m'), 0, 10 * minute)
    expect(result).toEqual([expect.objectContaining({ high: 12, close: 11, volume: 4 })])
    await feed.getHistoryKLineData(DEFAULT_SYMBOL, period('1h'), 0, 10 * minute)
    expect(service.loadCachedCandles).toHaveBeenCalledTimes(2)
  })
})
