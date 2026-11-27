import type { Datafeed, Period, SymbolInfo } from '@klinecharts/pro'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { nextOpenTime } from '../market-data/intervals'
import type { MarketCandle } from '../market-data/models'
import type { CTraderTradingTerms } from '../simulation/ctrader-trading'
import { toChartCandle } from '../market-data/chart-candle'
import { CTraderReplayDatafeed } from './ctrader-replay-datafeed'
import type { ReplaySession } from './models'
import { useCTraderReplayController } from './useCTraderReplayController'

const minute = 60_000
const hour = 60 * minute
const friday = Date.UTC(2026, 0, 9, 21)
const monday = Date.UTC(2026, 0, 12, 0)
const symbol = { exchange: 'CTRADER', ticker: 'EURUSD' } as SymbolInfo
const h1: Period = { text: '1h', multiplier: 1, timespan: 'hour' }
const m1: Period = { text: '1m', multiplier: 1, timespan: 'minute' }
const m15: Period = { text: '15m', multiplier: 15, timespan: 'minute' }

function candle(openTime: number, period: Period, close = '1.10'): MarketCandle {
  return {
    source: 'ctrader', symbol: symbol.ticker, timeframe: period.text, openTime,
    closeTime: nextOpenTime(openTime, period.text) - 1,
    isClosed: true, open: '1.10', high: '1.11', low: '1.09', close,
    volume: '', quoteVolume: '', tradeCount: 0, tickVolume: 7,
  }
}

const fridayBar = candle(friday, h1)
const mondayFirst = candle(monday, m1, '1.102')
const mondaySecond = candle(monday + minute, m1, '1.103')
const mondayHour = candle(monday, h1, '1.109')

function service(rows: MarketCandle[]) {
  return {
    getReplayTradingTerms: vi.fn(async (): Promise<CTraderTradingTerms> => ({
      accountCurrency: 'USD', quoteCurrency: 'USD', quoteToUsd: '1', usdToAccount: '1',
      lotSize: '100000', minQuantity: '1000', quantityStep: '1000', maxQuantity: '1000000',
      accountLeverage: 500, leverageTiers: [], marginMode: 'max', stopOutRate: '0.5',
      stopOutMode: 'smart', stopOutOrder: 'margin', canShort: true, tradingMode: 0, pnlConversionFeeRate: '0',
      commission: { type: 1, rate: '30', minimumUsd: '0', minimumQuote: '0' },
    })),
    loadCandles: vi.fn(async (_kind: 'trade', _symbol: string, timeframe: string, from: number, to: number) =>
      rows.filter(row => row.timeframe === timeframe && row.openTime >= from && row.openTime <= to)),
  }
}

function stores(saved?: ReplaySession) {
  let stored = saved
  return {
    list: vi.fn(async () => stored === undefined ? [] : [stored]),
    get: vi.fn(async () => stored),
    getLatestActive: vi.fn(async () => stored?.active ? stored : undefined),
    put: vi.fn(async (session: ReplaySession) => { stored = session }),
    update: vi.fn(async (session: ReplaySession) => { stored = session }),
    delete: vi.fn(async () => { stored = undefined }),
  }
}

describe('cTrader replay', () => {
  it('uses real trade gaps, pauses the replay clock and processes every same-time trade', async () => {
    const at = monday + minute
    const cmeSymbol = { ticker: 'UNLISTED.FUT', exchange: 'CME', type: 'FUTURES' }
    const trades = [
      { timestamp: at + 50, price: '100', size: 2 },
      { timestamp: at + 50, price: '101', size: 3 },
      { timestamp: at + 250, price: '99', size: 4 },
    ]
    const market = {
      ...service([{ ...mondayFirst, symbol: cmeSymbol.ticker, source: 'databento-cme' }]),
      source: 'databento-cme' as const,
      loadTicks: vi.fn(async () => trades),
    }
    const replaySessions = stores()
    const { result, unmount } = renderHook(() => useCTraderReplayController({ service: market, replaySessions }, '1m'))
    await waitFor(() => expect(result.current.busy).toBe(false))
    await act(() => result.current.createSession({
      symbol: cmeSymbol,
      period: m1, startTime: monday, endTime: at + 1000, cmeFeePerContractSide: '0.75',
    }))
    expect(result.current.session?.tradingConfig.cmeFeePerContractSide).toBe('0.75')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    try {
      const prices: string[] = []
      result.current.subscribeCandle(event => { if (event.type === 'advance') prices.push(event.candle.close) })
      act(() => result.current.setMode('tick'))
      expect(await replaySessions.get()).toMatchObject({ currentIndex: 0 })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      act(() => result.current.play())
      await act(async () => { await vi.advanceTimersByTimeAsync(49) })
      expect(prices).toEqual([])
      await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      expect(prices).toEqual(['100', '101'])
      act(() => result.current.pause())
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(prices).toEqual(['100', '101'])
      act(() => result.current.setTickSpeed(10))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      act(() => result.current.play())
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(prices).toEqual(['100', '101', '99'])
      expect(await replaySessions.get()).toMatchObject({ playbackMode: 'tick', tickSpeed: 10, currentIndex: 3 })
    } finally {
      unmount()
      vi.useRealTimers()
    }
  })

  it('settles the last tick before ending a session with an in-flight history window', async () => {
    const at = monday + minute
    const market = {
      ...service([{ ...mondayFirst, source: 'databento-cme' }]),
      source: 'databento-cme' as const,
      tickWindowMs: minute,
      loadTicks: vi.fn(async (_symbol: string, from: number) => from === at
        ? [{ timestamp: at + 1, price: '100', size: 2 }]
        : new Promise<never>(() => {})),
    }
    const replaySessions = stores()
    const { result, unmount } = renderHook(() => useCTraderReplayController({ service: market, replaySessions }, '1m'))
    await waitFor(() => expect(result.current.busy).toBe(false))
    await act(() => result.current.createSession({ symbol, period: m1, startTime: monday, endTime: at + 2 * minute, playbackMode: 'tick' }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    try {
      let processed = 0
      let stored = 0
      result.current.subscribeCandle(event => {
        if (event.type === 'advance') processed++
        if (event.type === 'flush') stored = processed
      })
      act(() => result.current.play())
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(market.loadTicks).toHaveBeenCalledTimes(2)
      expect(processed).toBe(1)
      await act(() => result.current.endSession())
      expect(stored).toBe(1)
      expect(await replaySessions.get()).toMatchObject({ active: false, currentIndex: 1, currentTime: at + 1 })
    } finally {
      unmount()
      vi.useRealTimers()
    }
  })

  it('steps each same-millisecond quote, restores its ordinal and builds a 5s step from bid quotes', async () => {
    const at = monday + hour
    const quotes = [
      { timestamp: at + 100, price: '1.10100' },
      { timestamp: at + 100, price: '1.10200' },
      { timestamp: at + 200, price: '1.10300' },
      { timestamp: at + 5100, price: '1.10500' },
      { timestamp: at + 5400, price: '1.10400' },
      { timestamp: at + 5 * minute + 1, price: '1.10600' },
    ]
    const market = { ...service([mondayHour]), loadTicks: vi.fn(async (_symbol: string, from: number, to: number) =>
      quotes.filter(quote => quote.timestamp >= from && quote.timestamp <= to)) }
    const runtime = { service: market, replaySessions: stores() }
    const first = renderHook(() => useCTraderReplayController(runtime, 'tick'))
    await waitFor(() => expect(first.result.current.busy).toBe(false))
    await act(() => first.result.current.createSession({ symbol, period: h1, startTime: monday, endTime: at + 6 * minute }))
    await act(() => first.result.current.next())
    expect(first.result.current.getCurrentCandle()?.close).toBe('1.10100')
    await act(() => first.result.current.next())
    expect(first.result.current.session).toMatchObject({ cursorTimeframe: 'tick', cursorTickIndex: 1, currentTime: at + 100 })
    expect(first.result.current.getCurrentCandle()?.close).toBe('1.10200')
    await act(() => first.result.current.previous())
    await act(() => first.result.current.next())
    expect(market.loadTicks).toHaveBeenCalledTimes(1)
    first.unmount()
    const restored = renderHook(() => useCTraderReplayController(runtime, 'tick'))
    await waitFor(() => expect(restored.result.current.getCurrentCandle()?.close).toBe('1.10200'))
    await act(() => restored.result.current.previous())
    expect(restored.result.current.getCurrentCandle()?.close).toBe('1.10100')
    await act(() => restored.result.current.next('5s'))
    expect(restored.result.current.getCurrentCandle()).toMatchObject({
      timeframe: '5s', openTime: at + 5000, closeTime: at + 9999,
      open: '1.10500', high: '1.10500', low: '1.10400', close: '1.10400', tickVolume: 2,
    })
    expect(restored.result.current.session?.cursorTickIndex).toBeUndefined()
    await act(() => restored.result.current.next('tick'))
    expect(restored.result.current.getCurrentCandle()?.openTime).toBe(at + 5 * minute + 1)
    expect(market.loadTicks).toHaveBeenCalledTimes(2)
  })

  it('skips the weekend and sends only the selected native candle to simulation', async () => {
    const market = service([fridayBar, mondayFirst, mondaySecond, mondayHour])
    const replaySessions = stores()
    const runtime = { service: market, replaySessions }
    const { result } = renderHook(() => useCTraderReplayController(runtime, '1m'))
    await waitFor(() => expect(result.current.busy).toBe(false))
    await act(() => result.current.createSession({ symbol, period: h1, startTime: friday, endTime: monday + hour }))
    expect(result.current.session).toMatchObject({ marketSource: 'ctrader', currentTime: friday })
    const advance = vi.fn()
    const unsubscribe = result.current.subscribeCandle(advance)
    await act(() => result.current.next())
    expect(advance).toHaveBeenCalledExactlyOnceWith({ type: 'advance', candle: mondayFirst })
    expect(result.current.session).toMatchObject({
      period: h1, currentTime: monday, visibleUntil: monday + minute, cursorTimeframe: '1m',
    })
    await act(() => result.current.previous())
    expect(result.current.session).toMatchObject({ currentTime: friday, visibleUntil: friday + hour })
    expect(advance).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('restores the selected native candle and retains a readable legacy archive', async () => {
    const replaySessions = stores()
    const market = service([fridayBar, mondayFirst])
    const runtime = { service: market, replaySessions }
    const first = renderHook(() => useCTraderReplayController(runtime, '1m'))
    await waitFor(() => expect(first.result.current.busy).toBe(false))
    await act(() => first.result.current.createSession({ symbol, period: h1, startTime: friday, endTime: monday + hour }))
    await act(() => first.result.current.next())
    const latest = first.result.current.session!
    first.unmount()
    const second = renderHook(() => useCTraderReplayController(runtime, '1h'))
    await waitFor(() => expect(second.result.current.busy).toBe(false))
    expect(second.result.current.getCurrentCandle()).toEqual(mondayFirst)
    expect(second.result.current.session).toMatchObject({ currentTime: latest.currentTime, visibleUntil: latest.visibleUntil })
    second.unmount()

    const legacyStore = stores({ ...latest, marketSource: undefined, cursorTimeframe: undefined, visibleUntil: undefined })
    market.loadCandles.mockClear()
    const legacyRuntime = { service: market, replaySessions: legacyStore }
    const legacy = renderHook(() => useCTraderReplayController(legacyRuntime))
    await waitFor(() => expect(legacy.result.current.busy).toBe(false))
    expect(legacy.result.current.sessions).toHaveLength(1)
    await act(() => legacy.result.current.loadSession(latest.id))
    expect(legacy.result.current.session).toBeNull()
    expect(legacy.result.current.error).toMatch(/币安/)
    expect(market.loadCandles).not.toHaveBeenCalled()
  })

  it('updates a 15m replay candle with revealed minutes and replaces it at the native close', async () => {
    const base = { searchSymbols: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() } as unknown as Datafeed
    const previous = candle(monday - 15 * minute, m15)
    const official = { ...candle(monday, m15, '1.15'), high: '1.20', tickVolume: 99 }
    const second = { ...mondaySecond, high: '1.12', low: '1.08', tickVolume: 4 }
    const future = { ...candle(monday + 2 * minute, m1, '1.13'), high: '1.15', low: '1.03' }
    const market = service([previous, official, mondayFirst, second, future])
    const feed = new CTraderReplayDatafeed(base, market)
    const context = { sessionId: 'demo', symbol: symbol.ticker, timeframe: '15m', currentTime: previous.openTime,
      visibleUntil: monday, endTime: monday + 30 * minute - 1 }
    feed.setReplayContext(context)
    const history = () => feed.getHistoryKLineData(symbol, m15, previous.openTime, context.endTime)
    expect(await history()).toEqual([toChartCandle(previous)])
    const callback = vi.fn()
    feed.subscribe(symbol, m15, callback)

    feed.setReplayContext({ ...context, visibleUntil: monday + minute })
    await waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
    expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({
      timestamp: monday, open: 1.10, high: 1.11, low: 1.09, close: 1.102, volume: 7, ctraderClosed: false,
    }))

    feed.setReplayContext({ ...context, visibleUntil: monday + 2 * minute })
    await waitFor(() => expect(callback).toHaveBeenCalledTimes(2))
    const partial = expect.objectContaining({
      timestamp: monday, open: 1.10, high: 1.12, low: 1.08, close: 1.103, volume: 11, ctraderClosed: false,
    })
    expect(callback).toHaveBeenLastCalledWith(partial)
    expect(await history()).toEqual([toChartCandle(previous), partial])

    feed.setReplayContext({ ...context, visibleUntil: monday + 15 * minute })
    await waitFor(() => expect(callback).toHaveBeenCalledTimes(3))
    expect(callback).toHaveBeenLastCalledWith(toChartCandle(official))
    expect(await history()).toEqual([toChartCandle(previous), toChartCandle(official)])
    expect(base.subscribe).not.toHaveBeenCalled()
  })

  it.each([
    { text: '1d', multiplier: 1, timespan: 'day' },
    { text: '1w', multiplier: 1, timespan: 'week' },
    { text: '1M', multiplier: 1, timespan: 'month' },
  ] satisfies Period[])('builds a $text forming candle from complete hours and only the elapsed tail', async period => {
    const start = Date.UTC(2026, 5, 1)
    const tail = start + 4 * hour
    const closedHour = candle(start, h1, '1.105')
    const offsetHour = { ...candle(tail - 30 * minute, h1), high: '1.80' }
    const revealedMinute = { ...candle(tail, m1, '1.107'), low: '1.085' }
    const futureMinute = { ...candle(tail + minute, m1), high: '1.90' }
    const futurePeriod = { ...candle(start, period), high: '1.95' }
    const feed = new CTraderReplayDatafeed({} as Datafeed, service([closedHour, offsetHour, revealedMinute, futureMinute, futurePeriod]))
    feed.setReplayContext({ sessionId: 'calendar', symbol: symbol.ticker, timeframe: '1m', currentTime: tail,
      visibleUntil: tail + minute })
    const rows = await feed.getHistoryKLineData(symbol, period, start, tail + minute)
    expect(rows).toEqual([expect.objectContaining({
      timestamp: start, open: 1.10, high: 1.11, low: 1.085, close: 1.107, volume: 14, ctraderClosed: false,
    })])
  })

  it('keeps closed history visible if the forming candle cannot be loaded', async () => {
    const previous = candle(monday - 15 * minute, m15)
    const market = service([previous, mondayFirst, mondaySecond])
    const load = market.loadCandles.getMockImplementation()!
    let failed = true
    market.loadCandles.mockImplementation(async (...args) => {
      if (failed && args[2] === '1m') throw new Error('minute history unavailable')
      return load(...args)
    })
    const feed = new CTraderReplayDatafeed({} as Datafeed, market)
    const position = { sessionId: 'retry', symbol: symbol.ticker, timeframe: '15m', currentTime: monday,
      visibleUntil: monday + minute }
    feed.setReplayContext(position)
    expect(await feed.getHistoryKLineData(symbol, m15, previous.openTime, monday + 2 * minute)).toEqual([toChartCandle(previous)])

    const update = vi.fn()
    feed.subscribe(symbol, m15, update)
    failed = false
    feed.setReplayContext({ ...position, visibleUntil: monday + 2 * minute })
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      timestamp: monday, close: 1.103, volume: 14, ctraderClosed: false,
    })))
  })

  it('does not return older replay history over an update that arrived during a reload', async () => {
    const previous = candle(monday - 15 * minute, m15)
    const market = service([previous, mondayFirst])
    const feed = new CTraderReplayDatafeed({} as Datafeed, market)
    const position = { sessionId: 'loading', symbol: symbol.ticker, timeframe: '15m', currentTime: previous.openTime,
      visibleUntil: monday }
    feed.setReplayContext(position)
    const update = vi.fn()
    feed.subscribe(symbol, m15, update)
    let finish!: (rows: MarketCandle[]) => void
    market.loadCandles.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const history = feed.getHistoryKLineData(symbol, m15, previous.openTime, monday + 15 * minute)

    feed.setReplayContext({ ...position, currentTime: monday, visibleUntil: monday + minute })
    const forming = expect.objectContaining({ timestamp: monday, close: 1.102, ctraderClosed: false })
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(forming))
    finish([previous])
    await expect(history).resolves.toEqual([toChartCandle(previous), forming])
  })

  it('does not reveal a native minute or later same-time quotes on its last millisecond', async () => {
    const end = monday + minute - 1
    const official = { ...mondayFirst, close: '1.108', tickVolume: 3 }
    const quotes = [
      { timestamp: end - 1, price: '1.10' }, { timestamp: end, price: '1.104' },
      { timestamp: end, price: '1.108' }, { timestamp: end + 1, price: '1.12' },
    ]
    const market = { ...service([official, mondaySecond]), loadTicks: vi.fn(async () => quotes) }
    const feed = new CTraderReplayDatafeed({} as Datafeed, market)
    const position = { sessionId: 'last-quote', symbol: symbol.ticker, timeframe: '1m', currentTime: end,
      visibleUntil: end + 1, cursorTickIndex: 0 }
    feed.setReplayContext(position)
    const read = () => feed.getHistoryKLineData(symbol, m1, monday, monday + 2 * minute)
    expect(await read()).toEqual([expect.objectContaining({ timestamp: monday, close: 1.104, volume: 2, ctraderClosed: false })])
    const update = vi.fn()
    feed.subscribe(symbol, m1, update)

    feed.setReplayContext({ ...position, cursorTickIndex: 1 })
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      timestamp: monday, close: 1.108, volume: 3, ctraderClosed: false,
    })))
    feed.setReplayContext({ ...position, currentTime: end + 1, visibleUntil: end + 2 })
    await waitFor(() => expect(update.mock.calls.slice(1)).toEqual([[toChartCandle(official)], [expect.objectContaining({
      timestamp: end + 1, close: 1.12, volume: 1, ctraderClosed: false,
    })]]))
  })

  it('emits successive replay bars from a bounded page while keeping future bars hidden', async () => {
    const rows = Array.from({ length: 135 }, (_, index) => candle(monday + index * minute, m1))
    const market = service(rows)
    const feed = new CTraderReplayDatafeed({} as Datafeed, market)
    const context = { sessionId: 'buffered', symbol: symbol.ticker, timeframe: '1m', currentTime: monday,
      visibleUntil: monday + minute, endTime: monday + 300 * minute }
    feed.setReplayContext(context)
    expect((await feed.getHistoryKLineData(symbol, m1, monday, context.endTime)).map(row => row.timestamp)).toEqual([monday])
    const update = vi.fn()
    feed.subscribe(symbol, m1, update)
    for (let index = 1; index <= 6; index++) {
      feed.setReplayContext({ ...context, visibleUntil: monday + (index + 1) * minute })
      await waitFor(() => expect(update).toHaveBeenCalledTimes(index))
      expect(update.mock.calls.at(-1)?.[0].timestamp).toBe(monday + index * minute)
    }
    feed.setReplayContext({ ...context, visibleUntil: monday + 131 * minute })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(130))
    expect(update.mock.calls.at(-1)?.[0].timestamp).toBe(monday + 130 * minute)
    expect(market.loadCandles).toHaveBeenCalledTimes(2)
    const [, , , from, to] = market.loadCandles.mock.calls[1]
    expect(to - from).toBeGreaterThan(128 * minute)
    expect(to - from).toBeLessThanOrEqual(256 * minute)
  })

  it('discards a newer history page if a replay starts while the page is loading', async () => {
    const page = { candles: [toChartCandle(mondayHour)], hasMore: true }
    let finish!: (value: typeof page) => void
    const getNewerHistory = vi.fn(() => new Promise<typeof page>(resolve => { finish = resolve }))
    const base = { getNewerHistory } as unknown as Datafeed & { getNewerHistory: typeof getNewerHistory }
    const feed = new CTraderReplayDatafeed(base, service([]))
    const pending = feed.getNewerHistory(symbol, h1, friday)

    feed.setReplayContext({ sessionId: 'demo', symbol: symbol.ticker, timeframe: '1h', currentTime: friday,
      visibleUntil: friday + hour })
    finish(page)
    await expect(pending).resolves.toBeNull()
    await expect(feed.getNewerHistory(symbol, h1, friday)).resolves.toBeNull()
    expect(getNewerHistory).toHaveBeenCalledTimes(1)
  })

  it('bounds the chart library’s latest-history request to a recent native window', async () => {
    const market = service([fridayBar, mondayHour])
    const feed = new CTraderReplayDatafeed({} as Datafeed, market)
    feed.setReplayContext({ sessionId: 'demo', symbol: symbol.ticker, timeframe: '1h', currentTime: monday,
      visibleUntil: monday + hour })
    await feed.getHistoryKLineData(symbol, h1, Number.MIN_SAFE_INTEGER, monday + 2 * hour)
    expect(market.loadCandles.mock.calls[0][3]).toBeGreaterThan(monday - 501 * hour)
  })

  it('never repeats an overlapping native candle after changing the step period', async () => {
    const followingHour = candle(monday + hour, h1, '1.112')
    const market = service([fridayBar, mondayFirst, mondaySecond, mondayHour, followingHour])
    const runtime = { service: market, replaySessions: stores() }
    const { result } = renderHook(() => useCTraderReplayController(runtime, '1m'))
    await waitFor(() => expect(result.current.busy).toBe(false))
    await act(() => result.current.createSession({ symbol, period: h1, startTime: friday, endTime: monday + 2 * hour }))
    await act(() => result.current.next())
    const advance = vi.fn()
    const unsubscribe = result.current.subscribeCandle(advance)
    await act(() => result.current.next('1h'))
    expect(advance).toHaveBeenCalledExactlyOnceWith({ type: 'advance', candle: followingHour })
    expect(result.current.session).toMatchObject({ cursorTimeframe: '1h', visibleUntil: monday + 2 * hour })
    unsubscribe()
  })

  it('allows a finer step after a wider period runs out before the replay ends', async () => {
    const market = service([mondayFirst, mondaySecond, mondayHour])
    const runtime = { service: market, replaySessions: stores() }
    const { result } = renderHook(() => useCTraderReplayController(runtime, '1m'))
    await waitFor(() => expect(result.current.busy).toBe(false))
    await act(() => result.current.createSession({ symbol, period: m1, startTime: monday, endTime: monday + 2 * minute - 1 }))
    await act(() => result.current.next('1h'))
    expect(result.current.session).toMatchObject({ status: 'paused', currentTime: monday })
    await act(() => result.current.next('1m'))
    expect(result.current.session).toBeNull()
    const finished = result.current.sessions[0]
    expect(finished).toMatchObject({ status: 'completed', active: false, currentTime: monday + minute })
    await expect(runtime.replaySessions.list()).resolves.toEqual([finished])
    await act(() => result.current.loadSession(finished.id))
    expect(result.current.session).toEqual(expect.objectContaining({ status: 'completed', active: false }))
  })

  it('drops a chart response that finishes after the replay period is switched', async () => {
    const base = { searchSymbols: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() } as unknown as Datafeed
    const market = service([mondayFirst, mondaySecond, mondayHour])
    const feed = new CTraderReplayDatafeed(base, market)
    const firstContext = { sessionId: 'demo', symbol: symbol.ticker, timeframe: '1m', currentTime: monday, visibleUntil: monday + minute }
    feed.setReplayContext(firstContext)
    await feed.getHistoryKLineData(symbol, m1, monday, monday + hour)
    const oldStep = vi.fn(), nextStep = vi.fn()
    feed.subscribe(symbol, m1, oldStep)
    let completeRequest!: (bars: MarketCandle[]) => void
    market.loadCandles.mockImplementationOnce(() => new Promise(resolve => { completeRequest = resolve }))
    feed.setReplayContext({ ...firstContext, visibleUntil: monday + 2 * minute })
    expect(completeRequest).toBeTypeOf('function')
    await feed.getHistoryKLineData(symbol, h1, monday, monday + hour)
    feed.subscribe(symbol, h1, nextStep)
    completeRequest([mondaySecond])
    await Promise.resolve()
    await Promise.resolve()
    expect(oldStep).not.toHaveBeenCalled()
    expect(nextStep).not.toHaveBeenCalled()
  })

  it('forwards a base datafeed connection warning for an active chart history request', async () => {
    let listener: ((message: string) => void) | undefined
    const base = {
      setWarningListener(next?: (message: string) => void) { listener = next },
      async getHistoryKLineData(
        _symbol: SymbolInfo, _period: Period, _from: number, _to: number, notifySelection = true,
      ) {
        if (notifySelection) listener?.('cTrader 尚未配置')
        return []
      },
    } as unknown as Datafeed
    const feed = new CTraderReplayDatafeed(base, service([]))
    const warning = vi.fn()
    feed.setWarningListener(warning)
    await feed.getHistoryKLineData(symbol, m1, friday, monday)
    expect(warning).toHaveBeenCalledWith('cTrader 尚未配置')
  })
})
