import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import Decimal from 'decimal.js'
import type { MarketDataRuntime } from '../market-data/runtime'
import type {
  OrderPreview,
  OrderSizeInput,
  PositionSide,
  SimulationState,
} from './models'
import type {
  ReplayCandleEvent,
  ReplayController,
} from '../replay/useReplayController'
import { SimulationEngine } from './simulation-engine'

export interface SimulationController {
  state: SimulationState | null
  busy: boolean
  error: string
  preview(
    side: PositionSide,
    size: OrderSizeInput,
  ): Promise<OrderPreview | null>
  open(side: PositionSide, size: OrderSizeInput): Promise<void>
  reduce(quantity: string): Promise<void>
  reducePercent(percent: 25 | 50 | 75): Promise<void>
  closeAll(): Promise<void>
  setTakeProfit(price: string | null): void
  setStopLoss(price: string | null): void
  clearError(): void
}

export function useSimulationController(
  runtime: MarketDataRuntime,
  replay: ReplayController,
): SimulationController {
  const engineRef = useRef<SimulationEngine | null>(null)
  const sessionRef = useRef(replay.session)
  const saveQueueRef = useRef(Promise.resolve())
  const [state, setState] = useState<SimulationState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  sessionRef.current = replay.session

  const queueSave = useCallback(
    (next: SimulationState) => {
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(() => runtime.simulationStates.save(next))
        .catch((reason: unknown) => {
          setError(
            `自动保存模拟交易失败：${
              reason instanceof Error ? reason.message : String(reason)
            }`,
          )
        })
    },
    [runtime],
  )

  const publish = useCallback(
    (engine: SimulationEngine) => {
      const next = engine.snapshot()
      setState(next)
      replay.setHasTrades(next.trades.length > 0)
      queueSave(next)
    },
    [queueSave, replay.setHasTrades],
  )

  useEffect(() => {
    const session = replay.session
    let cancelled = false
    if (session === null) {
      engineRef.current = null
      setState(null)
      setBusy(false)
      return
    }
    setBusy(true)
    setError('')
    void runtime.simulationStates
      .load(session.id)
      .then((saved) => {
        if (cancelled) return
        const engine =
          saved === undefined
            ? SimulationEngine.create(session)
            : SimulationEngine.restore(saved, session)
        engineRef.current = engine
        publish(engine)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(
            `恢复模拟账户失败：${
              reason instanceof Error ? reason.message : String(reason)
            }`,
          )
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [publish, replay.session?.id, runtime])

  const processReplayEvent = useCallback(
    async (event: ReplayCandleEvent) => {
      const session = sessionRef.current
      if (session === null) return
      if (event.type === 'reset') {
        const engine = SimulationEngine.create(session)
        engineRef.current = engine
        publish(engine)
        return
      }
      const engine = engineRef.current
      if (engine === null) return
      let markCandle = null
      if (engine.snapshot().position !== null) {
        try {
          const markCandles = await runtime.service.loadCandles(
            'mark',
            session.symbol.ticker,
            session.period.text,
            event.candle.openTime,
            event.candle.openTime,
          )
          markCandle =
            markCandles.find(
              (candle) => candle.openTime === event.candle.openTime,
            ) ?? null
        } catch {
          markCandle = null
        }
      }
      engine.processCandle(event.candle, markCandle)
      publish(engine)
    },
    [publish, runtime],
  )

  useEffect(
    () => replay.subscribeCandle(processReplayEvent),
    [processReplayEvent, replay.subscribeCandle],
  )

  const currentCandle = useCallback(async () => {
    const session = sessionRef.current
    if (session === null) {
      throw new Error('请先创建历史回放会话')
    }
    const candles = await runtime.service.loadCandles(
      'trade',
      session.symbol.ticker,
      session.period.text,
      session.currentTime,
      session.currentTime,
    )
    const candle = candles.find(
      (item) => item.openTime === session.currentTime,
    )
    if (candle === undefined) {
      throw new Error('当前回放 K 线不存在')
    }
    return candle
  }, [runtime])

  const preview = useCallback(
    async (
      side: PositionSide,
      size: OrderSizeInput,
    ): Promise<OrderPreview | null> => {
      const engine = engineRef.current
      if (engine === null) {
        setError('模拟账户尚未准备完成')
        return null
      }
      try {
        const candle = await currentCandle()
        const result = engine.previewOpen(side, size, candle.close)
        setError('')
        return result
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
        return null
      }
    },
    [currentCandle],
  )

  const open = useCallback(
    async (side: PositionSide, size: OrderSizeInput) => {
      const engine = engineRef.current
      if (engine === null) {
        setError('模拟账户尚未准备完成')
        return
      }
      setBusy(true)
      try {
        const candle = await currentCandle()
        engine.open(side, size, candle)
        setError('')
        publish(engine)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [currentCandle, publish],
  )

  const reduce = useCallback(
    async (quantity: string) => {
      const engine = engineRef.current
      if (engine === null) return
      setBusy(true)
      try {
        const candle = await currentCandle()
        engine.reduce(quantity, candle)
        setError('')
        publish(engine)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [currentCandle, publish],
  )

  const reducePercent = useCallback(
    async (percent: 25 | 50 | 75) => {
      const position = engineRef.current?.snapshot().position
      if (position === null || position === undefined) {
        setError('当前没有持仓')
        return
      }
      const quantity = new Decimal(position.quantity)
        .mul(percent)
        .div(100)
        .toString()
      await reduce(quantity)
    },
    [reduce],
  )

  const closeAll = useCallback(async () => {
    const engine = engineRef.current
    if (engine === null) return
    setBusy(true)
    try {
      const candle = await currentCandle()
      engine.closeAll(candle)
      setError('')
      publish(engine)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [currentCandle, publish])

  const setTakeProfit = useCallback(
    (price: string | null) => {
      const engine = engineRef.current
      const session = sessionRef.current
      if (engine === null || session === null) return
      try {
        engine.setTakeProfit(price, session.currentTime)
        setError('')
        publish(engine)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    },
    [publish],
  )

  const setStopLoss = useCallback(
    (price: string | null) => {
      const engine = engineRef.current
      const session = sessionRef.current
      if (engine === null || session === null) return
      try {
        engine.setStopLoss(price, session.currentTime)
        setError('')
        publish(engine)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    },
    [publish],
  )

  return {
    state,
    busy,
    error,
    preview,
    open,
    reduce,
    reducePercent,
    closeAll,
    setTakeProfit,
    setStopLoss,
    clearError: () => setError(''),
  }
}
