import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isCTraderTimeframe } from '../market-data/intervals'
import { cTraderLeverage } from '../simulation/ctrader-trading'
import { OKX_SIMULATION_TAKER_FEE, okxMaximumLeverage, type OkxReplayRisk, type ReplayTradingTerms } from '../simulation/okx-trading'
import { validateSimulationConfig } from '../simulation/simulation-engine'
import { cmeTradingBounds, cmeTradingDay } from '../market-data/databento/trading-day'
import { defaultCmeFeePerContractSide } from '../simulation/cme-fees'
import type { ReplaySessionStore } from '../storage/replay-session-store'
import { CTraderReplayBars, loadClosedReplayBars, type CTraderReplayMarket } from './ctrader-replay-bars'
import { CTraderReplayTicks, type ReplayPriceCandle } from './ctrader-replay-ticks'
import { DEFAULT_TRADING_CONFIG, isTickSpeed, sessionPlaybackMode, sessionVisibleUntil, type CreateReplaySessionInput, type ReplayMode, type ReplaySession, type ReplaySpeed } from './models'
import { isCTraderReplayStepPeriod, isFineStepPeriod, type CTraderReplayStepPeriod, type ReplayStepPeriod } from './step-periods'
import type { ReplayCandleEvent, ReplayCandleListener, ReplayController } from './useReplayController'
import type { MarketCandle } from '../market-data/models'
import { isLocalPriceSource, isOkxPriceSource, isPriceSource, priceSourceLabel } from '../market-data/price-source-preferences'
import type { SimulationStateStore } from '../storage/simulation-state-store'

interface CTraderReplayRuntime {
  service: CTraderReplayMarket & {
    getReplayTradingTerms(symbol: string, start: number, signal?: AbortSignal): Promise<ReplayTradingTerms | undefined>
    contractAt?(symbol: string, timestamp: number, signal?: AbortSignal): Promise<string | undefined>
    getReplayRisk?(candle: MarketCandle, from: number, signal: AbortSignal): Promise<OkxReplayRisk>
  }
  replaySessions: Omit<ReplaySessionStore, 'getLatestActive'>
  replayTicks?: CTraderReplayTicks
  simulationStates?: SimulationStateStore
}

interface ReplayCursor {
  session: ReplaySession
  candle: ReplayPriceCandle
  initial: ReplayPriceCandle
  contractWindow?: { from: number; to: number }
  archiveEnd?: { revision: number | undefined; time: number }
}

interface TickClock {
  cursor: ReplayCursor
  marketTime: number
  wallTime: number | null
  speed: number
}

interface ReplayOperation {
  controller: AbortController
  foreground: boolean
  settled: Promise<void>
}

const FRAME_MS = 16
const MAX_TICKS_PER_FRAME = 4096
const MAX_DELAY_MS = 2_147_483_647
const tickTime = (candle: ReplayPriceCandle) => (candle.tickTimeUs ?? candle.openTime * 1000) / 1000

function clockTime(clock: TickClock, now = performance.now()): number {
  return clock.marketTime + (clock.wallTime === null ? 0 : (now - clock.wallTime) * clock.speed)
}

function waitForStep<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void
  return new Promise<T>((resolve, reject) => {
    abort = () => reject(signal.reason)
    request.then(resolve, reject)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  }).finally(() => signal.removeEventListener('abort', abort))
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
    endTime: Math.max(cursor.session.endTime, candle.closeTime, cursor.archiveEnd?.time ?? 0),
    status: 'paused',
  })
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function stepPeriod(session: ReplaySession, fineSteps: boolean, requested?: ReplayStepPeriod): CTraderReplayStepPeriod {
  if (requested === 'tick' && session.playbackMode === 'kline') return '1m'
  if (requested !== undefined && isCTraderReplayStepPeriod(requested) &&
      (fineSteps || !isFineStepPeriod(requested))) return requested
  const cursorPeriod = session.cursorTimeframe
  if (cursorPeriod !== undefined && !isFineStepPeriod(cursorPeriod)) return cursorPeriod
  return isCTraderTimeframe(session.period.text) ? session.period.text : '1m'
}

export function useCTraderReplayController(
  runtime: CTraderReplayRuntime,
  stepTimeframe?: ReplayStepPeriod,
  historyRevision = runtime.service.historyRevision,
): ReplayController<ReplayStepPeriod> & {
  supportsTicks: boolean
  mode: ReplayMode
  tradeUntilUs?: number
  endNotice: string
  dismissEndNotice(): void
  setMode(mode: ReplayMode): void
  setTickSpeed(speed: number): void
} {
  const { service, replaySessions, replayTicks, simulationStates } = runtime
  const source = service.source ?? 'ctrader'
  const supportsTicks = service.loadTicks !== undefined
  const legacyTick = source === 'ctrader' && stepTimeframe === 'tick'
  const sourceLabel = priceSourceLabel(source)
  const history = useMemo(() => new CTraderReplayBars(service), [service])
  const ticks = useMemo(() => replayTicks ?? new CTraderReplayTicks(service, history), [replayTicks, service, history])
  const cursorRef = useRef<ReplayCursor | null>(null)
  const clockRef = useRef<TickClock | null>(null)
  const operationRef = useRef<ReplayOperation | null>(null)
  const lifecycle = useRef(0)
  const listeners = useRef(new Set<ReplayCandleListener>())
  const saveQueue = useRef(Promise.resolve())
  const [view, setView] = useState<{ session: ReplaySession; tradeUntilUs?: number } | null>(null)
  const session = view?.session ?? null
  const [sessions, setSessions] = useState<ReplaySession[]>([])
  const [busy, setBusy] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [endNotice, setEndNotice] = useState('')
  const [waiting, setWaiting] = useState<{ period: CTraderReplayStepPeriod; revision: number | undefined }>()
  const [error, setError] = useState('')
  const [preparationStatus, setPreparationStatus] = useState('')
  const mode = session !== null && supportsTicks ? sessionPlaybackMode(session, legacyTick) : 'kline'

  const pause = useCallback(() => {
    const clock = clockRef.current
    if (clock !== null) {
      clock.marketTime = clockTime(clock)
      clock.wallTime = null
    }
    const operation = operationRef.current
    if (operation && !operation.foreground) operation.controller.abort()
    setIsPlaying(false)
    setWaiting(undefined)
  }, [])

  const waitForHistory = useCallback((period: CTraderReplayStepPeriod, revision: number | undefined) => {
    setWaiting({ period, revision })
    setEndNotice(period === 'tick' || period === '1m'
      ? '已到达当前回放数据末尾。'
      : '当前步进周期已没有下一根完整 K 线。可以尝试更小的步进周期。')
  }, [])

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
    setView({ session: saved, tradeUntilUs: cursor.candle.tradeUntilUs })
    remember(saved)
  }, [queueSave, remember])

  const notify = useCallback(async (event: ReplayCandleEvent, targets: Iterable<ReplayCandleListener> = listeners.current) => {
    for (const listener of targets) await listener(event)
  }, [])

  const run = useCallback(async (
    description: string,
    work: (signal: AbortSignal) => Promise<void>,
    loading = '',
    foreground = true,
  ) => {
    const pending = operationRef.current
    if (pending !== null) {
      if (!foreground || pending.foreground) return
      const activeLifecycle = lifecycle.current
      pause()
      await pending.settled
      if (lifecycle.current !== activeLifecycle || operationRef.current !== null) return
    }
    const controller = new AbortController()
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    const operation = { controller, foreground, settled }
    operationRef.current = operation
    if (foreground) setBusy(true)
    setError('')
    setPreparationStatus(loading)
    try {
      await work(controller.signal)
    } catch (reason) {
      if (!controller.signal.aborted) {
        pause()
        setError(`${description}：${message(reason)}`)
      }
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null
        if (foreground) setBusy(false)
        setPreparationStatus('')
      }
      settle()
    }
  }, [pause])

  const hydrate = useCallback(async (saved: ReplaySession, signal: AbortSignal): Promise<ReplayCursor> => {
    if (saved.marketSource !== source) {
      const origin = isPriceSource(saved.marketSource) ? priceSourceLabel(saved.marketSource) : '币安'
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
      setSessions(saved.filter(item => source === 'ctrader' ? !isPriceSource(item.marketSource) || item.marketSource === 'ctrader' : item.marketSource === source))
      if (isLocalPriceSource(source)) return
      const active = saved.find(item => item.active && item.status !== 'completed' && item.marketSource === source)
      if (active !== undefined) {
        const cursor = await hydrate(active, signal)
        signal.throwIfAborted()
        cursorRef.current = cursor
        setView({ session: active, tradeUntilUs: cursor.candle.tradeUntilUs })
      }
    })
    return () => {
      lifecycle.current++
      operationRef.current?.controller.abort()
      operationRef.current = null
      cursorRef.current = null
      clockRef.current = null
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
    clockRef.current = null
    cursorRef.current = cursor
    setEndNotice('')
    setView({ session: cursor.session, tradeUntilUs: cursor.candle.tradeUntilUs })
    remember(cursor.session)
  }, [queueSave, remember, replaySessions])

  const createSession = useCallback((input: CreateReplaySessionInput) => run(
    '创建回放失败',
    async signal => {
      const revision = service.historyRevision
      const bounds = await service.historyBounds?.(input.symbol.ticker, signal)
      if (service.historyBounds && !bounds) throw new Error('请先在本地数据管理中添加此品种的逐笔成交归档。')
      const endTime = Math.min(input.endTime ?? Date.now(), Date.now() - 1, bounds?.to ?? Infinity)
      if (!Number.isSafeInteger(input.startTime) || !Number.isSafeInteger(endTime) || input.startTime >= endTime) {
        throw new Error('回放结束时间必须晚于图表起点')
      }
      pause()
      const candle = await history.find(input.symbol.ticker, input.period.text, input.startTime, endTime, 1, signal)
      if (candle === undefined) throw new Error('所选区间没有已收盘的 K 线，请将图表移到更早的时间。')
      const terms = source === 'databento-cme' ? undefined : await service.getReplayTradingTerms(input.symbol.ticker, candle.openTime, signal)
      const economics = !terms ? {
        leverage: input.leverage ?? DEFAULT_TRADING_CONFIG.leverage,
        feeRate: '0', maintenanceMarginRate: '0', liquidationFeeRate: '0',
      } : 'tickSize' in terms ? {
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
        ...(source === 'databento-cme' && {
          cmeFeePerContractSide: defaultCmeFeePerContractSide(input.symbol.ticker) ?? input.cmeFeePerContractSide ?? null,
        }),
      }
      validateSimulationConfig(tradingConfig)
      signal.throwIfAborted()
      const now = Date.now()
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
        ...(input.playbackMode !== undefined && {
          playbackMode: supportsTicks ? input.playbackMode : 'kline',
        }),
        speed: input.speed ?? 1,
        status: 'paused',
        active: true,
        hasTrades: false,
        tradingConfig: { ...tradingConfig },
        createdAt: now,
        updatedAt: now,
      }
      await activate({ session: next, candle, initial: candle,
        ...(source === 'databento-cme' && bounds && { archiveEnd: { revision, time: endTime } }),
      }, signal, true)
    },
    source === 'databento-cme' ? '正在准备 CME 历史回放…'
      : `正在准备回放行情和 ${isOkxPriceSource(source) ? 'OKX' : 'IC Markets'} 交易规格…`,
  ), [activate, history, pause, run, service, source, supportsTicks])

  const loadSession = useCallback((id: string) => run('加载回放会话失败', async signal => {
    pause()
    await saveQueue.current
    const saved = await replaySessions.get(id)
    if (saved === undefined) throw new Error('找不到所选回放会话')
    const cursor = await hydrate(saved, signal)
    // An archived result can be opened explicitly for review or reset.
    updateCursor(cursor, { active: saved.status !== 'completed' })
    await activate(cursor, signal)
  }, `正在读取会话的 ${sourceLabel} K 线…`), [activate, hydrate, pause, replaySessions, run, sourceLabel])

  const endSession = useCallback(async () => {
    const activeLifecycle = lifecycle.current
    const pending = operationRef.current
    pause()
    pending?.controller.abort()
    if (pending) {
      setBusy(true)
      await pending.settled
    }
    if (lifecycle.current !== activeLifecycle) return
    const cursor = cursorRef.current
    cursorRef.current = null
    clockRef.current = null
    setEndNotice('')
    setView(null)
    setBusy(false)
    setPreparationStatus('')
    if (cursor !== null) {
      updateCursor(cursor, { active: false })
      remember(cursor.session)
      await queueSave(cursor.session)
    }
  }, [pause, queueSave, remember])

  const deleteSession = useCallback((id: string) => run('删除回放会话失败', async () => {
    if (cursorRef.current !== null) return
    await saveQueue.current
    await replaySessions.delete(id)
    setSessions(current => current.filter(item => item.id !== id))
  }), [replaySessions, run])

  const followingStep = useCallback(async (cursor: ReplayCursor, timeframe: CTraderReplayStepPeriod, signal: AbortSignal) => {
    const { session: saved } = cursor
    const tickIndex = timeframe === 'tick' ? saved.cursorTickIndex : undefined
    const from = tickIndex === undefined ? sessionVisibleUntil(saved) : saved.currentTime
    for (;;) {
      signal.throwIfAborted()
      const revision = service.historyRevision
      if (source === 'databento-cme' && service.historyBounds &&
          (!cursor.archiveEnd || cursor.archiveEnd.revision !== revision)) {
        const bounds = await service.historyBounds(saved.symbol.ticker, signal)
        if (revision !== service.historyRevision) continue
        cursor.archiveEnd = { revision, time: Math.min(bounds?.to ?? -1, Date.now() - 1) }
      }
      const candle = await findStep(saved.symbol.ticker, timeframe, from, cursor.archiveEnd?.time ?? saved.endTime,
        1, signal, tickIndex)
      if (revision === service.historyRevision) return { candle, revision }
    }
  }, [findStep, service, source])

  const applyStep = useCallback(async (cursor: ReplayCursor, candle: ReplayPriceCandle, signal: AbortSignal, canAdvance?: () => boolean) => {
    const { session: saved, contractWindow } = cursor
    if (source === 'databento-cme' && saved.hasTrades && service.contractAt &&
      !(contractWindow && cursor.candle.closeTime >= contractWindow.from && candle.closeTime < contractWindow.to)) {
      const currentWindow = cmeTradingBounds(cmeTradingDay(cursor.candle.closeTime))
      const ticker = saved.symbol.ticker
      if (candle.closeTime >= currentWindow.to) {
        // Settle the prices before the roll so the position check reads the latest state.
        if (canAdvance) await notify({ type: 'flush', candle: cursor.candle })
        const [before, after] = await Promise.all([
          service.contractAt(ticker, cursor.candle.closeTime, signal), service.contractAt(ticker, candle.closeTime, signal),
        ])
        if (before && after && before !== after && (await simulationStates?.load(saved.id))?.positions.length) {
          throw new Error(`主力即将从 ${before} 切到 ${after}，请先平掉模拟持仓再继续回放。`)
        }
      }
      cursor.contractWindow = cmeTradingBounds(cmeTradingDay(candle.closeTime))
    }
    const sameTimeTick = candle.tickIndex !== undefined && saved.cursorTickIndex !== undefined && candle.openTime === saved.currentTime
    const okxRisk = isOkxPriceSource(source) && saved.hasTrades ? await service.getReplayRisk?.(candle, sessionVisibleUntil(saved), signal) : undefined
    signal.throwIfAborted()
    if (canAdvance && !canAdvance()) return
    moveCursor(cursor, candle, saved.currentIndex + 1)
    await notify({ type: 'advance', candle, ...(sameTimeTick ? { sameTimeTick: true } : {}),
      ...(okxRisk && { okxRisk }), ...(canAdvance && { deferPublish: true }) })
  }, [notify, service, simulationStates, source])

  const advance = useCallback(async (cursor: ReplayCursor, timeframe: CTraderReplayStepPeriod, signal: AbortSignal) => {
    const saved = cursor.session
    const { candle, revision } = await followingStep(cursor, timeframe, signal)
    signal.throwIfAborted()
    if (candle === undefined) {
      waitForHistory(timeframe, revision)
      return false
    }
    // Publish the reached cursor even if simulation reports an error, so a
    // retry cannot replay the same candle against already updated positions.
    try {
      await applyStep(cursor, candle, signal)
    } catch (reason) {
      if (!signal.aborted && cursor.session !== saved) await publish(cursor)
      throw reason
    }
    setWaiting(undefined)
    setEndNotice('')
    return true
  }, [applyStep, followingStep, publish, waitForHistory])

  const next = useCallback((timeframe = stepTimeframe) => run('推进回放失败', async signal => {
    const cursor = cursorRef.current
    if (cursor === null || cursor.session.status === 'completed' || cursor.session.playbackMode === 'tick') return
    clockRef.current = null
    const moved = await advance(cursor, stepPeriod(cursor.session, supportsTicks, timeframe), signal)
    signal.throwIfAborted()
    if (moved) await publish(cursor)
  }), [advance, publish, run, stepTimeframe, supportsTicks])

  const previous = useCallback((timeframe = stepTimeframe) => run('回退回放失败', async signal => {
    const cursor = cursorRef.current
    if (cursor === null || cursor.session.hasTrades || cursor.candle.closeTime === cursor.initial.closeTime ||
      cursor.session.playbackMode === 'tick') return
    pause()
    setEndNotice('')
    clockRef.current = null
    const { session: saved, initial } = cursor
    const period = stepPeriod(saved, supportsTicks, timeframe)
    const tickIndex = period === 'tick' ? saved.cursorTickIndex : undefined
    const candle = await findStep(
      saved.symbol.ticker, period, initial.closeTime + 1,
      tickIndex === undefined ? cursor.candle.closeTime - 1 : saved.currentTime, -1, signal, tickIndex,
    )
    signal.throwIfAborted()
    moveCursor(cursor, candle ?? initial, candle === undefined ? 0 : Math.max(1, saved.currentIndex - 1))
    if (!saved.active && cursor.session.status === 'paused') updateCursor(cursor, { active: true })
    await publish(cursor)
  }), [findStep, pause, publish, run, stepTimeframe, supportsTicks])

  const reset = useCallback(() => run('重置回放失败', async signal => {
    const cursor = cursorRef.current
    if (cursor === null) return
    pause()
    setEndNotice('')
    clockRef.current = null
    moveCursor(cursor, cursor.initial, 0)
    await notify({ type: 'reset', candle: cursor.initial })
    signal.throwIfAborted()
    updateCursor(cursor, { hasTrades: false, active: true })
    await publish(cursor)
  }), [notify, pause, publish, run])

  const jumpToEnd = useCallback(() => run('跳转回放失败', async signal => {
    const cursor = cursorRef.current
    if (cursor?.session.status !== 'paused' || sessionPlaybackMode(cursor.session, legacyTick) === 'tick') return
    pause()
    clockRef.current = null
    const timeframe = stepPeriod(cursor.session, supportsTicks, stepTimeframe)
    while (true) {
      const moved = await advance(cursor, timeframe, signal)
      signal.throwIfAborted()
      if (!moved) break
      // Save the cursor after each durable simulation update.
      await queueSave(cursor.session)
    }
    await publish(cursor)
  }, `正在读取剩余的 ${sourceLabel} K 线…`), [advance, legacyTick, pause, publish, queueSave, run, sourceLabel, stepTimeframe, supportsTicks])

  const setSpeed = useCallback((speed: ReplaySpeed) => {
    const cursor = cursorRef.current
    if (cursor === null || operationRef.current !== null) return
    updateCursor(cursor, { speed })
    void publish(cursor)
  }, [publish])

  const setMode = useCallback((playbackMode: ReplayMode) => {
    const cursor = cursorRef.current
    if (cursor === null || busy || (playbackMode === 'tick' && !supportsTicks)) return
    pause()
    setEndNotice('')
    clockRef.current = null
    updateCursor(cursor, { playbackMode })
    setView(current => current?.session.id === cursor.session.id
      ? { ...current, session: { ...current.session, playbackMode } } : current)
    if (operationRef.current === null) void publish(cursor)
  }, [busy, pause, publish, supportsTicks])

  const setTickSpeed = useCallback((speed: number) => {
    const cursor = cursorRef.current
    if (cursor === null || !isTickSpeed(speed) || (cursor.session.tickSpeed ?? 1) === speed) return
    const clock = clockRef.current
    if (clock?.cursor === cursor) {
      const now = performance.now()
      clock.marketTime = clockTime(clock, now)
      if (clock.wallTime !== null) clock.wallTime = now
      clock.speed = speed
    }
    updateCursor(cursor, { tickSpeed: speed })
    setView(current => current?.session.id === cursor.session.id
      ? { ...current, session: { ...current.session, tickSpeed: speed } } : current)
    if (operationRef.current === null) void publish(cursor)
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
    const cursor = cursorRef.current
    if (cursor?.session.status !== 'paused') return
    if (supportsTicks && sessionPlaybackMode(cursor.session, legacyTick) === 'tick') {
      let clock = clockRef.current
      if (clock?.cursor !== cursor) {
        clock = {
          cursor,
          marketTime: cursor.candle.tickIndex === undefined ? sessionVisibleUntil(cursor.session) : tickTime(cursor.candle),
          wallTime: null,
          speed: cursor.session.tickSpeed ?? 1,
        }
        clockRef.current = clock
      }
      clock.wallTime ??= performance.now()
    }
    setWaiting(undefined)
    setIsPlaying(true)
  }, [legacyTick, supportsTicks])

  const autoPeriod = session && (mode === 'tick' ? 'tick' : stepPeriod(session, supportsTicks, stepTimeframe))
  const waitingForHistory = waiting !== undefined && waiting.period === autoPeriod && waiting.revision === historyRevision

  useEffect(() => {
    if (mode !== 'kline' || !isPlaying || busy || waitingForHistory || session?.status !== 'paused') return
    const timeout = window.setTimeout(() => void next(), 1000 / session.speed)
    return () => window.clearTimeout(timeout)
  }, [busy, isPlaying, mode, next, session, waitingForHistory])

  useEffect(() => {
    const clock = clockRef.current
    if (mode !== 'tick' || !isPlaying || waitingForHistory || !clock) return
    const { cursor } = clock
    clock.wallTime ??= performance.now()
    let cancelled = false
    let timer: number
    let buffered: { revision: number | undefined; candle: ReplayPriceCandle | undefined } | undefined
    const playing = () => !cancelled && clock.wallTime !== null && cursorRef.current === cursor

    const frame = async () => {
      let delay = FRAME_MS
      await run('逐笔回放失败', async signal => {
        const before = cursor.session
        const frameListeners = [...listeners.current]
        const frameEnd = performance.now() + FRAME_MS / 2
        try {
          for (let count = 0; count < MAX_TICKS_PER_FRAME; count++) {
            if (!playing()) break
            const revision = service.historyRevision
            if (!buffered || revision !== buffered.revision) {
              const requestedAt = performance.now()
              buffered = await waitForStep(followingStep(cursor, 'tick', signal), signal)
              const loadedAt = performance.now()
              if (clock.wallTime !== null && loadedAt - requestedAt > FRAME_MS) {
                // A slow history read stalls the replay clock, so the next trades
                // keep their original spacing when the data becomes available.
                clock.wallTime += loadedAt - Math.max(requestedAt, clock.wallTime)
              }
            }
            signal.throwIfAborted()
            if (!playing()) break
            if (buffered.revision !== service.historyRevision) {
              buffered = undefined
              break
            }
            const candle = buffered.candle
            if (candle === undefined) {
              clock.marketTime = cursor.candle.tickIndex === undefined ? sessionVisibleUntil(cursor.session) : tickTime(cursor.candle)
              clock.wallTime = null
              waitForHistory('tick', buffered.revision)
              break
            }
            const target = tickTime(candle)
            const due = clockTime(clock)
            if (target > due) {
              delay = Math.max(FRAME_MS, (target - due) / clock.speed)
              break
            }
            await applyStep(cursor, candle, signal, playing)
            buffered = undefined
            if (performance.now() >= frameEnd) break
          }
        } finally {
          try {
            if (cursor.session.currentIndex !== before.currentIndex) {
              await notify({ type: 'flush', candle: cursor.candle }, frameListeners)
            }
          } finally {
            let saved = before
            while (cursor.session !== saved) {
              saved = cursor.session
              await publish(cursor)
            }
          }
        }
      }, '', false)
      if (playing()) {
        timer = window.setTimeout(() => void frame(), Math.min(MAX_DELAY_MS, delay))
      }
    }
    timer = window.setTimeout(() => void frame(), 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [applyStep, followingStep, historyRevision, isPlaying, mode, notify, publish, run, service, session?.tickSpeed,
    waitingForHistory, waitForHistory])

  return {
    session, sessions, busy, isPlaying, error, preparationStatus, mode, supportsTicks, tradeUntilUs: view?.tradeUntilUs,
    endNotice, dismissEndNotice: () => setEndNotice(''),
    createSession, loadSession, deleteSession, endSession, next, previous, reset, jumpToEnd,
    play, pause, setSpeed, setMode, setTickSpeed, setHasTrades, subscribeCandle, clearError: () => setError(''), getCurrentCandle,
  }
}
