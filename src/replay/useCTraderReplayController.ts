import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isCTraderTimeframe } from '../market-data/intervals'
import type { CTraderMarketService } from '../market-data/ctrader-market'
import { cTraderLeverage } from '../simulation/ctrader-trading'
import { validateSimulationConfig } from '../simulation/simulation-engine'
import type { ReplaySessionStore } from '../storage/replay-session-store'
import { CTraderReplayBars, loadClosedReplayBars, type CTraderReplayMarket } from './ctrader-replay-bars'
import { CTraderReplayTicks, type ReplayPriceCandle } from './ctrader-replay-ticks'
import { DEFAULT_TRADING_CONFIG, sessionVisibleUntil, type CreateReplaySessionInput, type ReplaySession, type ReplaySpeed } from './models'
import { isCTraderReplayStepPeriod, isFineStepPeriod, type CTraderReplayStepPeriod, type ReplayStepPeriod } from './step-periods'
import type { ReplayCandleEvent, ReplayCandleListener, ReplayController } from './useReplayController'

interface CTraderReplayRuntime {
  service: CTraderReplayMarket & Pick<CTraderMarketService, 'getReplayTradingTerms'>
  replaySessions: Omit<ReplaySessionStore, 'getLatestActive'>
  replayTicks?: CTraderReplayTicks
}

interface ReplayCursor {
  session: ReplaySession
  candle: ReplayPriceCandle
  initial: ReplayPriceCandle
}

function updateCursor(cursor: ReplayCursor, changes: Partial<ReplaySession>): void {
  cursor.session = { ...cursor.session, ...changes, updatedAt: Date.now() }
}

function moveCursor(cursor: ReplayCursor, candle: ReplayPriceCandle, index: number): void {
  cursor.candle = candle
  updateCursor(cursor, {
    currentTime: candle.openTime,
    visibleUntil: candle.closeTime + 1,
    cursorTimeframe: candle.timeframe as CTraderReplayStepPeriod,
    cursorTickIndex: candle.tickIndex,
    currentIndex: index,
    candleCount: Math.max(cursor.session.candleCount, index + 1),
    status: candle.timeframe !== 'tick' && candle.closeTime === cursor.session.endTime ? 'completed' : 'paused',
  })
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function stepPeriod(session: ReplaySession, requested?: ReplayStepPeriod): CTraderReplayStepPeriod {
  if (requested !== undefined && isCTraderReplayStepPeriod(requested)) return requested
  return session.cursorTimeframe ?? (isCTraderTimeframe(session.period.text) ? session.period.text : '1m')
}

export function useCTraderReplayController(
  runtime: CTraderReplayRuntime,
  stepTimeframe?: ReplayStepPeriod,
): ReplayController<ReplayStepPeriod> {
  const { service, replaySessions, replayTicks } = runtime
  const history = useMemo(() => new CTraderReplayBars(service), [service])
  const ticks = useMemo(() => replayTicks ?? new CTraderReplayTicks(service, history), [replayTicks, service, history])
  const cursorRef = useRef<ReplayCursor | null>(null)
  const operationRef = useRef<AbortController | null>(null)
  const listeners = useRef(new Set<ReplayCandleListener>())
  const saveQueue = useRef(Promise.resolve())
  const [session, setSession] = useState<ReplaySession | null>(null)
  const [sessions, setSessions] = useState<ReplaySession[]>([])
  const [busy, setBusy] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [error, setError] = useState('')
  const [preparationStatus, setPreparationStatus] = useState('')

  const findStep = useCallback((
    symbol: string, timeframe: CTraderReplayStepPeriod, from: number, to: number,
    direction: 1 | -1, signal: AbortSignal, tickIndex?: number,
  ): Promise<ReplayPriceCandle | undefined> => isFineStepPeriod(timeframe)
    ? ticks.find(symbol, timeframe, from, to, direction, signal, tickIndex)
    : history.find(symbol, timeframe, from, to, direction, signal), [history, ticks])

  const remember = useCallback((saved: ReplaySession) => {
    setSessions(current => [saved, ...current.filter(item => item.id !== saved.id)])
  }, [])

  const queueSave = useCallback((saved: ReplaySession) => {
    saveQueue.current = saveQueue.current
      .then(() => replaySessions.update(saved))
      .catch(reason => setError(`自动保存回放会话失败：${message(reason)}`))
    return saveQueue.current
  }, [replaySessions])

  const publish = useCallback(async (cursor: ReplayCursor) => {
    const saved = cursor.session
    await queueSave(saved)
    if (cursorRef.current !== cursor || cursor.session !== saved) return
    setSession(saved)
    remember(saved)
  }, [queueSave, remember])

  const notify = useCallback(async (event: ReplayCandleEvent) => {
    for (const listener of listeners.current) await listener(event)
  }, [])

  const run = useCallback(async (
    description: string,
    work: (signal: AbortSignal) => Promise<void>,
    loading = '',
  ) => {
    if (operationRef.current !== null) return
    const operation = new AbortController()
    operationRef.current = operation
    setBusy(true)
    setError('')
    setPreparationStatus(loading)
    try {
      await work(operation.signal)
    } catch (reason) {
      if (!operation.signal.aborted) {
        setIsPlaying(false)
        setError(`${description}：${message(reason)}`)
      }
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null
        setBusy(false)
        setPreparationStatus('')
      }
    }
  }, [])

  const hydrate = useCallback(async (saved: ReplaySession, signal: AbortSignal): Promise<ReplayCursor> => {
    if (saved.marketSource !== 'ctrader') {
      throw new Error('这是币安会话。可从数据管理查看或导出存档，cTrader 无法继续此会话。')
    }
    const symbol = saved.symbol.ticker
    const startPeriod = saved.period.text
    const cursorPeriod = saved.cursorTimeframe ?? startPeriod
    const initial = (await loadClosedReplayBars(service, symbol, startPeriod, saved.startTime, saved.startTime, signal))[0]
    let candle: ReplayPriceCandle | undefined = initial
    if (isFineStepPeriod(cursorPeriod)) {
      const afterIndex = cursorPeriod === 'tick' ? (saved.cursorTickIndex ?? 0) - 1 : undefined
      candle = await ticks.find(symbol, cursorPeriod, saved.currentTime, sessionVisibleUntil(saved) - 1, 1, signal, afterIndex)
    } else if (saved.currentTime !== saved.startTime || cursorPeriod !== startPeriod) {
      candle = (await loadClosedReplayBars(service, symbol, cursorPeriod, saved.currentTime, saved.currentTime, signal))[0]
    }
    if (!initial || !candle || candle.closeTime + 1 !== sessionVisibleUntil(saved) || candle.tickIndex !== saved.cursorTickIndex) {
      throw new Error('cTrader 未返回与存档一致的回放 K 线')
    }
    return { session: saved, candle, initial }
  }, [service, ticks])

  useEffect(() => {
    void run('恢复回放会话失败', async signal => {
      const saved = await replaySessions.list()
      signal.throwIfAborted()
      setSessions(saved)
      const active = saved.find(item => item.active && item.marketSource === 'ctrader')
      if (active !== undefined) {
        const cursor = await hydrate(active, signal)
        signal.throwIfAborted()
        cursorRef.current = cursor
        setSession(active)
      }
    })
    return () => {
      operationRef.current?.abort()
      operationRef.current = null
      cursorRef.current = null
    }
  }, [hydrate, replaySessions, run])

  const activate = useCallback(async (cursor: ReplayCursor, signal: AbortSignal, create = false) => {
    const prior = cursorRef.current
    signal.throwIfAborted()
    if (create) await replaySessions.put(cursor.session)
    else await queueSave(cursor.session)
    signal.throwIfAborted()
    if (prior !== null && prior.session.id !== cursor.session.id) {
      updateCursor(prior, { active: false })
      await queueSave(prior.session)
      remember(prior.session)
    }
    signal.throwIfAborted()
    cursorRef.current = cursor
    setSession(cursor.session)
    remember(cursor.session)
  }, [queueSave, remember, replaySessions])

  const createSession = useCallback((input: CreateReplaySessionInput) => run(
    '创建回放失败',
    async signal => {
      const endTime = Math.min(input.endTime ?? Date.now(), Date.now() - 1)
      if (!Number.isSafeInteger(input.startTime) || !Number.isSafeInteger(endTime) || input.startTime >= endTime) {
        throw new Error('回放结束时间必须晚于图表起点')
      }
      setIsPlaying(false)
      const candle = await history.find(input.symbol.ticker, input.period.text, input.startTime, endTime, 1, signal)
      if (candle === undefined) throw new Error('所选区间没有可用于回放的 cTrader K 线')
      const ctrader = await service.getReplayTradingTerms(input.symbol.ticker, candle.openTime, signal)
      const tradingConfig = {
        initialBalance: input.initialBalance ?? DEFAULT_TRADING_CONFIG.initialBalance,
        leverage: input.leverage ?? cTraderLeverage(ctrader), feeRate: '0', slippageRate: input.slippageRate ?? '0',
        maintenanceMarginRate: '0', liquidationFeeRate: '0', ctrader,
      }
      validateSimulationConfig(tradingConfig)
      signal.throwIfAborted()
      const now = Date.now()
      const next: ReplaySession = {
        schemaVersion: 2,
        marketSource: 'ctrader',
        cursorTimeframe: candle.timeframe as CTraderReplayStepPeriod,
        id: crypto.randomUUID(),
        symbol: { ...input.symbol },
        period: { ...input.period },
        startTime: candle.openTime,
        endTime,
        currentTime: candle.openTime,
        visibleUntil: candle.closeTime + 1,
        currentIndex: 0,
        candleCount: 1,
        speed: input.speed ?? 1,
        status: candle.closeTime === endTime ? 'completed' : 'paused',
        active: true,
        hasTrades: false,
        tradingConfig: { ...tradingConfig },
        createdAt: now,
        updatedAt: now,
      }
      await activate({ session: next, candle, initial: candle }, signal, true)
    },
    '正在准备回放行情和 IC Markets 交易规格…',
  ), [activate, history, run, service])

  const loadSession = useCallback((id: string) => run('加载回放会话失败', async signal => {
    setIsPlaying(false)
    await saveQueue.current
    const saved = await replaySessions.get(id)
    if (saved === undefined) throw new Error('找不到所选回放会话')
    const cursor = await hydrate(saved, signal)
    updateCursor(cursor, { active: true })
    await activate(cursor, signal)
  }, '正在读取会话的 cTrader K 线…'), [activate, hydrate, replaySessions, run])

  const endSession = useCallback(async () => {
    operationRef.current?.abort()
    operationRef.current = null
    const cursor = cursorRef.current
    cursorRef.current = null
    setIsPlaying(false)
    setSession(null)
    setBusy(false)
    setPreparationStatus('')
    if (cursor !== null) {
      updateCursor(cursor, { active: false })
      remember(cursor.session)
      await queueSave(cursor.session)
    }
  }, [queueSave, remember])

  const deleteSession = useCallback((id: string) => run('删除回放会话失败', async () => {
    if (cursorRef.current !== null) return
    await saveQueue.current
    await replaySessions.delete(id)
    setSessions(current => current.filter(item => item.id !== id))
  }), [replaySessions, run])

  const advance = useCallback(async (cursor: ReplayCursor, timeframe: CTraderReplayStepPeriod, signal: AbortSignal) => {
    const { session: saved } = cursor
    const tickIndex = timeframe === 'tick' ? saved.cursorTickIndex : undefined
    const from = tickIndex === undefined ? sessionVisibleUntil(saved) : saved.currentTime
    const candle = await findStep(saved.symbol.ticker, timeframe, from, saved.endTime, 1, signal, tickIndex)
    signal.throwIfAborted()
    if (candle === undefined) {
      setIsPlaying(false)
      const remaining = timeframe === '1m' || isFineStepPeriod(timeframe) ? undefined : await history.find(
        saved.symbol.ticker, '1m', sessionVisibleUntil(saved), saved.endTime, 1, signal,
      )
      signal.throwIfAborted()
      if (remaining === undefined) updateCursor(cursor, { status: 'completed' })
      else setError('所选周期在结束前没有下一根完整 K 线，可换用更小的步进周期。')
      return false
    }
    const sameTimeTick = tickIndex !== undefined && candle.openTime === saved.currentTime
    moveCursor(cursor, candle, saved.currentIndex + 1)
    // Publish the reached cursor even if simulation reports an error, so a
    // retry cannot replay the same candle against already updated positions.
    try {
      await notify({ type: 'advance', candle, ...(sameTimeTick ? { sameTimeTick: true } : {}) })
    } catch (reason) {
      if (!signal.aborted) await publish(cursor)
      throw reason
    }
    if (cursor.session.status === 'completed') setIsPlaying(false)
    return true
  }, [findStep, history, notify, publish])

  const next = useCallback((timeframe = stepTimeframe) => run('推进回放失败', async signal => {
    const cursor = cursorRef.current
    if (cursor === null || cursor.session.status === 'completed') return
    await advance(cursor, stepPeriod(cursor.session, timeframe), signal)
    signal.throwIfAborted()
    await publish(cursor)
  }), [advance, publish, run, stepTimeframe])

  const previous = useCallback((timeframe = stepTimeframe) => run('回退回放失败', async signal => {
    const cursor = cursorRef.current
    if (cursor === null || cursor.session.hasTrades || cursor.candle.closeTime === cursor.initial.closeTime) return
    setIsPlaying(false)
    const { session: saved, initial } = cursor
    const period = stepPeriod(saved, timeframe)
    const tickIndex = period === 'tick' ? saved.cursorTickIndex : undefined
    const candle = await findStep(
      saved.symbol.ticker, period, initial.closeTime + 1,
      tickIndex === undefined ? cursor.candle.closeTime - 1 : saved.currentTime, -1, signal, tickIndex,
    )
    signal.throwIfAborted()
    moveCursor(cursor, candle ?? initial, candle === undefined ? 0 : Math.max(1, saved.currentIndex - 1))
    await publish(cursor)
  }), [findStep, publish, run, stepTimeframe])

  const reset = useCallback(() => run('重置回放失败', async signal => {
    const cursor = cursorRef.current
    if (cursor === null) return
    setIsPlaying(false)
    moveCursor(cursor, cursor.initial, 0)
    await notify({ type: 'reset', candle: cursor.initial })
    signal.throwIfAborted()
    updateCursor(cursor, { hasTrades: false })
    await publish(cursor)
  }), [notify, publish, run])

  const jumpToEnd = useCallback(() => run('跳转回放失败', async signal => {
    const cursor = cursorRef.current
    if (cursor === null) return
    setIsPlaying(false)
    const timeframe = stepPeriod(cursor.session, stepTimeframe)
    while (cursor.session.status !== 'completed') {
      const moved = await advance(cursor, timeframe, signal)
      signal.throwIfAborted()
      if (!moved) break
      // Save the cursor after each durable simulation update.
      await queueSave(cursor.session)
    }
    await publish(cursor)
  }, '正在读取剩余的 cTrader K 线…'), [advance, publish, queueSave, run, stepTimeframe])

  const setSpeed = useCallback((speed: ReplaySpeed) => {
    const cursor = cursorRef.current
    if (cursor === null || operationRef.current !== null) return
    updateCursor(cursor, { speed })
    void publish(cursor)
  }, [publish])

  const setHasTrades = useCallback((hasTrades: boolean) => {
    const cursor = cursorRef.current
    if (cursor === null || cursor.session.hasTrades === hasTrades) return
    updateCursor(cursor, { hasTrades })
    if (operationRef.current === null) void publish(cursor)
  }, [publish])

  const getCurrentCandle = useCallback(() => {
    const candle = cursorRef.current?.candle
    return candle === undefined ? null : { ...candle }
  }, [])

  const subscribeCandle = useCallback((listener: ReplayCandleListener) => {
    listeners.current.add(listener)
    return () => { listeners.current.delete(listener) }
  }, [])

  const play = useCallback(() => {
    if (cursorRef.current?.session.status === 'paused') setIsPlaying(true)
  }, [])
  const pause = useCallback(() => setIsPlaying(false), [])

  useEffect(() => {
    if (!isPlaying || busy || session?.status !== 'paused') return
    const timeout = window.setTimeout(() => void next(), 1000 / session.speed)
    return () => window.clearTimeout(timeout)
  }, [busy, isPlaying, next, session])

  return {
    session, sessions, busy, isPlaying, error, preparationStatus,
    createSession, loadSession, deleteSession, endSession, next, previous, reset, jumpToEnd,
    play, pause, setSpeed, setHasTrades, subscribeCandle, clearError: () => setError(''), getCurrentCandle,
  }
}
