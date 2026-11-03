import type { KLineData } from 'klinecharts'
import { createBrowserRequestGuard, SocketCooldownError } from './request-guard'
import type { CandleKind, MarketCandle } from './models'
import type { LiveMarketStatus } from './live-models'
import { INITIAL_LIVE_STATUS } from './live-models'
import { normalizeKline } from './normalizer'

export const DEFAULT_STREAM_BASE_URL = 'wss://fstream.binance.com/market'
const MAX_RECONNECT_DELAY = 60_000
const MAX_RECONNECT_ATTEMPTS = 3

interface LiveMarketDataService {
  saveRealtimeCandle(
    kind: CandleKind,
    candle: MarketCandle,
  ): Promise<void>
}

interface WebSocketLike {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  close(): void
  send(data: string): void
}

type SocketFactory = (url: string) => WebSocketLike
type Schedule = (callback: () => void, milliseconds: number) => number
type CancelSchedule = (id: number) => void

interface ParsedLiveKline {
  kind: CandleKind
  eventTime: number
  candle: MarketCandle
}

interface BinanceLivePayload {
  data?: unknown
  e?: unknown
  E?: unknown
  s?: unknown
  k?: unknown
  p?: unknown
}

interface BinanceLiveKline {
  t?: unknown
  T?: unknown
  s?: unknown
  i?: unknown
  o?: unknown
  h?: unknown
  l?: unknown
  c?: unknown
  v?: unknown
  q?: unknown
  n?: unknown
  x?: unknown
}

function finiteNumber(value: unknown, field: string): number {
  const result = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(result)) {
    throw new Error(`实时行情中的 ${field} 不是有效数字`)
  }
  return result
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`实时行情缺少 ${field}`)
  }
  return value
}

function unwrapPayload(payload: unknown): BinanceLivePayload {
  const wrapper = payload as BinanceLivePayload | null
  const raw =
    wrapper !== null &&
    typeof wrapper === 'object' &&
    wrapper.data !== undefined
      ? (wrapper.data as BinanceLivePayload)
      : wrapper
  if (raw === null || typeof raw !== 'object') {
    throw new Error('实时行情消息格式无效')
  }
  return raw
}

export function parseLiveMarkPrice(payload: unknown) {
  const raw = unwrapPayload(payload)
  if (raw.e !== 'markPriceUpdate') throw new Error('实时行情标记价格事件无效')
  const price = requiredString(raw.p, 'markPrice')
  if (finiteNumber(price, 'markPrice') <= 0) throw new Error('实时行情标记价格无效')
  return {
    symbol: requiredString(raw.s, 'symbol').toUpperCase(),
    eventTime: finiteNumber(raw.E, 'eventTime'),
    price,
  }
}

export function parseLiveKline(payload: unknown): ParsedLiveKline {
  const raw = unwrapPayload(payload)
  const eventType = requiredString(raw.e, 'eventType')
  if (eventType !== 'kline') throw new Error(`不支持的实时行情事件：${eventType}`)
  const kind: CandleKind = 'trade'
  const kline = raw.k as BinanceLiveKline | null
  if (kline === null || typeof kline !== 'object') {
    throw new Error('实时行情缺少 K 线数据')
  }
  if (typeof kline.x !== 'boolean') {
    throw new Error('实时行情缺少 K 线完成状态')
  }
  const symbol = requiredString(kline.s ?? raw.s, 'symbol').toUpperCase()
  const timeframe = requiredString(kline.i, 'interval')
  const closeTime = finiteNumber(kline.T, 'closeTime')
  const candle = normalizeKline(
    [
      finiteNumber(kline.t, 'openTime'),
      requiredString(kline.o, 'open'),
      requiredString(kline.h, 'high'),
      requiredString(kline.l, 'low'),
      requiredString(kline.c, 'close'),
      requiredString(kline.v, 'volume'),
      closeTime,
      requiredString(kline.q, 'quoteVolume'),
      finiteNumber(kline.n, 'tradeCount'),
    ],
    symbol,
    timeframe,
    kind,
    kline.x ? closeTime + 1 : closeTime,
  )
  candle.isClosed = kline.x
  return {
    kind,
    eventTime: finiteNumber(raw.E, 'eventTime'),
    candle,
  }
}

function toKLineData(candle: MarketCandle): KLineData {
  return {
    timestamp: candle.openTime,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume),
    turnover: Number(candle.quoteVolume),
  }
}

export interface LiveStreamSubscriptionInput {
  symbol: string
  timeframe: string
  onKline(data: KLineData): void
  onStatus(status: LiveMarketStatus): void
}

export class BinanceLiveStream {
  private readonly subscriptions = new Set<{
    input: LiveStreamSubscriptionInput
    status: LiveMarketStatus
  }>()
  private socket: WebSocketLike | null = null
  private connecting = false
  private stopped = false
  private keepAlive = false
  private generation = 0
  private reconnectTimer: number | null = null
  private subscriptionTimer: number | null = null
  private readonly activeStreams = new Set<string>()
  private requestId = 0
  private openedAt: number | null = null
  private status: LiveMarketStatus = { ...INITIAL_LIVE_STATUS }

  constructor(
    private readonly service: LiveMarketDataService,
    private readonly socketFactory: SocketFactory = (url) =>
      new WebSocket(url) as unknown as WebSocketLike,
    private readonly now: () => number = Date.now,
    private readonly schedule: Schedule = (callback, milliseconds) =>
      window.setTimeout(callback, milliseconds),
    private readonly cancelSchedule: CancelSchedule = (id) =>
      window.clearTimeout(id),
    private readonly baseUrl = DEFAULT_STREAM_BASE_URL,
    private readonly authorizeSocket: () => Promise<void> = () =>
      createBrowserRequestGuard().authorizeSocket(),
  ) {}

  setKeepAlive(enabled: boolean): void {
    this.keepAlive = enabled
    if (!enabled && this.subscriptions.size === 0) this.disconnect()
  }

  subscribe(input: LiveStreamSubscriptionInput): () => void {
    const subscription = {
      input: { ...input, symbol: input.symbol.toUpperCase() },
      status: { ...this.status },
    }
    this.subscriptions.add(subscription)
    input.onStatus({ ...subscription.status })
    if (this.socket !== null) this.scheduleSubscriptionUpdate()
    else if (!this.stopped && !this.connecting && this.reconnectTimer === null) void this.connect(false)

    return () => {
      if (!this.subscriptions.delete(subscription)) return
      if (this.subscriptions.size === 0) {
        if (!this.keepAlive) this.disconnect()
      } else {
        this.scheduleSubscriptionUpdate()
      }
    }
  }

  private publish(patch: Partial<LiveMarketStatus>): void {
    this.status = { ...this.status, ...patch }
    for (const subscription of this.subscriptions) {
      subscription.status = { ...subscription.status, ...patch }
      subscription.input.onStatus({ ...subscription.status })
    }
  }

  private desiredStreams(): Set<string> {
    const streams = new Set<string>()
    for (const { input } of this.subscriptions) {
      const symbol = input.symbol.toLowerCase()
      streams.add(`${symbol}@kline_${input.timeframe}`)
      streams.add(`${symbol}@markPrice@1s`)
    }
    return streams
  }

  private scheduleSubscriptionUpdate(): void {
    if (this.subscriptionTimer !== null || this.status.connection !== 'connected') return
    const desired = this.desiredStreams()
    if (desired.size === this.activeStreams.size && [...desired].every((stream) => this.activeStreams.has(stream))) return
    // Coalesce rapid period/symbol changes and keep control messages paced.
    this.subscriptionTimer = this.schedule(() => {
      this.subscriptionTimer = null
      if (this.socket === null || this.subscriptions.size === 0) return
      const desired = this.desiredStreams()
      const added = [...desired].filter((stream) => !this.activeStreams.has(stream))
      const removed = [...this.activeStreams].filter((stream) => !desired.has(stream))
      try {
        for (const [method, params] of [['SUBSCRIBE', added], ['UNSUBSCRIBE', removed]] as const) {
          if (params.length > 0) this.socket.send(JSON.stringify({ method, params, id: String(++this.requestId) }))
        }
        this.activeStreams.clear()
        desired.forEach((stream) => this.activeStreams.add(stream))
      } catch {
        this.failSocket('实时订阅切换失败，等待重新连接。')
      }
    }, 500)
  }

  private async connect(reconnecting: boolean): Promise<void> {
    if (this.subscriptions.size === 0 || this.connecting || this.socket !== null) return
    const generation = this.generation
    this.connecting = true
    this.publish({ connection: reconnecting ? 'reconnecting' : 'connecting' })
    try {
      await this.authorizeSocket()
    } catch (error) {
      if (generation !== this.generation) return
      this.connecting = false
      if (error instanceof SocketCooldownError) {
        this.publish({ connection: 'connecting', warning: error.message })
        this.reconnectTimer = this.schedule(() => {
          this.reconnectTimer = null
          void this.connect(reconnecting)
        }, error.retryAfterMs)
      } else {
        this.stopped = true
        this.publish({ connection: 'disconnected', warning: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (generation !== this.generation) return
    this.connecting = false
    if (this.subscriptions.size === 0) return
    const streams = this.desiredStreams()
    let socket: WebSocketLike
    try {
      socket = this.socketFactory(`${this.baseUrl.replace(/\/+$/, '')}/stream?streams=${[...streams].join('/')}`)
    } catch (error) {
      this.publish({ connection: 'disconnected', warning: `无法创建实时连接：${error instanceof Error ? error.message : String(error)}` })
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    this.activeStreams.clear()
    streams.forEach((stream) => this.activeStreams.add(stream))
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.openedAt = this.now()
      this.publish({ connection: 'connected', warning: '' })
      this.scheduleSubscriptionUpdate()
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return
      try {
        const raw = unwrapPayload(JSON.parse(event.data))
        // Successful SUBSCRIBE/UNSUBSCRIBE acknowledgements are not market data.
        if ('result' in raw && 'id' in raw) return
        if ('code' in raw) {
          this.failSocket('币安拒绝实时订阅，等待重新连接。')
          return
        }
        const parsed = raw.e === 'markPriceUpdate'
          ? { type: 'mark' as const, ...parseLiveMarkPrice(raw) }
          : { type: 'trade' as const, ...parseLiveKline(raw) }
        const symbol = parsed.type === 'mark' ? parsed.symbol : parsed.candle.symbol
        const receivedAt = this.now()
        if (this.openedAt !== null && receivedAt - this.openedAt >= 60_000) this.status.reconnectAttempt = 0
        for (const subscription of this.subscriptions) {
          const { input } = subscription
          if (symbol !== input.symbol ||
            (parsed.type === 'trade' && parsed.candle.timeframe !== input.timeframe)) continue
          subscription.status = {
            ...subscription.status,
            lastMessageTime: receivedAt,
            latencyMs: Math.max(0, receivedAt - parsed.eventTime),
            warning: '',
            reconnectAttempt: this.status.reconnectAttempt,
            ...(parsed.type === 'mark' ? { markPrice: parsed.price } : {
              lastPrice: parsed.candle.close,
              candleClosed: parsed.candle.isClosed,
            }),
          }
          if (parsed.type === 'trade') input.onKline(toKLineData(parsed.candle))
          input.onStatus({ ...subscription.status })
        }
        if (parsed.type === 'trade' && parsed.candle.isClosed &&
          this.desiredStreams().has(`${parsed.candle.symbol.toLowerCase()}@kline_${parsed.candle.timeframe}`)) {
          void this.service.saveRealtimeCandle('trade', parsed.candle).catch((error: unknown) => {
            if (generation === this.generation) this.publish({ warning: `保存实时 K 线失败：${error instanceof Error ? error.message : String(error)}` })
          })
        }
      } catch (error) {
        this.publish({ warning: `忽略无效实时消息：${error instanceof Error ? error.message : String(error)}` })
      }
    }
    socket.onerror = () => {
      if (this.socket === socket) this.publish({ warning: '币安实时连接发生错误，等待重新连接。' })
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.clearSubscriptionTimer()
      this.publish({ connection: 'disconnected' })
      this.scheduleReconnect()
    }
  }

  private failSocket(warning: string): void {
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.clearSubscriptionTimer()
    this.publish({ connection: 'disconnected', warning })
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.subscriptions.size === 0 || this.reconnectTimer !== null) return
    if (this.status.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.stopped = true
      this.publish({ connection: 'disconnected', warning: '实时连接连续失败，已停止自动重连。请稍后手动切换模式重试。' })
      return
    }
    const reconnectAttempt = this.status.reconnectAttempt + 1
    this.publish({ reconnectAttempt })
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null
      void this.connect(true)
    }, Math.min(MAX_RECONNECT_DELAY, 10_000 * 2 ** (reconnectAttempt - 1)))
  }

  private clearSubscriptionTimer(): void {
    if (this.subscriptionTimer !== null) this.cancelSchedule(this.subscriptionTimer)
    this.subscriptionTimer = null
  }

  private disconnect(): void {
    this.generation += 1
    this.connecting = false
    this.stopped = false
    if (this.reconnectTimer !== null) this.cancelSchedule(this.reconnectTimer)
    this.reconnectTimer = null
    this.clearSubscriptionTimer()
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.activeStreams.clear()
    this.status = { ...INITIAL_LIVE_STATUS }
  }
}
