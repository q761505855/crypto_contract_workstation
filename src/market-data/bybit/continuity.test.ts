import { afterEach, describe, expect, it, vi } from 'vitest'
import { BybitArchive, parseBybitArchivePart } from './archive'
import { BybitDatafeed } from './datafeed'
import { BybitLiveTrades, parseBybitSocketTrades } from './live'
import { BYBIT_HOUR_MS, bybitDayStart, bybitSymbolInfo, type BybitTrade } from './trades'

const symbol = 'SPYUSDT'
const period = { text: '1m', multiplier: 1, timespan: 'minute' } as const
const start = bybitDayStart('2026-11-18')
const trade = (id: string, offset: number, price = 716, size = 1): BybitTrade =>
  ({ timeUs: (start + offset) * 1000, id, side: 'buy', price, size })

class SocketFixture {
  readyState = 1
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  send = vi.fn()
  close() { this.onclose?.() }
  emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  acknowledge() {
    this.onopen?.()
    expect(JSON.parse(this.send.mock.calls[0][0])).toEqual({ op: 'subscribe', args: ['publicTrade.SPYUSDT'] })
    this.emit({ op: 'subscribe', success: true })
  }
  trades(...rows: BybitTrade[]) {
    this.emit({ topic: 'publicTrade.SPYUSDT',
      data: rows.map(item => ({ s: symbol, i: item.id, T: item.timeUs / 1000, S: 'Buy', p: String(item.price), v: String(item.size) })) })
  }
}

afterEach(() => vi.useRealTimers())

describe('Bybit 成交连续性', () => {
  it('订阅期间缓冲实时成交，用 REST 合并启动与断线区间，按成交 ID 去重', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(start + 30_000)
    const sockets: SocketFixture[] = []
    const status = vi.fn()
    const a = trade('a', 1000), b = trade('b', 2000), c = trade('c', 3000), d = trade('d', 4000), e = trade('e', 5000)
    const recent = vi.fn().mockResolvedValueOnce([a, b]).mockResolvedValueOnce([c, d]).mockResolvedValueOnce([trade('z', 9000)])
    const live = new BybitLiveTrades(symbol, status, () => {
      const socket = new SocketFixture()
      sockets.push(socket)
      return socket as unknown as WebSocket
    }, recent)
    try {
      live.open()
      sockets[0].acknowledge()
      sockets[0].trades(b, c)
      await vi.advanceTimersByTimeAsync(0)
      expect(live.read(0, Infinity).map(item => item.id)).toEqual(['a', 'b', 'c'])
      expect(status).toHaveBeenLastCalledWith('实时逐笔')

      sockets[0].close()
      await vi.advanceTimersByTimeAsync(1000)
      sockets[1].acknowledge()
      sockets[1].trades(d, e)
      await vi.advanceTimersByTimeAsync(0)
      expect(live.read(0, Infinity).map(item => item.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
      expect(status).toHaveBeenLastCalledWith('实时逐笔')

      sockets[1].close()
      await vi.advanceTimersByTimeAsync(1000)
      sockets[2].acknowledge()
      await vi.advanceTimersByTimeAsync(0)
      expect(status).toHaveBeenLastCalledWith('逐笔有缺口')
      expect(live.read(0, Infinity).map(item => item.id)).toEqual(['z'])
    } finally { live.close() }
  })

  it('以归档作为已完成小时的来源，并从实时缓存接上后一小时', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(start + BYBIT_HOUR_MS + 60_000)
    const archive = new BybitArchive()
    const first = trade('first', BYBIT_HOUR_MS - 1000)
    const last = trade('last', BYBIT_HOUR_MS + 500)
    vi.spyOn(archive, 'loadHour').mockResolvedValueOnce([first]).mockResolvedValueOnce(null)
    const live = new BybitLiveTrades(symbol, vi.fn())
    const read = vi.spyOn(live, 'read').mockReturnValue([last])
    const datafeed = new BybitDatafeed(symbol, archive, live)
    const received: BybitTrade[] = []
    await datafeed.visitTrades({ fromUs: first.timeUs, untilUs: last.timeUs + 1 }, row => received.push(row))
    expect(received).toEqual([first, last])
    expect(read).toHaveBeenCalledExactlyOnceWith((start + BYBIT_HOUR_MS) * 1000, last.timeUs + 1)
  })

  it('在回放边界前逐笔累加，下一步才显示后续成交', async () => {
    const archive = new BybitArchive()
    const first = trade('first', 500, 716, 1)
    const next = trade('next', 1500, 721, 2)
    vi.spyOn(archive, 'loadHour').mockResolvedValue([first, next])
    const datafeed = new BybitDatafeed(symbol, archive, undefined, start, (start + 1000) * 1000)
    expect(await datafeed.getHistoryKLineData(bybitSymbolInfo(symbol), period, start, start + 60_000)).toEqual([
      { timestamp: start, open: 716, high: 716, low: 716, close: 716, volume: 1, turnover: 716 },
    ])
    const update = vi.fn()
    datafeed.subscribe(bybitSymbolInfo(symbol), period, update)
    await datafeed.advance((start + 2000) * 1000)
    expect(update).toHaveBeenCalledExactlyOnceWith({
      timestamp: start, open: 716, high: 721, low: 716, close: 721, volume: 3, turnover: 2158,
    })
  })

  it('保留归档的微秒顺序并拒绝无效数据', () => {
    const timestamp = start / 1000
    const text = `${timestamp}.000001,a,Buy,716,1\n${timestamp}.000002,b,Sell,717,1\n`
    expect(parseBybitArchivePart(text, start, 2).map(item => [item.timeUs, item.side])).toEqual([
      [start * 1000 + 1, 'buy'], [start * 1000 + 2, 'sell'],
    ])
    expect(() => parseBybitArchivePart(text, start, 1)).toThrow('笔数')
    expect(() => parseBybitSocketTrades({ topic: 'publicTrade.SPYUSDT', data: [{ s: symbol, T: start, i: 'a', S: 'Buy', p: '-1', v: '1' }] }, symbol)).toThrow('成交格式')
  })
})
