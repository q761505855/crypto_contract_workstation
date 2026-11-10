import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { findMissingRanges } from '../market-data/gaps'
import { alignOpenTime, lastClosedOpenTime, LEGACY_THREE_DAY_TIMEFRAME, nextOpenTime } from '../market-data/intervals'
import type { MarketDataRuntime } from '../market-data/runtime'
import type {
  CreateReplaySessionInput,
  ReplaySession,
  ReplaySpeed,
} from './models'
import { DEFAULT_TRADING_CONFIG, replaySourceTimeframe } from './models'
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

/** Only complete source bars within this UTC month and the following month. */
function preparationEnd(currentTime: number, timeframe: string, sessionEnd: number): number {
  const date = new Date(currentTime)
  const boundary = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 1)
  return Math.min(sessionEnd, lastClosedOpenTime(boundary, timeframe))
}

function restoreSourcePeriod(candles: MarketCandle[], timeframe: string): MarketCandle[] {
  return timeframe === LEGACY_THREE_DAY_TIMEFRAME
    ? candles.map(candle => ({ ...candle, timeframe: '3d' }))
    : candles
}

export interface ReplayController {
  session: ReplaySession | null
  sessions: ReplaySession[]
  busy: boolean
  isPlaying: boolean
  error: string
  preparationStatus?: string
  createSession(input: CreateReplaySessionInput): Promise<void>
  loadSession(id: string): Promise<void>
  deleteSession(id: string): Promise<void>
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
  const preparationRef = useRef<AbortController | null>(null)
  const processingRef = useRef(false)
  const candleListenersRef = useRef(new Set<ReplayCandleListener>())
  const saveQueueRef = useRef(Promise.resolve())
  const [session, setSession] = useState<ReplaySession | null>(null)
  const [sessions, setSessions] = useState<ReplaySession[]>([])
  const [busy, setBusy] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [error, setError] = useState('')
  const [preparationStatus, setPreparationStatus] = useState('')

  const queueSave = useCallback(
    (next: ReplaySession) => {
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(() => runtime.replaySessions.update(next))
        .catch((reason: unknown) => {
          setError(
            `自动保存回放会话失败：${
              reason instanceof Error ? reason.message : String(reason)
            }`,
          )
        })
      return saveQueueRef.current
    },
    [runtime],
  )

  const publish = useCallback(
    (engine: ReplayEngine, save = true) => {
      const next = engine.snapshot()
      setSession(next)
      setSessions((current) => [
        next,
        ...current.filter((item) => item.id !== next.id),
      ])
      if (save) queueSave(next)
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
      const timeframe = replaySourceTimeframe(saved)
      const bufferedEnd = preparationEnd(saved.currentTime, timeframe, saved.endTime)
      const candles = await runtime.service.loadReplayCandles(
        'trade',
        saved.symbol.ticker,
        timeframe,
        saved.startTime,
        bufferedEnd,
        { prefetchTo: bufferedEnd, onStatus: setPreparationStatus },
      )
      const gaps = findMissingRanges(
        candles,
        timeframe,
        saved.startTime,
        bufferedEnd,
      )
      if (gaps.length > 0) {
        throw new Error(
          `会话区间仍有 ${gaps.length} 个历史数据缺口，无法恢复回放。`,
        )
      }
      const engine = ReplayEngine.restore(
        { ...saved, active: true },
        restoreSourcePeriod(candles, timeframe),
        Date.now,
        { buffered: true },
      )
      engineRef.current = engine
      runtime.replayDatafeed.setSessionCandles(saved.id, engine.bufferedCandles())
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
        if (!cancelled) { setBusy(false); setPreparationStatus('') }
      }
    })()
    return () => {
      cancelled = true
      preparationRef.current?.abort()
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
      preparationRef.current?.abort()
      preparationRef.current = null
      setBusy(true)
      setIsPlaying(false)
      setError('')
      setPreparationStatus('正在按月准备回放数据…')
      try {
        runtime.service.resetReplayRequests()
        validateSimulationConfig(
          input.tradingConfig ?? DEFAULT_TRADING_CONFIG,
        )
        if (engineRef.current !== null) {
          engineRef.current.setActive(false)
          queueSave(engineRef.current.snapshot())
        }
        const preparedAt = Date.now()
        const requestedEnd = Math.min(
          alignOpenTime(input.endTime ?? preparedAt,input.period.text,'floor'),
          lastClosedOpenTime(preparedAt,input.period.text),
        )
        const bufferedEnd = preparationEnd(input.startTime, input.period.text, requestedEnd)
        const downloaded = await runtime.service.loadCandles(
          'trade',
          input.symbol.ticker,
          input.period.text,
          input.startTime,
          bufferedEnd,
          { onStatus: setPreparationStatus },
        )
        const candles = downloaded.filter((candle) => candle.isClosed && candle.openTime <= bufferedEnd && candle.closeTime < preparedAt)
        if (candles.length === 0) {
          throw new Error('所选区间没有已经完成的 K 线')
        }
        const expectedEnd = bufferedEnd
        const gaps = findMissingRanges(
          candles,
          input.period.text,
          input.startTime,
          expectedEnd,
        )
        if (gaps.length > 0) {
          throw new Error(
            `所选区间仍有 ${gaps.length} 个历史数据缺口，请先补齐数据。`,
          )
        }
        const engine = ReplayEngine.create(
          { ...input, endTime: requestedEnd },
          candles,
          { buffered: true },
        )
        // Persist the parent session before publishing it to the simulation controller.
        await runtime.replaySessions.put(engine.snapshot())
        engineRef.current = engine
        runtime.replayDatafeed.setSessionCandles(engine.snapshot().id, candles)
        publish(engine, false)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
        setPreparationStatus('')
      }
    },
    [publish, queueSave, runtime],
  )

  const loadSession = useCallback(
    async (id: string) => {
      preparationRef.current?.abort()
      preparationRef.current = null
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
        setPreparationStatus('')
      }
    },
    [hydrate, queueSave, runtime],
  )

  const endSession = useCallback(async () => {
    const engine = engineRef.current
    engineRef.current = null
    preparationRef.current?.abort()
    preparationRef.current = null
    setBusy(false)
    setPreparationStatus('')
    setIsPlaying(false)
    runtime.replayDatafeed.setSessionCandles(null)
    setSession(null)
    if (engine !== null) {
      engine.setActive(false)
      const ended = engine.snapshot()
      const saved = queueSave(ended)
      setSessions((current) => [
        ended,
        ...current.filter((item) => item.id !== ended.id),
      ])
      await saved
    }
  }, [queueSave, runtime])

  const deleteSession = useCallback(async (id: string) => {
    if (busy || engineRef.current !== null) return
    setBusy(true)
    setError('')
    try {
      await runtime.replaySessions.delete(id)
      setSessions((current) => current.filter((item) => item.id !== id))
    } catch (reason) {
      setError(`删除回放会话失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }, [busy, runtime])

  const ensurePrepared = useCallback(async (engine: ReplayEngine, currentTime: number): Promise<boolean> => {
    const saved = engine.snapshot()
    const timeframe = replaySourceTimeframe(saved)
    const to = preparationEnd(currentTime, timeframe, saved.endTime)
    const from = nextOpenTime(engine.bufferedCandles().at(-1)!.openTime, timeframe)
    if (from > to) return engineRef.current === engine
    const controller = new AbortController()
    preparationRef.current = controller
    setBusy(true)
    setPreparationStatus('正在准备下个月的回放数据…')
    try {
      const downloaded = await runtime.service.loadCandles('trade', saved.symbol.ticker, timeframe, from, to, {
        signal: controller.signal,
        onStatus: message => { if (preparationRef.current === controller) setPreparationStatus(message) },
      })
      if (engineRef.current !== engine) return false
      const candles = downloaded.filter(candle => candle.isClosed && candle.openTime >= from && candle.openTime <= to && candle.closeTime < Date.now())
      if (findMissingRanges(candles, timeframe, from, to).length > 0) throw new Error('下一段回放数据仍有缺口，请重试')
      engine.appendCandles(restoreSourcePeriod(candles, timeframe))
      runtime.replayDatafeed.setSessionCandles(saved.id, engine.bufferedCandles())
      return true
    } finally {
      if (preparationRef.current === controller) {
        preparationRef.current = null
        setBusy(false)
        setPreparationStatus('')
      }
    }
  }, [runtime])

  const next = useCallback(async () => {
    const engine = engineRef.current
    if (engine === null || processingRef.current) return
    processingRef.current = true
    setError('')
    try {
      if (!await ensurePrepared(engine, Math.min(nextOpenTime(engine.snapshot().currentTime, engine.snapshot().period.text), engine.snapshot().endTime))) return
      const candle = engine.stepNext()
      if (candle !== null) {
        await notifyCandle({ type: 'advance', candle })
      }
      if (engineRef.current !== engine) return
      publish(engine)
      if (engine.snapshot().status === 'completed') {
        setIsPlaying(false)
      }
    } catch (reason) {
      if (engineRef.current !== engine) return
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
  }, [ensurePrepared, notifyCandle, publish])

  const previous = useCallback(() => {
    const engine = engineRef.current
    if (engine === null || processingRef.current || engine.stepPrevious() === null) return
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
      if (engineRef.current !== engine) return
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
    setError('')
    try {
      while (engine.snapshot().currentTime < engine.snapshot().endTime) {
        if (!await ensurePrepared(engine, nextOpenTime(engine.snapshot().currentTime, engine.snapshot().period.text))) return
        const candle = engine.stepNext()
        if (candle === null) break
        await notifyCandle({ type: 'advance', candle })
        if (engineRef.current !== engine) return
      }
      publish(engine)
    } catch (reason) {
      if (engineRef.current !== engine) return
      setError(
        `跳转回放失败：${
          reason instanceof Error ? reason.message : String(reason)
        }`,
      )
      publish(engine)
    } finally {
      processingRef.current = false
    }
  }, [ensurePrepared, notifyCandle, publish])

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
    preparationStatus,
    createSession,
    loadSession,
    deleteSession,
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
