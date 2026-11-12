import type { MarketCandle } from '../market-data/models'
import type {
  CreateReplaySessionInput,
  ReplaySession,
  ReplaySpeed,
} from './models'
import { DEFAULT_TRADING_CONFIG, replaySourceTimeframe } from './models'
import { findMissingRanges } from '../market-data/gaps'
import { klineCloseBoundary, nextOpenTime } from '../market-data/intervals'

function candleCount(from: number, to: number, timeframe: string): number {
  if (timeframe === '1M') {
    const first = new Date(from)
    const last = new Date(to)
    return (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth() + 1
  }
  if (timeframe === '3d') return Math.round((to - from) / (klineCloseBoundary(from, timeframe) - from)) + 1
  return Math.floor((to - from) / (nextOpenTime(from, timeframe) - from)) + 1
}

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
  private partialCandle?: MarketCandle

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
    options: { id?: string; now?: () => number; buffered?: boolean } = {},
  ): ReplayEngine {
    const prepared = normalizedCandles(candles, input)
    if (prepared.length === 0) {
      throw new Error('所选区间没有可用于回放的 K 线')
    }
    const now = options.now ?? Date.now
    const timestamp = now()
    const endTime = options.buffered ? input.endTime ?? prepared.at(-1)!.openTime : prepared.at(-1)!.openTime
    const session: ReplaySession = {
      schemaVersion: 2,
      id: options.id ?? crypto.randomUUID(),
      symbol: { ...input.symbol },
      period: { ...input.period },
      startTime: prepared[0].openTime,
      endTime,
      currentTime: prepared[0].openTime,
      currentIndex: 0,
      candleCount: options.buffered ? candleCount(prepared[0].openTime, endTime, input.period.text) : prepared.length,
      speed: input.speed ?? 1,
      status: prepared[0].openTime === endTime ? 'completed' : 'paused',
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
    options: { buffered?: boolean } = {},
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
        candleCount: options.buffered ? candleCount(prepared[0].openTime, session.endTime, session.period.text) : prepared.length,
        startTime: prepared[0].openTime,
        endTime: options.buffered ? session.endTime : prepared.at(-1)!.openTime,
        status:
          session.currentTime === (options.buffered ? session.endTime : prepared.at(-1)!.openTime)
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
    return this.partialCandle ?? this.candles[this.session.currentIndex]
  }

  bufferedCandles(): readonly MarketCandle[] { return this.candles }

  seekVisible(visibleUntil: number, partialCandle?: MarketCandle): void {
    const timeframe = replaySourceTimeframe(this.session)
    const close = (index: number) => klineCloseBoundary(this.candles[index].openTime, timeframe)
    let index = this.session.currentIndex
    while (index > 0 && close(index) > visibleUntil) index -= 1
    while (index < this.candles.length - 1 && close(index + 1) <= visibleUntil) index += 1
    const currentTime = this.candles[index].openTime
    this.partialCandle = partialCandle
    this.update({
      currentIndex: index, currentTime,
      visibleUntil: partialCandle === undefined ? undefined : visibleUntil,
      status: currentTime === this.session.endTime ? 'completed' : 'paused',
    })
  }

  appendCandles(candles: readonly MarketCandle[]): void {
    const timeframe = replaySourceTimeframe(this.session)
    const from = nextOpenTime(this.candles.at(-1)!.openTime, timeframe)
    const prepared = normalizedCandles(candles, { ...this.session, startTime: from })
    if (prepared.length === 0) return
    if (findMissingRanges(prepared, timeframe, from, prepared.at(-1)!.openTime).length > 0) {
      throw new Error('下一段回放数据仍有缺口')
    }
    // Append individually: a month of 1m rows can exceed JS argument limits.
    for (const candle of prepared) this.candles.push(candle)
  }

  stepNext(): MarketCandle | null {
    if (this.session.currentIndex >= this.candles.length - 1) {
      if (this.session.currentTime < this.session.endTime) throw new Error('需要先准备下一段回放数据')
      this.update({ status: 'completed' })
      return null
    }
    const nextIndex = this.session.currentIndex + 1
    const candle = this.candles[nextIndex]
    this.partialCandle = undefined
    this.update({
      currentIndex: nextIndex,
      currentTime: candle.openTime,
      visibleUntil: undefined,
      status: candle.openTime === this.session.endTime ? 'completed' : 'paused',
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
    this.partialCandle = undefined
    this.update({
      currentIndex: 0,
      currentTime: candle.openTime,
      visibleUntil: undefined,
      status: candle.openTime === this.session.endTime ? 'completed' : 'paused',
    })
    return candle
  }

  jumpToEnd(onCandle?: (candle: MarketCandle) => void): MarketCandle {
    if (this.candles.at(-1)!.openTime < this.session.endTime) throw new Error('需要先准备剩余回放数据')
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
