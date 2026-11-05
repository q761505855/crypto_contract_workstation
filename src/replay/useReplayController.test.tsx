import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import type { MarketDataRuntime } from '../market-data/runtime'
import type { MarketCandle } from '../market-data/models'
import { useSimulationController } from '../simulation/useSimulationController'
import { ReplayEngine } from './replay-engine'
import { useReplayController } from './useReplayController'

const minute = 60_000
const input = { symbol: DEFAULT_SYMBOL, period: SUPPORTED_PERIODS[0], startTime: 0, endTime: 5 * minute }
const candles: MarketCandle[] = Array.from({ length: 6 }, (_, index) => ({
  symbol: 'BTCUSDT', timeframe: '1m', openTime: index * minute,
  closeTime: (index + 1) * minute - 1, open: '100', high: '101', low: '99', close: '100',
  volume: '10', quoteVolume: '1000', tradeCount: 1, isClosed: true, source: 'binance',
}))

function setup(options: { noMarks?: boolean; restore?: boolean } = {}) {
  const saved = options.restore ? ReplayEngine.create(input, candles).snapshot() : undefined
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
      loadCandles: vi.fn(async (kind: string) => kind === 'mark' ? marks : candles),
      loadCachedCandles: vi.fn(async (kind: string) => kind === 'mark' ? marks : candles),
      loadReplayCandles: vi.fn(async (kind: string) => kind === 'mark' ? marks : candles),
      resetReplayRequests: vi.fn(),
    },
  } as unknown as MarketDataRuntime
  const hook = renderHook(() => {
    const replay = useReplayController(runtime)
    const simulation = useSimulationController(runtime, replay)
    return { replay, simulation }
  })
  return { ...hook, runtime }
}

describe('offline replay and simulation controllers', () => {
  it('rejects a missing tail instead of shortening the requested replay range', async () => {
    const { result, runtime } = setup()
    await waitFor(() => expect(result.current.replay.busy).toBe(false))
    vi.mocked(runtime.service.loadCandles).mockResolvedValue(candles.slice(0, 3))
    await act(async () => { await result.current.replay.createSession(input) })
    expect(result.current.replay.session).toBeNull()
    expect(result.current.replay.error).toMatch(/缺口|不完整/)
  })
  it('prepares each candle kind in a batch and makes no remote calls while trading or stepping', async () => {
    const { result, runtime } = setup()
    await waitFor(() => expect(result.current.replay.busy).toBe(false))
    await act(async () => { await result.current.replay.createSession(input) })
    await waitFor(() => expect(result.current.simulation.busy).toBe(false))
    expect(runtime.service.loadCandles).toHaveBeenCalledOnce()
    expect(runtime.service.loadReplayCandles).toHaveBeenCalledWith('mark', 'BTCUSDT', '1m', 0, 5 * minute, { prefetchTo: 5 * minute })
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

  it('warns when batch preparation lacks marks instead of requesting each new candle', async () => {
    const { result, runtime } = setup({ noMarks: true })
    await waitFor(() => expect(result.current.replay.busy).toBe(false))
    await act(async () => { await result.current.replay.createSession(input) })
    await waitFor(() => expect(result.current.simulation.busy).toBe(false))
    vi.mocked(runtime.service.loadCandles).mockClear()
    await act(async () => { await result.current.simulation.open('long', { margin: '100' }) })
    await act(async () => { await result.current.replay.next() })
    await act(async () => { await result.current.replay.next() })
    expect(result.current.simulation.state?.warning).toContain('缺少当前 K 线的标记价格')
    expect(result.current.replay.session?.currentTime).toBe(2 * minute)
    expect(runtime.service.loadCandles).not.toHaveBeenCalled()
  })

  it('restores an existing session through shared batch preparation', async () => {
    const { result, runtime } = setup({ restore: true })
    await waitFor(() => expect(result.current.replay.busy).toBe(false))
    await waitFor(() => expect(result.current.simulation.state).not.toBeNull())
    expect(runtime.service.loadCandles).not.toHaveBeenCalled()
    expect(runtime.service.loadReplayCandles).toHaveBeenCalledWith('trade', 'BTCUSDT', '1m', 0, 5 * minute, { prefetchTo: 5 * minute })
    expect(runtime.replayDatafeed.setSessionCandles).toHaveBeenCalledWith(expect.any(String), candles)
    await act(async () => { await result.current.replay.next() })
    expect(result.current.replay.session?.currentTime).toBe(minute)
    expect(runtime.service.loadCandles).not.toHaveBeenCalled()
  })
})
