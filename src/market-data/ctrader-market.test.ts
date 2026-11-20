import { afterEach, describe, expect, it, vi } from 'vitest'
import { CTraderClient } from './ctrader-client'
import { CTraderMarketService } from './ctrader-market'
import { alignOpenTime, CTRADER_TIMEFRAMES, nextOpenTime, SUPPORTED_TIMEFRAMES } from './intervals'
import { toSymbolInfo } from './models'

interface RequestFrame {
  clientMsgId: string
  payloadType: number
  payload: Record<string, unknown>
}

const current = Date.UTC(2026, 10, 20, 12)
const minute = 60_000
const accountId = 17
const symbolId = 33
const config = { clientId: 'example', clientSecret: 'demo-app', accessToken: 'demo-view', accountId }

class FakeSocket extends EventTarget {
  readyState = 0
  sent: RequestFrame[] = []
  constructor(private onRequest: (socket: FakeSocket, request: RequestFrame) => void) {
    super()
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    })
  }
  send(data: string) {
    const request = JSON.parse(data) as RequestFrame
    this.sent.push(request)
    queueMicrotask(() => this.onRequest(this, request))
  }
  receive(frame: object) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }
  reply(request: RequestFrame, payloadType: number, payload: Record<string, unknown> = {}) {
    this.receive({ clientMsgId: request.clientMsgId, payloadType, payload })
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

type Responder = (socket: FakeSocket, request: RequestFrame) => boolean | undefined
const services: CTraderMarketService[] = []
function setup(override: Responder = () => false, now = () => current) {
  const sockets: FakeSocket[] = []
  const createSocket = vi.fn(() => {
    const socket = new FakeSocket((currentSocket, request) => {
      if (override(currentSocket, request)) return
      const reply = (type: number, payload?: Record<string, unknown>) => currentSocket.reply(request, type, payload)
      switch (request.payloadType) {
        case 2100: reply(2101); break
        case 2149: reply(2150, { permissionScope: 'SCOPE_VIEW', ctidTraderAccount: [{ ctidTraderAccountId: '17', isLive: false }] }); break
        case 2102: reply(2103, { ctidTraderAccountId: accountId }); break
        case 2112: reply(2113, { asset: [{ assetId: '10', name: 'EUR' }, { assetId: 11, name: 'USD' }] }); break
        case 2114: reply(2115, { symbol: [{ symbolId: '33', symbolName: 'EURUSD', enabled: true, baseAssetId: 10, quoteAssetId: '11', description: 'Euro / US Dollar' }] }); break
        case 2116: reply(2117, { symbol: [{ symbolId, digits: 5, stepVolume: 1_000, scheduleTimeZone: 'America/New_York', schedule: [{ startSecond: 86400, endSecond: 518400 }], holiday: [{ scheduleTimeZone: 'America/New_York', holidayDate: Date.UTC(2026, 10, 23) / 86_400_000, isRecurring: false }] }] }); break
        case 2127: reply(2128); break
        case 2129: reply(2130); break
        case 2135: reply(2165); break
        case 2136: reply(2166); break
        case 2137: reply(2138, { symbolId, period: request.payload.period, trendbar: [] }); break
      }
    })
    sockets.push(socket)
    return socket as unknown as WebSocket
  })
  const client = new CTraderClient(async () => config, createSocket)
  const service = new CTraderMarketService(client, now)
  services.push(service)
  return { sockets, createSocket, service, client }
}

function trendbar(openTime: number, period: number | string = 1) {
  return { utcTimestampInMinutes: openTime / minute, period, low: '105000', deltaOpen: '20', deltaClose: 45, deltaHigh: 50, volume: '72' }
}

afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
  vi.useRealTimers()
})

describe('cTrader market', () => {
  it('authenticates once, verifies the account and gets prices and currencies from official symbol APIs', async () => {
    const { service, sockets, createSocket } = setup()
    const [symbols, concurrent] = await Promise.all([service.getSymbols(), service.getSymbols()])
    expect(concurrent).toEqual(symbols)
    expect(createSocket).toHaveBeenCalledExactlyOnceWith('wss://demo.ctraderapi.com:5036')
    expect(sockets[0].sent.slice(0, 3)).toMatchObject([
      { payloadType: 2100, payload: { clientId: 'example', clientSecret: 'demo-app' } },
      { payloadType: 2149, payload: { accessToken: 'demo-view' } },
      { payloadType: 2102, payload: { accessToken: 'demo-view', ctidTraderAccountId: accountId } },
    ])
    expect(sockets[0].sent.filter(message => message.payloadType === 2114)).toHaveLength(1)
    expect(symbols).toMatchObject([{ symbol: 'EURUSD', baseAsset: 'EUR', quoteAsset: 'USD', pricePrecision: 5 }])
    expect(toSymbolInfo(symbols[0])).toMatchObject({ exchange: 'CTRADER', ticker: 'EURUSD', priceCurrency: 'USD' })
  })

  it.each([
    [{ permissionScope: 1, ctidTraderAccount: [{ ctidTraderAccountId: accountId, isLive: false }] }, '只读'],
    [{ ctidTraderAccount: [{ ctidTraderAccountId: accountId, isLive: false }] }, '只读'],
    [{ permissionScope: 0, ctidTraderAccount: [{ ctidTraderAccountId: accountId, isLive: 'unknown' }] }, '授权账户'],
    [{ permissionScope: 0, ctidTraderAccount: [] }, '授权账户'],
  ])('rejects a token without explicit read access or a valid account', async (payload, error) => {
    const { service, sockets } = setup((socket, message) => {
      if (message.payloadType !== 2149) return
      socket.reply(message, 2150, payload)
      return true
    })
    await expect(service.getSymbols()).rejects.toThrow(error)
    expect(sockets[0].sent.map(message => message.payloadType)).toEqual([2100, 2149])
  })

  it('paginates native candles backward, preserves gaps, and caches fetched ranges in memory', async () => {
    const first = current - 10 * minute
    const starts: number[] = []
    const { service } = setup((socket, message) => {
      if (message.payloadType !== 2137) return
      starts.push(Number(message.payload.toTimestamp))
      expect(message.payload.period).toBe(2)
      const newerPage = starts.length === 1
      socket.reply(message, 2138, {
        symbolId, period: 'M2', hasMore: newerPage,
        trendbar: (newerPage ? [first + 8 * minute] : [first, first + 2 * minute]).map(open => trendbar(open, 'M2')),
      })
      return true
    })
    const candles = await service.loadCandles('trade', 'EURUSD', '2m', first, first + 8 * minute)
    expect(candles.map(candle => candle.openTime)).toEqual([first, first + 2 * minute, first + 8 * minute])
    expect(candles[0]).toMatchObject({
      symbol: 'EURUSD', timeframe: '2m', source: 'ctrader', open: '1.05020', high: '1.05050',
      low: '1.05000', close: '1.05045', closeTime: first + 2 * minute - 1,
      tickVolume: 72, volume: '', quoteVolume: '', isClosed: true,
    })
    expect(starts).toEqual([first + 8 * minute, first + 8 * minute - 1])
    expect(await service.loadCandles('trade', 'EURUSD', '2m', first, first + 2 * minute)).toEqual(candles.slice(0, 2))
    expect(starts).toHaveLength(2)
  })

  it('uses a native count request across the weekend instead of querying each empty minute window', async () => {
    const weekend = current + 86_400_000
    const { service, sockets } = setup((socket, message) => {
      if (message.payloadType !== 2137) return
      socket.reply(message, 2138, {
        symbolId, period: 'M1', hasMore: true,
        trendbar: [trendbar(current - minute), trendbar(current - 2 * minute), trendbar(current - 3 * minute)],
      })
      return true
    }, () => weekend)
    const candles = await service.loadRecentCandles('EURUSD', '1m', weekend, { count: 3 })
    expect(candles.map(candle => candle.openTime)).toEqual([current - 3 * minute, current - 2 * minute, current - minute])
    expect(sockets[0].sent.filter(message => message.payloadType === 2137)).toMatchObject([{
      payload: { fromTimestamp: weekend - 7 * 86_400_000, toTimestamp: weekend, count: 3, period: 1 },
    }])
  })

  it('respects holiday-aware trading hours in the broker’s timezone', async () => {
    const { service } = setup()
    expect(await service.isMarketOpen('EURUSD', current)).toBe(true)
    expect(await service.isMarketOpen('EURUSD', Date.UTC(2026, 10, 21, 12))).toBe(false)
    expect(await service.isMarketOpen('EURUSD', Date.UTC(2026, 10, 23, 12))).toBe(false)
    expect(await service.isMarketOpen('EURUSD', Date.UTC(2026, 10, 24, 6))).toBe(true)
  })

  it('keeps ask-only quotes current when spot events carry a request correlation ID', async () => {
    const { service, sockets } = setup()
    const onStatus = vi.fn()
    const stop = service.subscribe({ symbol: 'EURUSD', timeframe: '1m', onCandle: vi.fn(), onStatus })
    await vi.waitFor(() => expect(sockets[0]?.sent.some(message => message.payloadType === 2135)).toBe(true))
    const spot = sockets[0].sent.find(message => message.payloadType === 2127)!
    for (const ask of [105045, 105120]) {
      sockets[0].receive({
        clientMsgId: spot.clientMsgId, payloadType: 2131,
        payload: { ctidTraderAccountId: accountId, symbolId, ask, timestamp: current },
      })
    }
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ lastPrice: '1.05120' }))
    stop()
  })

  it('reports a trading-hours transition even when spot messages stop', async () => {
    vi.useFakeTimers()
    let now = current
    const { service, sockets, client } = setup(undefined, () => now)
    const onStatus = vi.fn()
    await service.getSymbols()
    const stop = service.subscribe({ symbol: 'EURUSD', timeframe: '1m', onCandle: vi.fn(), onStatus })
    await client.connect()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sockets[0].sent.some(message => message.payloadType === 51)).toBe(true)
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ connection: 'connected', warning: '' }))
    now = Date.UTC(2026, 10, 21, 12)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ connection: 'connected', warning: 'cTrader 市场休市' }))
    stop()
  })

  it('multiplexes spot and native period subscriptions and restores only active listeners', async () => {
    const { service, sockets } = setup()
    const onMinute = vi.fn()
    const onHour = vi.fn()
    const onStatus = vi.fn()
    const stopMinute = service.subscribe({ symbol: 'EURUSD', timeframe: '1m', onCandle: onMinute, onStatus })
    const stopHour = service.subscribe({ symbol: 'EURUSD', timeframe: '1h', onCandle: onHour })
    await vi.waitFor(() => expect(sockets[0]?.sent.filter(message => message.payloadType === 2135)).toHaveLength(2))
    expect(sockets[0].sent.filter(message => message.payloadType === 2127)).toHaveLength(1)
    sockets[0].receive({ payloadType: 2131, payload: {
      ctidTraderAccountId: accountId, symbolId, bid: '105045', timestamp: current,
      trendbar: [trendbar(current - minute), trendbar(current - 60 * minute, 'H1')],
    } })
    expect(onMinute).toHaveBeenCalledWith(expect.objectContaining({ timeframe: '1m', isClosed: true }))
    expect(onHour).toHaveBeenCalledWith(expect.objectContaining({ timeframe: '1h', isClosed: true }))
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ lastPrice: '1.05045' }))
    stopHour()
    await vi.waitFor(() => expect(sockets[0].sent.some(message => message.payloadType === 2136)).toBe(true))
    sockets[0].close()
    await vi.waitFor(() => expect(sockets[1]?.sent.some(message => message.payloadType === 2135)).toBe(true), { timeout: 2_000 })
    expect(sockets[1].sent.filter(message => message.payloadType === 2135)).toMatchObject([{ payload: { period: 1 } }])
    stopMinute()
    await vi.waitFor(() => expect(sockets[1].sent.some(message => message.payloadType === 2129)).toBe(true))
  })

  it('keeps unsupported legacy periods compatible while exposing the native cTrader set', () => {
    expect(CTRADER_TIMEFRAMES).toEqual(['1m', '2m', '3m', '4m', '5m', '10m', '15m', '30m', '1h', '4h', '12h', '1d', '1w', '1M'])
    expect(SUPPORTED_TIMEFRAMES).toContain('3d')
    expect(nextOpenTime(current, '2m')).toBe(current + 2 * minute)
    expect(alignOpenTime(current + 9 * minute, '10m', 'floor')).toBe(current)
  })
})
