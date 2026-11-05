import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import type { MarketDataRuntime } from '../market-data/runtime'
import type { MarketCandle } from '../market-data/models'
import { useSimulationController } from '../simulation/useSimulationController'
import { SimulationEngine } from '../simulation/simulation-engine'
import { ReplayEngine } from './replay-engine'
import { useReplayController } from './useReplayController'

const minute = 60_000
const input = { symbol: DEFAULT_SYMBOL, period: SUPPORTED_PERIODS[0], startTime: 0, endTime: 5 * minute }
const candles: MarketCandle[] = Array.from({ length: 6 }, (_, index) => ({
  symbol: 'BTCUSDT', timeframe: '1m', openTime: index * minute,
  closeTime: (index + 1) * minute - 1, open: '100', high: '101', low: '99', close: '100',
  volume: '10', quoteVolume: '1000', tradeCount: 1, isClosed: true, source: 'binance',
}))

function setup(options: { noMarks?: boolean; restore?: boolean; sourceCandles?: MarketCandle[] } = {}) {
  const source = options.sourceCandles ?? candles
  const saved = options.restore ? ReplayEngine.create(input, source).snapshot() : undefined
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
