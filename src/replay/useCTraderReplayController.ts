import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isCTraderTimeframe } from '../market-data/intervals'
import { cTraderLeverage } from '../simulation/ctrader-trading'
import { OKX_SIMULATION_TAKER_FEE, okxMaximumLeverage, type OkxReplayRisk, type ReplayTradingTerms } from '../simulation/okx-trading'
import { validateSimulationConfig } from '../simulation/simulation-engine'
import type { ReplaySessionStore } from '../storage/replay-session-store'
import { CTraderReplayBars, loadClosedReplayBars, type CTraderReplayMarket } from './ctrader-replay-bars'
import { CTraderReplayTicks, type ReplayPriceCandle } from './ctrader-replay-ticks'
import { DEFAULT_TRADING_CONFIG, sessionVisibleUntil, type CreateReplaySessionInput, type ReplaySession, type ReplaySpeed } from './models'
import { isCTraderReplayStepPeriod, isFineStepPeriod, type CTraderReplayStepPeriod, type ReplayStepPeriod } from './step-periods'
import type { ReplayCandleEvent, ReplayCandleListener, ReplayController } from './useReplayController'
import type { MarketCandle } from '../market-data/models'
import { isOkxPriceSource, priceSourceLabel } from '../market-data/price-source-preferences'

interface CTraderReplayRuntime {
  service: CTraderReplayMarket & {
    getReplayTradingTerms(symbol: string, start: number, signal?: AbortSignal): Promise<ReplayTradingTerms>
    getReplayRisk?(candle: MarketCandle, from: number, signal: AbortSignal): Promise<OkxReplayRisk>
  }
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
  if (requested !== undefined && isCTraderReplayStepPeriod(requested) &&
      (!isOkxPriceSource(session.marketSource) || !isFineStepPeriod(requested))) return requested
  return session.cursorTimeframe ?? (isCTraderTimeframe(session.period.text) ? session.period.text : '1m')
}

export function useCTraderReplayController(
  runtime: CTraderReplayRuntime,
  stepTimeframe?: ReplayStepPeriod,
): ReplayController<ReplayStepPeriod> {
  const { service, replaySessions, replayTicks } = runtime
  const source = service.source ?? 'ctrader'
  const sourceLabel = priceSourceLabel(source)
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

  const publish = useCallback(async (cursor: ReplayCursor, finishOnCompletion = false) => {
    const finished = finishOnCompletion && cursor.session.status === 'completed'
    if (finished) {
      updateCursor(cursor, { active: false })
    }
    const saved = cursor.session
    await queueSave(saved)
    if (cursorRef.current !== cursor || cursor.session !== saved) return
    if (finished) cursorRef.current = null
    setSession(finished ? null : saved)
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
    if (saved.marketSource !== source) {
      const origin = saved.marketSource === 'ctrader' || isOkxPriceSource(saved.marketSource) ? priceSourceLabel(saved.marketSource) : '币安'
      throw new Error(`这是 ${origin} 会话。可从数据管理查看或导出存档，${sourceLabel} 无法继续此会话。`)
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
      throw new Error(`${sourceLabel} 未返回与存档一致的回放 K 线`)
    }
    return { session: saved, candle, initial }
  }, [service, source, sourceLabel, ticks])

  useEffect(() => {
    void run('恢复回放会话失败', async signal => {
      const saved = await replaySessions.list()
      signal.throwIfAborted()
      setSessions(saved.filter(item => source === 'ctrader' ? !isOkxPriceSource(item.marketSource) : item.marketSource === source))
      if (source === 'okx-local') return
      const active = saved.find(item => item.active && item.status !== 'completed' && item.marketSource === source)
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
  }, [hydrate, replaySessions, run, source])

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
    const finished = create && cursor.session.status === 'completed'
    cursorRef.current = finished ? null : cursor
    setSession(finished ? null : cursor.session)
    remember(cursor.session)
  }, [queueSave, remember, replaySessions])

  const createSession = useCallback((input: CreateReplaySessionInput) => run(
    '创建回放失败',
    async signal => {
      const bounds = await service.historyBounds?.(input.symbol.ticker, signal)
      if (service.historyBounds && !bounds) throw new Error('请先在本地数据管理中添加此品种的逐笔成交归档。')
      const endTime = Math.min(input.endTime ?? Date.now(), Date.now() - 1, bounds?.to ?? Infinity)
      if (!Number.isSafeInteger(input.startTime) || !Number.isSafeInteger(endTime) || input.startTime >= endTime) {
        throw new Error('回放结束时间必须晚于图表起点')
      }
      setIsPlaying(false)
      const candle = await history.find(input.symbol.ticker, input.period.text, input.startTime, endTime, 1, signal)
      if (candle === undefined) throw new Error('所选区间没有已收盘的 K 线，请将图表移到更早的时间。')
      const terms = await service.getReplayTradingTerms(input.symbol.ticker, candle.openTime, signal)
      const economics = 'tickSize' in terms ? {
        leverage: input.leverage ?? Math.min(DEFAULT_TRADING_CONFIG.leverage, okxMaximumLeverage(terms)),
        feeRate: OKX_SIMULATION_TAKER_FEE, maintenanceMarginRate: terms.tiers[0].maintenanceMarginRate,
        liquidationFeeRate: OKX_SIMULATION_TAKER_FEE, okx: terms,
      } : {
        leverage: input.leverage ?? cTraderLeverage(terms),
        feeRate: '0', maintenanceMarginRate: '0', liquidationFeeRate: '0', ctrader: terms,
      }
      const tradingConfig = {
        initialBalance: input.initialBalance ?? DEFAULT_TRADING_CONFIG.initialBalance,
        slippageRate: input.slippageRate ?? '0', ...economics,
      }
      validateSimulationConfig(tradingConfig)
      signal.throwIfAborted()
      const now = Date.now()
      const completed = candle.closeTime === endTime
      const next: ReplaySession = {
        schemaVersion: 2,
        marketSource: source,
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
        status: completed ? 'completed' : 'paused',
        active: !completed,
        hasTrades: false,
        tradingConfig: { ...tradingConfig },
        createdAt: now,
        updatedAt: now,
      }
      await activate({ session: next, candle, initial: candle }, signal, true)
    },
    `正在准备回放行情和 ${isOkxPriceSource(source) ? 'OKX' : 'IC Markets'} 交易规格…`,
  ), [activate, history, run, service, source])

  const loadSession = useCallback((id: string) => run('加载回放会话失败', async signal => {
    setIsPlaying(false)
    await saveQueue.current
    const saved = await replaySessions.get(id)
    if (saved === undefined) throw new Error('找不到所选回放会话')
    const cursor = await hydrate(saved, signal)
    // An archived result can be opened explicitly for review or reset.
    updateCursor(cursor, { active: saved.status !== 'completed' })
    await activate(cursor, signal)
  }, `正在读取会话的 ${sourceLabel} K 线…`), [activate, hydrate, replaySessions, run, sourceLabel])

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
    const okxRisk = isOkxPriceSource(source) && saved.hasTrades ? await service.getReplayRisk?.(candle, sessionVisibleUntil(saved), signal) : undefined
    signal.throwIfAborted()
    moveCursor(cursor, candle, saved.currentIndex + 1)
    // Publish the reached cursor even if simulation reports an error, so a
    // retry cannot replay the same candle against already updated positions.
    try {
      await notify({ type: 'advance', candle, ...(sameTimeTick ? { sameTimeTick: true } : {}), ...(okxRisk && { okxRisk }) })
    } catch (reason) {
      if (!signal.aborted) await publish(cursor, true)
      throw reason
    }
    if (cursor.session.status === 'completed') setIsPlaying(false)
    return cursor.session.status !== 'completed'
  }, [findStep, history, notify, publish, service, source])

  const next = useCallback((timeframe = stepTimeframe) => run('推进回放失败', async signal => {
    const cursor = cursorRef.current
    if (cursor === null || cursor.session.status === 'completed') return
    await advance(cursor, stepPeriod(cursor.session, timeframe), signal)
    signal.throwIfAborted()
    await publish(cursor, true)
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
    if (!saved.active && cursor.session.status === 'paused') updateCursor(cursor, { active: true })
    await publish(cursor)
  }), [findStep, publish, run, stepTimeframe])

  const reset = useCallback(() => run('重置回放失败', async signal => {
    const cursor = cursorRef.current
    if (cursor === null) return
    setIsPlaying(false)
    moveCursor(cursor, cursor.initial, 0)
    await notify({ type: 'reset', candle: cursor.initial })
    signal.throwIfAborted()
    updateCursor(cursor, { hasTrades: false, active: cursor.session.status !== 'completed' })
    await publish(cursor, true)
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
    await publish(cursor, true)
  }, `正在读取剩余的 ${sourceLabel} K 线…`), [advance, publish, queueSave, run, sourceLabel, stepTimeframe])

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
