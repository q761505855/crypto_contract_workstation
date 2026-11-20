import type { Datafeed, Period, SymbolInfo } from '@klinecharts/pro'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MarketCandle } from '../market-data/models'
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

function candle(openTime: number, period: Period, close = '1.10'): MarketCandle {
  return {
    source: 'ctrader', symbol: symbol.ticker, timeframe: period.text, openTime,
    closeTime: openTime + (period === h1 ? hour : minute) - 1,
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

  it('keeps a high-period candle sealed until its native close', async () => {
    const base = { searchSymbols: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() } as unknown as Datafeed
    const market = service([fridayBar, mondayFirst, mondayHour])
    const feed = new CTraderReplayDatafeed(base, market)
    const context = { sessionId: 'demo', symbol: symbol.ticker, timeframe: '1h', currentTime: monday, visibleUntil: monday + minute }
    feed.setReplayContext(context)
    const result = await feed.getHistoryKLineData(symbol, h1, friday, monday + hour)
    expect(result.map(row => row.timestamp)).toEqual([friday])
    const callback = vi.fn()
    feed.subscribe(symbol, h1, callback)
    feed.setReplayContext({ ...context, visibleUntil: monday + hour })
    await waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ timestamp: monday, close: 1.109, volume: 7 }))
    expect(base.subscribe).not.toHaveBeenCalled()
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
    expect(result.current.session).toMatchObject({ status: 'completed', currentTime: monday + minute })
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
