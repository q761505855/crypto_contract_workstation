import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { findMissingRanges } from '../market-data/gaps'
import type { MarketDataRuntime } from '../market-data/runtime'
import type {
  CreateReplaySessionInput,
  ReplaySession,
  ReplaySpeed,
} from './models'
import { DEFAULT_TRADING_CONFIG } from './models'
import { ReplayEngine } from './replay-engine'
import type { MarketCandle } from '../market-data/models'
import { validateSimulationConfig } from '../simulation/simulation-engine'

export interface ReplayCandleEvent {
  type: 'advance' | 'reset'
  candle: MarketCandle
}

export type ReplayCandleListener = (
  event: ReplayCandleEvent,
) => void | Promise<void>

export interface ReplayController {
  session: ReplaySession | null
  sessions: ReplaySession[]
  busy: boolean
  isPlaying: boolean
  error: string
  createSession(input: CreateReplaySessionInput): Promise<void>
  loadSession(id: string): Promise<void>
  endSession(): Promise<void>
  next(): Promise<void>
  previous(): void
  reset(): Promise<void>
  jumpToEnd(): Promise<void>
  play(): void
  pause(): void
  setSpeed(speed: ReplaySpeed): void
  setHasTrades(hasTrades: boolean): void
  subscribeCandle(listener: ReplayCandleListener): () => void
  clearError(): void
  getCurrentCandle(): MarketCandle | null
}

export function useReplayController(
  runtime: MarketDataRuntime,
): ReplayController {
  const engineRef = useRef<ReplayEngine | null>(null)
  const processingRef = useRef(false)
  const candleListenersRef = useRef(new Set<ReplayCandleListener>())
  const saveQueueRef = useRef(Promise.resolve())
  const [session, setSession] = useState<ReplaySession | null>(null)
  const [sessions, setSessions] = useState<ReplaySession[]>([])
  const [busy, setBusy] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [error, setError] = useState('')

  const refreshSessions = useCallback(async () => {
    setSessions(await runtime.replaySessions.list())
  }, [runtime])

  const queueSave = useCallback(
    (next: ReplaySession) => {
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(() => runtime.replaySessions.put(next))
        .catch((reason: unknown) => {
          setError(
            `自动保存回放会话失败：${
              reason instanceof Error ? reason.message : String(reason)
            }`,
          )
        })
    },
    [runtime],
  )

  const publish = useCallback(
    (engine: ReplayEngine) => {
      const next = engine.snapshot()
      setSession(next)
      setSessions((current) => [
        next,
        ...current.filter((item) => item.id !== next.id),
      ])
      queueSave(next)
    },
    [queueSave],
  )

  const notifyCandle = useCallback(async (event: ReplayCandleEvent) => {
    for (const listener of candleListenersRef.current) {
      await listener(event)
    }
  }, [])

  const hydrate = useCallback(
    async (saved: ReplaySession): Promise<void> => {
      const candles = await runtime.service.loadReplayCandles(
        'trade',
        saved.symbol.ticker,
        saved.period.text,
        saved.startTime,
        saved.endTime,
        { prefetchTo: saved.endTime },
      )
      const gaps = findMissingRanges(
        candles,
        saved.period.text,
        saved.startTime,
        saved.endTime,
      )
      if (gaps.length > 0) {
        throw new Error(
          `会话区间仍有 ${gaps.length} 个历史数据缺口，无法恢复回放。`,
        )
      }
      const engine = ReplayEngine.restore(
        { ...saved, active: true },
        candles,
      )
      engineRef.current = engine
      runtime.replayDatafeed.setSessionCandles(saved.id, candles)
      publish(engine)
    },
    [publish, runtime],
  )

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    void (async () => {
      try {
        const [savedSessions, active] = await Promise.all([
          runtime.replaySessions.list(),
          runtime.replaySessions.getLatestActive(),
        ])
        if (cancelled) return
        setSessions(savedSessions)
        if (active !== undefined) {
          await hydrate(active)
        }
      } catch (reason) {
        if (!cancelled) {
          setError(
            `恢复回放会话失败：${
              reason instanceof Error ? reason.message : String(reason)
            }`,
          )
        }
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hydrate, runtime])

  const createSession = useCallback(
    async (input: CreateReplaySessionInput) => {
      if (
        !Number.isFinite(input.startTime) ||
        (input.endTime !== undefined &&
          (!Number.isFinite(input.endTime) ||
            input.startTime >= input.endTime))
      ) {
        setError('回放结束时间必须晚于图表起点')
        return
      }
      setBusy(true)
      setIsPlaying(false)
      setError('')
      try {
        runtime.service.resetReplayRequests()
        validateSimulationConfig(
          input.tradingConfig ?? DEFAULT_TRADING_CONFIG,
        )
        if (engineRef.current !== null) {
          engineRef.current.setActive(false)
          queueSave(engineRef.current.snapshot())
        }
        const requestedEnd = input.endTime ?? Date.now()
        const downloaded = await runtime.service.loadCandles(
          'trade',
          input.symbol.ticker,
          input.period.text,
          input.startTime,
          requestedEnd,
        )
        const candles = downloaded.filter((candle) => candle.isClosed)
        if (candles.length === 0) {
          throw new Error('所选区间没有已经完成的 K 线')
        }
        const effectiveEnd = candles.at(-1)!.openTime
        const gaps = findMissingRanges(
          candles,
          input.period.text,
          input.startTime,
          effectiveEnd,
        )
        if (gaps.length > 0) {
          throw new Error(
            `所选区间仍有 ${gaps.length} 个历史数据缺口，请先补齐数据。`,
          )
        }
        // Prepare mark prices once for the session. Never fill them one bar at
        // a time during playback. Missing marks remain an explicit simulation
        // warning when remote preparation is unavailable or rate-limited.
        try {
          await runtime.service.loadReplayCandles(
            'mark', input.symbol.ticker, input.period.text,
            candles[0].openTime, effectiveEnd,
            { prefetchTo: effectiveEnd },
          )
        } catch {
          // Existing cached mark prices can still be used offline.
        }
        const engine = ReplayEngine.create(
          { ...input, endTime: effectiveEnd },
          candles,
        )
        engineRef.current = engine
        runtime.replayDatafeed.setSessionCandles(engine.snapshot().id, candles)
        publish(engine)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [publish, queueSave, runtime],
  )

  const loadSession = useCallback(
    async (id: string) => {
      setBusy(true)
      setIsPlaying(false)
      setError('')
      try {
        const saved = await runtime.replaySessions.get(id)
        if (saved === undefined) {
          throw new Error('找不到所选回放会话')
        }
        if (engineRef.current !== null) {
          engineRef.current.setActive(false)
          queueSave(engineRef.current.snapshot())
        }
        runtime.service.resetReplayRequests()
        await hydrate(saved)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [hydrate, queueSave, runtime],
  )

  const endSession = useCallback(async () => {
    const engine = engineRef.current
    setIsPlaying(false)
    if (engine !== null) {
      engine.setActive(false)
      const ended = engine.snapshot()
      await runtime.replaySessions.put(ended)
      setSessions((current) => [
        ended,
        ...current.filter((item) => item.id !== ended.id),
      ])
    }
    engineRef.current = null
    runtime.replayDatafeed.setSessionCandles(null)
    setSession(null)
  }, [runtime])

  const next = useCallback(async () => {
    const engine = engineRef.current
    if (engine === null || processingRef.current) return
    processingRef.current = true
    try {
      const candle = engine.stepNext()
      if (candle !== null) {
        await notifyCandle({ type: 'advance', candle })
      }
      publish(engine)
      if (engine.snapshot().status === 'completed') {
        setIsPlaying(false)
      }
    } catch (reason) {
      setIsPlaying(false)
      setError(
        `推进回放失败：${
          reason instanceof Error ? reason.message : String(reason)
        }`,
      )
      publish(engine)
    } finally {
      processingRef.current = false
    }
  }, [notifyCandle, publish])

  const previous = useCallback(() => {
    const engine = engineRef.current
    if (engine === null || engine.stepPrevious() === null) return
    setIsPlaying(false)
    publish(engine)
  }, [publish])

  const reset = useCallback(async () => {
    const engine = engineRef.current
    if (engine === null || processingRef.current) return
    processingRef.current = true
    setIsPlaying(false)
    try {
      const candle = engine.reset()
      await notifyCandle({ type: 'reset', candle })
      engine.setHasTrades(false)
      publish(engine)
    } catch (reason) {
      setError(
        `重置回放失败：${
          reason instanceof Error ? reason.message : String(reason)
        }`,
      )
    } finally {
      processingRef.current = false
    }
  }, [notifyCandle, publish])

  const jumpToEnd = useCallback(async () => {
    const engine = engineRef.current
    if (engine === null || processingRef.current) return
    processingRef.current = true
    setIsPlaying(false)
    try {
      let candle = engine.stepNext()
      while (candle !== null) {
        await notifyCandle({ type: 'advance', candle })
        candle = engine.stepNext()
      }
      publish(engine)
    } catch (reason) {
      setError(
        `跳转回放失败：${
          reason instanceof Error ? reason.message : String(reason)
        }`,
      )
      publish(engine)
    } finally {
      processingRef.current = false
    }
  }, [notifyCandle, publish])

  const setSpeed = useCallback(
    (speed: ReplaySpeed) => {
      const engine = engineRef.current
      if (engine === null) return
      engine.setSpeed(speed)
      publish(engine)
    },
    [publish],
  )

  const play = useCallback(() => {
    if (engineRef.current?.snapshot().status !== 'completed') {
      setIsPlaying(true)
    }
  }, [])

  const pause = useCallback(() => setIsPlaying(false), [])

  const getCurrentCandle = useCallback(() => {
    const candle = engineRef.current?.currentCandle()
    return candle === undefined ? null : { ...candle }
  }, [])

  const setHasTrades = useCallback(
    (hasTrades: boolean) => {
      const engine = engineRef.current
      if (
        engine === null ||
        engine.snapshot().hasTrades === hasTrades
      ) {
        return
      }
      engine.setHasTrades(hasTrades)
      publish(engine)
    },
    [publish],
  )

  const subscribeCandle = useCallback(
    (listener: ReplayCandleListener) => {
      candleListenersRef.current.add(listener)
      return () => candleListenersRef.current.delete(listener)
    },
    [],
  )

  useEffect(() => {
    if (!isPlaying || session === null || session.status === 'completed') {
      return
    }
    const timeout = window.setTimeout(
      () => void next(),
      1_000 / session.speed,
    )
    return () => window.clearTimeout(timeout)
  }, [isPlaying, next, session])

  return {
    session,
    sessions,
    busy,
    isPlaying,
    error,
    createSession,
    loadSession,
    endSession,
    next,
    previous,
    reset,
    jumpToEnd,
    play,
    pause,
    setSpeed,
    setHasTrades,
    subscribeCandle,
    clearError: () => setError(''),
    getCurrentCandle,
  }
}
