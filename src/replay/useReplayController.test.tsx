import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import type { MarketDataRuntime } from '../market-data/runtime'
import type { MarketCandle } from '../market-data/models'
import { useSimulationController } from '../simulation/useSimulationController'
import { SimulationEngine } from '../simulation/simulation-engine'
import { ReplayEngine } from './replay-engine'
import { useReplayController } from './useReplayController'
import type { ReplaySession } from './models'
import { nextOpenTime } from '../market-data/intervals'

const minute = 60_000
const input = { symbol: DEFAULT_SYMBOL, period: SUPPORTED_PERIODS[0], startTime: 0, endTime: 5 * minute }
const candles: MarketCandle[] = Array.from({ length: 6 }, (_, index) => ({
  symbol: 'BTCUSDT', timeframe: '1m', openTime: index * minute,
  closeTime: (index + 1) * minute - 1, open: '100', high: '101', low: '99', close: '100',
  volume: '10', quoteVolume: '1000', tradeCount: 1, isClosed: true, source: 'binance',
}))

function sourceRows(timeframe: string, from: number, to: number): MarketCandle[] {
  const rows: MarketCandle[] = []
  for (let time = from; time <= to; time = nextOpenTime(time, timeframe)) {
    rows.push({ ...candles[0], timeframe, openTime: time, closeTime: nextOpenTime(time, timeframe) - 1 })
  }
  return rows
}

const dailyInput = { symbol: DEFAULT_SYMBOL, period: SUPPORTED_PERIODS.find(p => p.text === '1d')!, startTime: Date.UTC(2026, 0, 31), endTime: Date.UTC(2026, 3, 2) }

function setup(options: { noMarks?: boolean; restore?: boolean; sourceCandles?: MarketCandle[]; savedSession?: ReplaySession } = {}) {
  const source = options.sourceCandles ?? candles
  const saved = options.savedSession ?? (options.restore ? ReplayEngine.create(input, source).snapshot() : undefined)
  const marks = options.noMarks ? [] : candles
  const runtime = {
    replaySessions: {
      list: vi.fn(async () => saved === undefined ? [] : [saved]),
      getLatestActive: vi.fn(async () => saved),
      get: vi.fn(async () => saved), put: vi.fn(async () => undefined),
    },
    simulationStates: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
    replayDatafeed: { setSessionCandles: vi.fn() },
    service: {
      loadCandles: vi.fn(async (kind: string) => kind === 'mark' ? marks : source),
      loadCachedCandles: vi.fn(async (kind: string) => kind === 'mark' ? marks : source),
      loadReplayCandles: vi.fn(async (kind: string) => kind === 'mark' ? marks : source),
      resetReplayRequests: vi.fn(),
    },
  } as unknown as MarketDataRuntime
  const hook = renderHook(() => {
    const replay = useReplayController(runtime)
    const simulation = useSimulationController(runtime, replay)
    return { replay, simulation }
  })
  return { ...hook, runtime, saved }
}

describe('offline replay and simulation controllers', () => {
  it.each([undefined, Date.UTC(2026, 7, 1)])('prepares January and February only while preserving the session end %s', async (endTime) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 6))
    try {
      const { result, runtime } = setup()
      await waitFor(() => expect(result.current.replay.busy).toBe(false))
      vi.mocked(runtime.service.loadCandles).mockImplementation(async (_kind, _symbol, timeframe, from, to) => {
        // Daily source candles keep this a small real engine/controller test.
        return sourceRows(timeframe, from, to)
      })
      const startTime = Date.UTC(2026, 0, 31)
      await act(async () => { await result.current.replay.createSession({ symbol: DEFAULT_SYMBOL, period: SUPPORTED_PERIODS.find(p => p.text === '1d')!, startTime, endTime }) })
      expect(runtime.service.loadCandles).toHaveBeenCalledWith('trade', 'BTCUSDT', '1d', startTime, Date.UTC(2026, 1, 28), expect.any(Object))
      expect(result.current.replay.session?.endTime).toBe(endTime ?? Date.UTC(2026, 10, 5))
      expect(result.current.replay.session?.status).toBe('paused')
      await act(async () => { await result.current.replay.next() })
      expect(result.current.replay.session?.currentTime).toBe(Date.UTC(2026, 1, 1))
      expect(runtime.service.loadCandles).toHaveBeenLastCalledWith('trade', 'BTCUSDT', '1d', Date.UTC(2026, 2, 1), Date.UTC(2026, 2, 31), expect.any(Object))
      expect(runtime.service.loadCandles).toHaveBeenCalledTimes(2)
    } finally { clock.mockRestore() }
  })

  it.each([
    ['1d', Date.UTC(2023, 11, 31), Date.UTC(2024, 0, 31)],
    ['1d', Date.UTC(2024, 0, 31), Date.UTC(2024, 1, 29)],
    ['1w', Date.UTC(2026, 0, 5), Date.UTC(2026, 1, 16)],
    ['1M', Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1)],
  ])('bounds %s source bars across calendar boundaries', async (timeframe, startTime, lastPrepared) => {
    const { result, runtime } = setup()
    await waitFor(() => expect(result.current.replay.busy).toBe(false))
    vi.mocked(runtime.service.loadCandles).mockImplementation(async (_k, _s, tf, from, to) => sourceRows(tf, from, to))
    await act(async () => { await result.current.replay.createSession({ ...dailyInput, period: SUPPORTED_PERIODS.find(p => p.text === timeframe)!, startTime }) })
    expect(result.current.replay.error).toBe('')
    expect(runtime.service.loadCandles).toHaveBeenCalledWith('trade', 'BTCUSDT', timeframe, startTime, lastPrepared, expect.any(Object))
  })

  it('restores only through next month and retains the saved full end and cursor', async () => {
    const original = ReplayEngine.create(dailyInput, sourceRows('1d', dailyInput.startTime, Date.UTC(2026, 1, 28)), { buffered: true })
    original.stepNext()
    const { result, runtime } = setup({ savedSession: original.snapshot() })
    vi.mocked(runtime.service.loadReplayCandles).mockImplementation(async (_k, _s, tf, from, to) => sourceRows(tf, from, to))
    await waitFor(() => expect(result.current.replay.busy).toBe(false))
    expect(result.current.replay.error).toBe('')
    expect(runtime.service.loadReplayCandles).toHaveBeenCalledWith('trade', 'BTCUSDT', '1d', Date.UTC(2026, 0, 31), Date.UTC(2026, 2, 31), expect.objectContaining({ prefetchTo: Date.UTC(2026, 2, 31) }))
    expect(result.current.replay.session).toMatchObject({ currentTime: Date.UTC(2026, 1, 1), currentIndex: 1, endTime: Date.UTC(2026, 3, 2), candleCount: 62 })
  })

  it('does not advance on an incomplete next month and can retry without duplicate trading events', async () => {
    const { result, runtime } = setup()
    await waitFor(() => expect(result.current.replay.busy).toBe(false))
    vi.mocked(runtime.service.loadCandles).mockImplementation(async (_k, _s, tf, from, to) => sourceRows(tf, from, to))
    await act(async () => { await result.current.replay.createSession(dailyInput) })
    const events: number[] = []
    result.current.replay.subscribeCandle(event => { events.push(event.candle.openTime) })
    vi.mocked(runtime.service.loadCandles).mockResolvedValueOnce([])
    await act(async () => { await result.current.replay.next() })
    expect(result.current.replay.error).toMatch(/缺口/)
    expect(result.current.replay.session?.currentTime).toBe(Date.UTC(2026, 0, 31))
    expect(events).toEqual([])
    await act(async () => { await result.current.replay.next() })
    expect(events).toEqual([Date.UTC(2026, 1, 1)])
    expect(result.current.replay.session?.currentIndex).toBe(1)
  })

  it('processes every intermediate trading candle while loading only one next month per chunk on jump to end', async () => {
    const { result, runtime } = setup()
    await waitFor(() => expect(result.current.replay.busy).toBe(false))
    vi.mocked(runtime.service.loadCandles).mockImplementation(async (_k, _s, tf, from, to) => sourceRows(tf, from, to))
    await act(async () => { await result.current.replay.createSession(dailyInput) })
    const events: number[] = []
    result.current.replay.subscribeCandle(event => { events.push(event.candle.openTime) })
    await act(async () => { await result.current.replay.jumpToEnd() })
    expect(events).toHaveLength(61)
    expect(new Set(events).size).toBe(61)
    expect(events.at(-1)).toBe(Date.UTC(2026, 3, 2))
    expect(result.current.replay.session).toMatchObject({ currentIndex: 61, candleCount: 62, status: 'completed' })
    expect(vi.mocked(runtime.service.loadCandles).mock.calls.map(call => [call[3], call[4]])).toEqual([
      [Date.UTC(2026, 0, 31), Date.UTC(2026, 1, 28)],
      [Date.UTC(2026, 2, 1), Date.UTC(2026, 2, 31)],
      [Date.UTC(2026, 3, 1), Date.UTC(2026, 3, 2)],
    ])
  })

  it('cancels next-month preparation when the user ends the session', async () => {
    const { result, runtime } = setup()
    await waitFor(() => expect(result.current.replay.busy).toBe(false))
    vi.mocked(runtime.service.loadCandles).mockImplementation(async (_k, _s, tf, from, to) => sourceRows(tf, from, to))
    await act(async () => { await result.current.replay.createSession(dailyInput) })
    let release!: (rows: MarketCandle[]) => void
    let signal: AbortSignal | undefined
    vi.mocked(runtime.service.loadCandles).mockImplementationOnce(async (_k, _s, _tf, _from, _to, options) => {
      signal = options?.signal
      return new Promise(resolve => { release = resolve })
    })
    let pending!: Promise<void>
    act(() => { pending = result.current.replay.next() })
    await act(async () => { await result.current.replay.endSession() })
    await act(async () => { release(sourceRows('1d', Date.UTC(2026, 2, 1), Date.UTC(2026, 2, 31))); await pending })
    expect(signal?.aborted).toBe(true)
    expect(result.current.replay.busy).toBe(false)
    expect(result.current.replay.session).toBeNull()
    expect(result.current.replay.error).toBe('')
  })

  it('exposes monthly preparation progress while creating a session', async () => {
    const {result,runtime} = setup()
    await waitFor(()=>expect(result.current.replay.busy).toBe(false))
    let release!: (rows:MarketCandle[])=>void
    vi.mocked(runtime.service.loadCandles).mockImplementation((_kind,_symbol,_timeframe,_from,_to,options) => {
      options?.onStatus?.('BTCUSDT 2026-10：检查云端月归档…')
      return new Promise(resolve=> { release=resolve })
    })
    let pending!:Promise<void>
    act(()=> { pending=result.current.replay.createSession(input) })
    try {
      expect(result.current.replay.preparationStatus).toContain('2026-10')
    } finally {
      await act(async()=> { release(candles); await pending })
    }
    expect(result.current.replay.preparationStatus).toBe('')
  })

  it('prepares only completed source candles when no replay end is supplied', async () => {
    const clock = vi.spyOn(Date,'now').mockReturnValue(5*minute+30_000)
    try {
      const {result,runtime} = setup()
      await waitFor(()=>expect(result.current.replay.busy).toBe(false))
      await act(async()=> { await result.current.replay.createSession({symbol:DEFAULT_SYMBOL,period:SUPPORTED_PERIODS[0],startTime:0}) })
      expect(runtime.service.loadCandles).toHaveBeenCalledWith('trade','BTCUSDT','1m',0,4*minute,expect.any(Object))
      expect(result.current.replay.session?.endTime).toBe(4*minute)
    } finally { clock.mockRestore() }
  })

  it('rejects a missing tail instead of shortening the requested replay range', async () => {
    const { result, runtime } = setup()
    await waitFor(() => expect(result.current.replay.busy).toBe(false))
    vi.mocked(runtime.service.loadCandles).mockResolvedValue(candles.slice(0, 3))
    await act(async () => { await result.current.replay.createSession(input) })
    expect(result.current.replay.session).toBeNull()
    expect(result.current.replay.error).toMatch(/缺口|不完整/)
  })
  it('prepares only ordinary candles and makes no remote calls while trading or stepping', async () => {
    const { result, runtime } = setup()
    await waitFor(() => expect(result.current.replay.busy).toBe(false))
    await act(async () => { await result.current.replay.createSession(input) })
    await waitFor(() => expect(result.current.simulation.busy).toBe(false))
    expect(runtime.service.loadCandles).toHaveBeenCalledOnce()
    expect(runtime.service.loadReplayCandles).not.toHaveBeenCalled()
    vi.mocked(runtime.service.loadCandles).mockClear()
    vi.mocked(runtime.service.loadCachedCandles).mockClear()
    vi.mocked(runtime.service.loadReplayCandles).mockClear()

    await act(async () => { await result.current.simulation.preview('long', { margin: '100' }) })
    await act(async () => { await result.current.simulation.open('long', { margin: '100' }) })
    expect(result.current.simulation.state?.position?.side).toBe('long')
    for (let index = 0; index < 3; index += 1) {
      await act(async () => { await result.current.replay.next() })
    }
    expect(result.current.replay.session?.currentTime).toBe(3 * minute)
    expect(result.current.simulation.state?.warning).toBeNull()
    await act(async () => { await result.current.simulation.closeAll() })
    await act(async () => { await result.current.replay.jumpToEnd() })
    expect(result.current.replay.session?.status).toBe('completed')
    expect(runtime.service.loadCandles).not.toHaveBeenCalled()
    expect(runtime.service.loadCachedCandles).not.toHaveBeenCalled()
    expect(runtime.service.loadReplayCandles).not.toHaveBeenCalled()
  })

  it('continues trading and risk valuation without requesting a second price series', async () => {
    const { result, runtime } = setup({ noMarks: true })
    await waitFor(() => expect(result.current.replay.busy).toBe(false))
    await act(async () => { await result.current.replay.createSession(input) })
    await waitFor(() => expect(result.current.simulation.busy).toBe(false))
    vi.mocked(runtime.service.loadCandles).mockClear()
    await act(async () => { await result.current.simulation.open('long', { margin: '100' }) })
    await act(async () => { await result.current.replay.next() })
    await act(async () => { await result.current.replay.next() })
    expect(result.current.simulation.state?.warning).toBeNull()
    expect(runtime.service.loadReplayCandles).not.toHaveBeenCalled()
    expect(result.current.replay.session?.currentTime).toBe(2 * minute)
    expect(runtime.service.loadCandles).not.toHaveBeenCalled()
  })

  it('restores legacy positions at the current ordinary close without duplicate exits, trades or ledger', async () => {
    const source = candles.map(row => row.openTime === minute ? { ...row, high: '130', low: '1', close: '120' } : row)
    const { result, runtime, saved } = setup({ restore: true, sourceCandles: source })
    saved!.currentIndex = 1
    saved!.currentTime = minute
    saved!.tradingConfig = { ...saved!.tradingConfig, feeRate: '0', slippageRate: '0' }
    const original = SimulationEngine.create(saved!)
    original.open('long', { quantity: '1' }, candles[0])
    const state = original.snapshot()
    Object.assign(state.position!, { markPrice: '40' })
    delete (state.position as unknown as Record<string, unknown>).lastPrice
    state.warning = '缺少当前 K 线的标记价格，已停止强平判断。'
    vi.mocked(runtime.simulationStates.load).mockResolvedValue(state)
    await waitFor(() => expect(result.current.simulation.state?.position?.lastPrice).toBe('120'))
    expect(result.current.simulation.state?.position).not.toHaveProperty('markPrice')
    expect(result.current.simulation.state?.account.equity).toBe('10020')
    expect(result.current.simulation.state?.warning).toBeNull()
    expect(result.current.simulation.state?.trades).toEqual(state.trades)
    expect(result.current.simulation.state?.ledger).toEqual(state.ledger)
    expect(vi.mocked(runtime.service.loadReplayCandles).mock.calls.every(([kind]) => kind === 'trade')).toBe(true)
  })

  it('restores an existing session through shared batch preparation', async () => {
    const { result, runtime } = setup({ restore: true })
    await waitFor(() => expect(result.current.replay.busy).toBe(false))
    await waitFor(() => expect(result.current.simulation.state).not.toBeNull())
    expect(runtime.service.loadCandles).not.toHaveBeenCalled()
    expect(runtime.service.loadReplayCandles).toHaveBeenCalledWith('trade', 'BTCUSDT', '1m', 0, 5 * minute, { prefetchTo: 5 * minute, onStatus:expect.any(Function) })
    expect(runtime.replayDatafeed.setSessionCandles).toHaveBeenCalledWith(expect.any(String), candles)
    await act(async () => { await result.current.replay.next() })
    expect(result.current.replay.session?.currentTime).toBe(minute)
    expect(runtime.service.loadCandles).not.toHaveBeenCalled()
  })
})
