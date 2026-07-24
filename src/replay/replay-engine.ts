import type { MarketCandle } from '../market-data/models'
import type {
  CreateReplaySessionInput,
  ReplaySession,
  ReplaySpeed,
} from './models'
import { DEFAULT_TRADING_CONFIG } from './models'

function normalizedCandles(
  candles: readonly MarketCandle[],
  input: CreateReplaySessionInput,
): MarketCandle[] {
  const symbol = input.symbol.ticker.toUpperCase()
  const unique = new Map<number, MarketCandle>()
  for (const candle of candles) {
    if (
      candle.symbol === symbol &&
      candle.timeframe === input.period.text &&
      candle.openTime >= input.startTime &&
      (input.endTime === undefined || candle.openTime <= input.endTime)
    ) {
      unique.set(candle.openTime, candle)
    }
  }
  return [...unique.values()].sort(
    (left, right) => left.openTime - right.openTime,
  )
}

export class ReplayEngine {
  private readonly candles: MarketCandle[]
  private session: ReplaySession

  private constructor(
    candles: readonly MarketCandle[],
    session: ReplaySession,
    private readonly now: () => number,
  ) {
    this.candles = [...candles]
    this.session = { ...session }
  }

  static create(
    input: CreateReplaySessionInput,
    candles: readonly MarketCandle[],
    options: { id?: string; now?: () => number } = {},
  ): ReplayEngine {
    const prepared = normalizedCandles(candles, input)
    if (prepared.length === 0) {
      throw new Error('所选区间没有可用于回放的 K 线')
    }
    const now = options.now ?? Date.now
    const timestamp = now()
    const session: ReplaySession = {
      schemaVersion: 2,
      id: options.id ?? crypto.randomUUID(),
      symbol: { ...input.symbol },
      period: { ...input.period },
      startTime: prepared[0].openTime,
      endTime: prepared.at(-1)!.openTime,
      currentTime: prepared[0].openTime,
      currentIndex: 0,
      candleCount: prepared.length,
      speed: input.speed ?? 1,
      status: prepared.length === 1 ? 'completed' : 'paused',
      hasTrades: false,
      active: true,
      tradingConfig: {
        ...(input.tradingConfig ?? DEFAULT_TRADING_CONFIG),
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    return new ReplayEngine(prepared, session, now)
  }

  static restore(
    session: ReplaySession,
    candles: readonly MarketCandle[],
    now: () => number = Date.now,
  ): ReplayEngine {
    const prepared = normalizedCandles(candles, session)
    if (prepared.length === 0) {
      throw new Error('回放会话对应的历史 K 线不存在')
    }
    const restoredIndex = prepared.findIndex(
      (candle) => candle.openTime === session.currentTime,
    )
    if (restoredIndex === -1) {
      throw new Error('回放会话当前时间不在本地历史数据中')
    }
    return new ReplayEngine(
      prepared,
      {
        ...session,
        schemaVersion: 2,
        tradingConfig: {
          ...(session.tradingConfig ?? DEFAULT_TRADING_CONFIG),
        },
        currentIndex: restoredIndex,
        candleCount: prepared.length,
        startTime: prepared[0].openTime,
        endTime: prepared.at(-1)!.openTime,
        status:
          restoredIndex === prepared.length - 1
            ? 'completed'
            : 'paused',
      },
      now,
    )
  }

  snapshot(): ReplaySession {
    return {
      ...this.session,
      symbol: { ...this.session.symbol },
      period: { ...this.session.period },
    }
  }

  currentCandle(): MarketCandle {
    return this.candles[this.session.currentIndex]
  }

  stepNext(): MarketCandle | null {
    if (this.session.currentIndex >= this.candles.length - 1) {
      this.update({ status: 'completed' })
      return null
    }
    const nextIndex = this.session.currentIndex + 1
    const candle = this.candles[nextIndex]
    this.update({
      currentIndex: nextIndex,
      currentTime: candle.openTime,
      status: nextIndex === this.candles.length - 1 ? 'completed' : 'paused',
    })
    return candle
  }

  stepPrevious(): MarketCandle | null {
    if (this.session.hasTrades || this.session.currentIndex === 0) {
      return null
    }
    const previousIndex = this.session.currentIndex - 1
    const candle = this.candles[previousIndex]
    this.update({
      currentIndex: previousIndex,
      currentTime: candle.openTime,
      status: 'paused',
    })
    return candle
  }

  reset(): MarketCandle {
    const candle = this.candles[0]
    this.update({
      currentIndex: 0,
      currentTime: candle.openTime,
      status: this.candles.length === 1 ? 'completed' : 'paused',
    })
    return candle
  }

  jumpToEnd(onCandle?: (candle: MarketCandle) => void): MarketCandle {
    let candle = this.currentCandle()
    while (this.session.currentIndex < this.candles.length - 1) {
      candle = this.stepNext()!
      onCandle?.(candle)
    }
    return candle
  }

  setSpeed(speed: ReplaySpeed): void {
    this.update({ speed })
  }

  setHasTrades(hasTrades: boolean): void {
    this.update({ hasTrades })
  }

  setActive(active: boolean): void {
    this.update({ active })
  }

  private update(changes: Partial<ReplaySession>): void {
    this.session = {
      ...this.session,
      ...changes,
      updatedAt: this.now(),
    }
  }
}
