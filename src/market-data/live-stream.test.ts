import { describe, expect, it, vi } from 'vitest'
import type { MarketCandle } from './models'
import { BinanceLiveStream, parseLiveKline } from './live-stream'
import { SocketCooldownError } from './request-guard'

function payload(
  event: 'kline',
  options: { closed?: boolean; eventTime?: number } = {},
) {
  return {
    stream: 'btcusdt@kline_1m',
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
        c: '105',
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
  send = vi.fn()
}

function markPayload(price = '104', symbol = 'BTCUSDT') {
  return { stream: `${symbol.toLowerCase()}@markPrice@1s`, data: {
    e: 'markPriceUpdate', E: 60_500, s: symbol, p: price,
  } }
}

describe('parseLiveKline', () => {
  it('normalizes ordinary trade klines with their actual volume and trade count', () => {
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
  it('reuses one socket across rapid period changes and delayed history loads', async () => {
    vi.useFakeTimers()
    try {
      const socket = new FakeSocket()
      const socketFactory = vi.fn(() => socket)
      const authorize = vi.fn(async () => undefined)
      const stream = new BinanceLiveStream(
        { saveRealtimeCandle: vi.fn() }, socketFactory, () => 61_000,
        undefined, undefined, undefined, authorize,
      )
      stream.setKeepAlive(true)
      const first = vi.fn()
      let stop = stream.subscribe({ symbol: 'BTCUSDT', timeframe: '1m', onKline: first, onStatus: vi.fn() })
      await vi.advanceTimersByTimeAsync(0)
      socket.onopen?.()
      stop()
      // The chart may wait for REST history for longer than the connection guard interval.
      await vi.advanceTimersByTimeAsync(12_000)
      const intermediate = vi.fn()
      stop = stream.subscribe({ symbol: 'BTCUSDT', timeframe: '5m', onKline: intermediate, onStatus: vi.fn() })
      stop()
      const latest = vi.fn()
      const status = vi.fn()
      stop = stream.subscribe({ symbol: 'BTCUSDT', timeframe: '15m', onKline: latest, onStatus: status })
      await vi.advanceTimersByTimeAsync(500)
      expect(socketFactory).toHaveBeenCalledOnce()
      expect(authorize).toHaveBeenCalledOnce()
      expect(socket.close).not.toHaveBeenCalled()
      expect(socket.send.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
        { method: 'SUBSCRIBE', params: ['btcusdt@kline_15m'], id: '1' },
        { method: 'UNSUBSCRIBE', params: ['btcusdt@kline_1m'], id: '2' },
      ])
      socket.onmessage?.({ data: JSON.stringify({ result: null, id: '1' }) })
      socket.onmessage?.({ data: JSON.stringify(payload('kline')) })
      const current = payload('kline')
      current.data.k.i = '15m'
      socket.onmessage?.({ data: JSON.stringify(current) })
      current.data.k.c = '106'
      socket.onmessage?.({ data: JSON.stringify(current) })
      socket.onmessage?.({ data: JSON.stringify(markPayload()) })
      expect(first).not.toHaveBeenCalled()
      expect(intermediate).not.toHaveBeenCalled()
      expect(latest).toHaveBeenCalledTimes(2)
      expect(latest).toHaveBeenLastCalledWith(expect.objectContaining({ close: 106 }))
      expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ lastPrice: '106', warning: '' }))
      expect(status.mock.calls.at(-1)![0]).not.toHaveProperty('markPrice')
      stream.setKeepAlive(false)
      stop()
      expect(socket.close).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('waits for socket spacing once and cancels a pending connection on unsubscribe', async () => {
    vi.useFakeTimers()
    try {
      const socketFactory = vi.fn(() => new FakeSocket())
      const authorize = vi.fn()
        .mockRejectedValueOnce(new SocketCooldownError(10_000))
        .mockResolvedValue(undefined)
      const stream = new BinanceLiveStream(
        { saveRealtimeCandle: vi.fn() }, socketFactory, Date.now,
        undefined, undefined, undefined, authorize,
      )
      const onStatus = vi.fn()
      const stop = stream.subscribe({ symbol: 'BTCUSDT', timeframe: '1m', onKline: vi.fn(), onStatus })
      await vi.advanceTimersByTimeAsync(9_999)
      expect(socketFactory).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(socketFactory).toHaveBeenCalledOnce()
      expect(authorize).toHaveBeenCalledTimes(2)
      stop()
      authorize.mockRejectedValueOnce(new SocketCooldownError(10_000))
      const cancel = stream.subscribe({ symbol: 'ETHUSDT', timeframe: '5m', onKline: vi.fn(), onStatus })
      await vi.advanceTimersByTimeAsync(0)
      cancel()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(socketFactory).toHaveBeenCalledOnce()
      expect(authorize).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })

  it('does not create a socket after authorization finishes for a disposed subscription', async () => {
    let authorize!: () => void
    const pending = new Promise<void>((resolve) => { authorize = resolve })
    const socketFactory = vi.fn(() => new FakeSocket())
    const stream = new BinanceLiveStream(
      { saveRealtimeCandle: vi.fn() }, socketFactory, Date.now,
      undefined, undefined, undefined, () => pending,
    )
    const stop = stream.subscribe({ symbol: 'BTCUSDT', timeframe: '1m', onKline: vi.fn(), onStatus: vi.fn() })
    stop()
    authorize()
    await pending
    expect(socketFactory).not.toHaveBeenCalled()
  })

  it('updates unfinished trade prices and stores only completed candles without REST catch-up', async () => {
    const sockets: FakeSocket[] = []
    const service = {
      refreshCandles: vi.fn(async () => [] as MarketCandle[]),
      saveRealtimeCandle: vi.fn(async () => undefined),
    }
    const socketFactory = vi.fn((url: string) => {
      expect(url).toBe('wss://fstream.binance.com/market/stream?streams=btcusdt@kline_1m')
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
      undefined,
      undefined,
      undefined,
      async () => undefined,
    )

    const unsubscribe = stream.subscribe({
      symbol: 'BTCUSDT',
      timeframe: '1m',
      onKline: (data) => klines.push(data),
      onStatus: (status) => statuses.push(
        `${status.connection}:${status.lastPrice ?? ''}`,
      ),
    })
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    expect(service.refreshCandles).not.toHaveBeenCalled()

    sockets[0].onopen?.()
    sockets[0].onmessage?.({
      data: JSON.stringify(markPayload()),
    })
    sockets[0].onmessage?.({ data: JSON.stringify(payload('kline')) })
    expect(klines).toHaveLength(1)
    expect(service.saveRealtimeCandle).not.toHaveBeenCalled()
    const updated = payload('kline')
    updated.data.k.c = '106'
    sockets[0].onmessage?.({ data: JSON.stringify(updated) })
    expect(klines.at(-1)).toMatchObject({ close: 106 })
    sockets[0].onmessage?.({
      data: JSON.stringify(payload('kline', { closed: true })),
    })
    await vi.waitFor(() =>
      expect(service.saveRealtimeCandle).toHaveBeenCalledTimes(1),
    )

    expect(statuses).toContain('connected:')
    expect(statuses).toContain('connected:105')
    expect(statuses).not.toContain('connected:104')
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

  it('backs off and reconnects without making any REST requests', async () => {
    const sockets: FakeSocket[] = []
    const scheduled: { callback?: () => void } = {}
    const schedule = vi.fn((callback: () => void, delay: number) => {
      expect(delay).toBe(10_000)
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
      undefined,
      async () => undefined,
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
    expect(service.refreshCandles).not.toHaveBeenCalled()
    expect(connections).toContain('reconnecting')
  })

  it('stops reconnecting after three unstable connections even when sockets open', async () => {
    const sockets: FakeSocket[] = []
    let retry: (() => void) | undefined
    const schedule = vi.fn((callback: () => void) => { retry = callback; return 1 })
    const refreshCandles = vi.fn()
    const onStatus = vi.fn()
    const service = { refreshCandles, saveRealtimeCandle: vi.fn() }
    const stream = new BinanceLiveStream(
      service,
      () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
      () => 120_000, schedule, vi.fn(), undefined, async () => undefined,
    )
    stream.subscribe({ symbol: 'BTCUSDT', timeframe: '1m', onKline: vi.fn(), onStatus })
    for (let index = 0; index < 4; index += 1) {
      await vi.waitFor(() => expect(sockets).toHaveLength(index + 1))
      sockets[index].onopen?.()
      sockets[index].onclose?.()
      if (index < 3) retry?.()
    }
    expect(schedule).toHaveBeenCalledTimes(3)
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ warning: expect.stringContaining('已停止自动重连') }))
    // Changing the chart selection must not restart an exhausted retry budget.
    stream.subscribe({ symbol: 'BTCUSDT', timeframe: '5m', onKline: vi.fn(), onStatus })
    await Promise.resolve()
    expect(sockets).toHaveLength(4)
    expect(refreshCandles).not.toHaveBeenCalled()
  })

  it('does not connect or schedule retries when the shared protection rejects a socket', async () => {
    const socketFactory = vi.fn()
    const schedule = vi.fn()
    const onStatus = vi.fn()
    const stream = new BinanceLiveStream(
      { saveRealtimeCandle: vi.fn() }, socketFactory, Date.now, schedule, vi.fn(), undefined,
      async () => { throw new Error('已暂停新增远程请求') },
    )
    stream.subscribe({ symbol: 'BTCUSDT', timeframe: '1m', onKline: vi.fn(), onStatus })
    await vi.waitFor(() => expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ connection: 'disconnected', warning: '已暂停新增远程请求' })))
    expect(socketFactory).not.toHaveBeenCalled()
    expect(schedule).not.toHaveBeenCalled()
  })

  it('silently ignores retired mark streams and malformed mark events without changing trade status', async () => {
    const socket = new FakeSocket()
    const onStatus = vi.fn()
    const onKline = vi.fn()
    const saveRealtimeCandle = vi.fn(async () => undefined)
    const stream = new BinanceLiveStream({ saveRealtimeCandle }, () => socket, () => 61_000, undefined, undefined, undefined, async () => undefined)
    const stop = stream.subscribe({ symbol: 'BTCUSDT', timeframe: '1m', onKline, onStatus })
    await vi.waitFor(() => expect(socket.onmessage).not.toBeNull())
    socket.onopen?.()
    socket.onmessage?.({ data: JSON.stringify(payload('kline')) })
    const statuses = onStatus.mock.calls.length
    const legacyKline = payload('kline', { closed: true })
    legacyKline.stream = 'btcusdt@markPriceKline_1m'
    for (const message of [markPayload('NaN'), { e: 'markPrice_kline', k: null }, legacyKline]) {
      socket.onmessage?.({ data: JSON.stringify(message) })
    }
    expect(onStatus).toHaveBeenCalledTimes(statuses)
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ lastPrice: '105', warning: '' }))
    expect(onKline).toHaveBeenCalledOnce()
    expect(saveRealtimeCandle).not.toHaveBeenCalled()
    socket.onerror?.()
    const warningStatus = onStatus.mock.calls.at(-1)![0]
    const warnedCount = onStatus.mock.calls.length
    socket.onmessage?.({ data: JSON.stringify(markPayload()) })
    expect(onStatus).toHaveBeenCalledTimes(warnedCount)
    expect(onStatus).toHaveBeenLastCalledWith(warningStatus)
    expect(warningStatus.warning).toContain('连接发生错误')
    stop()
  })
})
