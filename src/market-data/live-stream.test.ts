import { describe, expect, it, vi } from 'vitest'
import type { MarketCandle } from './models'
import { BinanceLiveStream, parseLiveKline } from './live-stream'

function payload(
  event: 'kline' | 'markPrice_kline',
  options: { closed?: boolean; eventTime?: number } = {},
) {
  return {
    stream:
      event === 'kline'
        ? 'btcusdt@kline_1m'
        : 'btcusdt@markPriceKline_1m',
    data: {
      e: event,
      E: options.eventTime ?? 60_500,
      s: 'BTCUSDT',
      k: {
        t: 60_000,
        T: 119_999,
        s: 'BTCUSDT',
        i: '1m',
        o: '100',
        h: '110',
        l: '90',
        c: event === 'kline' ? '105' : '104',
        v: '12',
        q: '1260',
        n: 8,
        x: options.closed ?? false,
      },
    },
  }
}

class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  close = vi.fn()
}

describe('parseLiveKline', () => {
  it('normalizes trade and mark-price kline messages', () => {
    expect(parseLiveKline(payload('kline', { closed: true }))).toMatchObject({
      kind: 'trade',
      eventTime: 60_500,
      candle: {
        symbol: 'BTCUSDT',
        timeframe: '1m',
        openTime: 60_000,
        close: '105',
        volume: '12',
        quoteVolume: '1260',
        tradeCount: 8,
        isClosed: true,
      },
    })
    expect(parseLiveKline(payload('markPrice_kline'))).toMatchObject({
      kind: 'mark',
      candle: {
        close: '104',
        volume: '0',
        isClosed: false,
      },
    })
  })

  it('rejects unsupported or malformed messages', () => {
    expect(() => parseLiveKline({ data: { e: 'trade' } })).toThrow(
      '不支持的实时行情事件',
    )
    const invalid = payload('kline')
    invalid.data.k.h = '80'
    expect(() => parseLiveKline(invalid)).toThrow('非法 OHLC')
  })
})

describe('BinanceLiveStream', () => {
  it('catches up, streams both candle kinds, and stores closed candles', async () => {
    const sockets: FakeSocket[] = []
    const service = {
      refreshCandles: vi.fn(async () => [] as MarketCandle[]),
      saveRealtimeCandle: vi.fn(async () => undefined),
    }
    const socketFactory = vi.fn((url: string) => {
      expect(url).toContain(
        'btcusdt@kline_1m/btcusdt@markPriceKline_1m',
      )
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    })
    const statuses: string[] = []
    const klines: unknown[] = []
    const stream = new BinanceLiveStream(
      service,
      socketFactory,
      () => 61_000,
    )

    const unsubscribe = stream.subscribe({
      symbol: 'BTCUSDT',
      timeframe: '1m',
      onKline: (data) => klines.push(data),
      onStatus: (status) => statuses.push(
        `${status.connection}:${status.markPrice ?? ''}`,
      ),
    })
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    expect(service.refreshCandles).toHaveBeenCalledTimes(2)

    sockets[0].onopen?.()
    sockets[0].onmessage?.({
      data: JSON.stringify(payload('markPrice_kline')),
    })
    sockets[0].onmessage?.({
      data: JSON.stringify(payload('kline', { closed: true })),
    })
    await vi.waitFor(() =>
      expect(service.saveRealtimeCandle).toHaveBeenCalledTimes(1),
    )

    expect(statuses).toContain('connected:')
    expect(statuses).toContain('connected:104')
    expect(klines).toContainEqual(
      expect.objectContaining({ timestamp: 60_000, close: 105 }),
    )
    expect(service.saveRealtimeCandle).toHaveBeenCalledWith(
      'trade',
      expect.objectContaining({ isClosed: true }),
    )

    unsubscribe()
    expect(sockets[0].close).toHaveBeenCalledOnce()
  })

  it('backs off, reconnects, and runs REST catch-up again', async () => {
    const sockets: FakeSocket[] = []
    const scheduled: { callback?: () => void } = {}
    const schedule = vi.fn((callback: () => void, delay: number) => {
      expect(delay).toBe(1_000)
      scheduled.callback = callback
      return 7
    })
    const service = {
      refreshCandles: vi.fn(async () => [] as MarketCandle[]),
      saveRealtimeCandle: vi.fn(async () => undefined),
    }
    const stream = new BinanceLiveStream(
      service,
      () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      () => 120_000,
      schedule,
      vi.fn(),
    )
    const connections: string[] = []

    stream.subscribe({
      symbol: 'ETHUSDT',
      timeframe: '5m',
      onKline: vi.fn(),
      onStatus: (status) => connections.push(status.connection),
    })
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0].onopen?.()
    sockets[0].onclose?.()
    expect(schedule).toHaveBeenCalledOnce()
    expect(connections).toContain('disconnected')

    if (scheduled.callback === undefined) {
      throw new Error('Reconnect was not scheduled')
    }
    scheduled.callback()
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    expect(service.refreshCandles).toHaveBeenCalledTimes(4)
    expect(connections).toContain('reconnecting')
  })
})
