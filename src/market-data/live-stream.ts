import type { KLineData } from 'klinecharts'
import { createBrowserRequestGuard } from './request-guard'
import type { CandleKind, MarketCandle } from './models'
import type { LiveMarketStatus } from './live-models'
import { INITIAL_LIVE_STATUS } from './live-models'
import { normalizeKline } from './normalizer'

export const DEFAULT_STREAM_BASE_URL = 'wss://fstream.binance.com'
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

export function parseLiveKline(payload: unknown): ParsedLiveKline {
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
  const eventType = requiredString(raw.e, 'eventType')
  const kind: CandleKind =
    eventType === 'kline'
      ? 'trade'
      : eventType === 'markPrice_kline'
        ? 'mark'
        : (() => {
            throw new Error(`不支持的实时行情事件：${eventType}`)
          })()
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
      kind === 'trade' ? requiredString(kline.v, 'volume') : '0',
      closeTime,
      kind === 'trade' ? requiredString(kline.q, 'quoteVolume') : '0',
      kind === 'trade' ? finiteNumber(kline.n, 'tradeCount') : 0,
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

  subscribe(input: LiveStreamSubscriptionInput): () => void {
    const symbol = input.symbol.toUpperCase()
    let disposed = false
    let socket: WebSocketLike | null = null
    let reconnectTimer: number | null = null
    let reconnectAttempt = 0
    let status: LiveMarketStatus = { ...INITIAL_LIVE_STATUS }

    const publish = (patch: Partial<LiveMarketStatus>) => {
      status = { ...status, ...patch }
      input.onStatus({ ...status })
    }

    const connect = async (reconnecting: boolean) => {
      if (disposed) return
      publish({
        connection: reconnecting ? 'reconnecting' : 'connecting',
        reconnectAttempt,
      })
      try {
        await this.authorizeSocket()
      } catch (error) {
        if (!disposed) publish({ connection: 'disconnected', warning: (error as Error).message })
        return
      }
      if (disposed) return
      const streamSymbol = symbol.toLowerCase()
      const streams = [
        `${streamSymbol}@kline_${input.timeframe}`,
        `${streamSymbol}@markPriceKline_${input.timeframe}`,
      ].join('/')
      try {
        socket = this.socketFactory(
          `${this.baseUrl.replace(/\/+$/, '')}/stream?streams=${streams}`,
        )
      } catch (error) {
        publish({
          connection: 'disconnected',
          warning: `无法创建实时连接：${
            error instanceof Error ? error.message : String(error)
          }`,
        })
        scheduleReconnect()
        return
      }
      const currentSocket = socket
      let openedAt: number | null = null
      currentSocket.onopen = () => {
        if (disposed || socket !== currentSocket) return
        openedAt = this.now()
        publish({
          connection: 'connected',
          reconnectAttempt,
        })
      }
      currentSocket.onmessage = (event) => {
        if (
          disposed ||
          socket !== currentSocket ||
          typeof event.data !== 'string'
        ) {
          return
        }
        try {
          const parsed = parseLiveKline(JSON.parse(event.data))
          if (
            parsed.candle.symbol !== symbol ||
            parsed.candle.timeframe !== input.timeframe
          ) {
            return
          }
          const receivedAt = this.now()
          if (openedAt !== null && receivedAt - openedAt >= 60_000) reconnectAttempt = 0
          const patch: Partial<LiveMarketStatus> = {
            lastMessageTime: receivedAt,
            latencyMs: Math.max(0, receivedAt - parsed.eventTime),
            warning: '',
            reconnectAttempt,
          }
          if (parsed.kind === 'trade') {
            patch.candleClosed = parsed.candle.isClosed
            input.onKline(toKLineData(parsed.candle))
          } else {
            patch.markPrice = parsed.candle.close
          }
          publish(patch)
          if (parsed.candle.isClosed) {
            void this.service
              .saveRealtimeCandle(parsed.kind, parsed.candle)
              .catch((error: unknown) => {
                publish({
                  warning: `保存实时 K 线失败：${
                    error instanceof Error
                      ? error.message
                      : String(error)
                  }`,
                })
              })
          }
        } catch (error) {
          publish({
            warning: `忽略无效实时消息：${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        }
      }
      currentSocket.onerror = () => {
        if (!disposed && socket === currentSocket) {
          publish({ warning: '币安实时连接发生错误，等待重新连接。' })
        }
      }
      currentSocket.onclose = () => {
        if (disposed || socket !== currentSocket) return
        socket = null
        publish({ connection: 'disconnected' })
        scheduleReconnect()
      }
    }

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) return
      if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        publish({ connection: 'disconnected', warning: '实时连接连续失败，已停止自动重连。请稍后手动切换模式重试。' })
        return
      }
      reconnectAttempt += 1
      const delay = Math.min(
        MAX_RECONNECT_DELAY,
        10_000 * 2 ** (reconnectAttempt - 1),
      )
      publish({ reconnectAttempt })
      reconnectTimer = this.schedule(() => {
        reconnectTimer = null
        void connect(true)
      }, delay)
    }

    void connect(false)

    return () => {
      disposed = true
      if (reconnectTimer !== null) {
        this.cancelSchedule(reconnectTimer)
        reconnectTimer = null
      }
      const activeSocket = socket
      socket = null
      activeSocket?.close()
      publish({
        connection: 'disconnected',
        reconnectAttempt: 0,
      })
    }
  }
}
