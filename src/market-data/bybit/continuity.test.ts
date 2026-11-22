import { afterEach, describe, expect, it, vi } from 'vitest'
import { BybitArchive, parseBybitArchivePart } from './archive'
import { CombinedBybitSource } from './combined-source'
import { GitHubContentsClient } from '../../github-sync/github-client'
import { BybitLiveTrades, parseBybitSocketTrades } from './live'
import { bybitDayStart, bybitMapping, type BybitTrade } from './trades'

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
    const sameTime = trade('same-time', 3000)
    const recent = vi.fn().mockResolvedValueOnce([a, b]).mockResolvedValueOnce([c, sameTime, d]).mockResolvedValueOnce([trade('z', 9000)])
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
      const changed = vi.fn()
      live.subscribe(changed)
      sockets[0].trades(c, sameTime)
      expect(changed).toHaveBeenLastCalledWith([a, b, c, sameTime], true, sameTime.timeUs)

      sockets[0].close()
      await vi.advanceTimersByTimeAsync(1000)
      sockets[1].acknowledge()
      sockets[1].trades(d, e)
      await vi.advanceTimersByTimeAsync(0)
      expect(live.read(0, Infinity).map(item => item.id)).toEqual(['a', 'b', 'c', 'same-time', 'd', 'e'])
      expect(status).toHaveBeenLastCalledWith('实时逐笔')

      sockets[1].close()
      await vi.advanceTimersByTimeAsync(1000)
      sockets[2].acknowledge()
      await vi.advanceTimersByTimeAsync(0)
      expect(status).toHaveBeenLastCalledWith('逐笔有缺口')
      expect(live.read(0, Infinity).map(item => item.id)).toEqual(['a', 'b', 'c', 'same-time', 'd', 'e', 'z'])
    } finally { live.close() }
  })

  it('同一目录映射 ETF、现货、外汇和加密合约，按 IC 回放游标限制 Bybit 成交', async () => {
    const ic = { ticker: 'US500', exchange: 'CTRADER' }
    expect(bybitMapping(ic)).toEqual({ symbol: 'SPYUSDT', relation: 'etf' })
    expect(bybitMapping({ ...ic, ticker: '1000xSHIB' })?.symbol).toBe('SHIB1000USDT')
    expect(bybitMapping({ ...ic, ticker: 'EURUSD' })?.symbol).toBe('EURUSDUSDT')
    expect(bybitMapping({ ...ic, ticker: 'FETUSD' })?.symbol).toBe('FETUSDT')
    expect(bybitMapping({ ...ic, ticker: 'USDCHF' })).toBeUndefined()
    const archive = new BybitArchive()
    const first = trade('first', 500)
    const atCursor = trade('at-cursor', 1000)
    const latest = trade('next', 1500)
    vi.spyOn(archive, 'hasDay').mockResolvedValue(true)
    vi.spyOn(archive, 'loadHour').mockResolvedValue([first, atCursor, latest])
    const source = new CombinedBybitSource(new GitHubContentsClient({ owner: 'owner', repository: 'store', branch: 'main' }),
      vi.fn(), archive, () => start + 86_400_000)
    const cursor = { sessionId: 'ic-session', symbol: ic.ticker, timeframe: '1m', currentTime: start + 1000,
      visibleUntil: start + 1001, cursorTickIndex: 0 }
    const received: BybitTrade[] = []
    const scan = () => source.visitTrades({ fromUs: start * 1000, untilUs: (start + 2000) * 1000 },
      row => received.push(row), new AbortController().signal)
    source.select(ic, cursor)
    expect(await scan()).toBe(true)
    expect(received).toEqual([first])
    source.select(ic, { ...cursor, currentTime: start + 1800, visibleUntil: start + 1801 })
    received.length = 0
    expect(await scan()).toBe(true)
    expect(received).toEqual([first, atCursor, latest])
    source.release()
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

  it('同日缺档只提交一次后台缓存请求', async () => {
    const archive = new BybitArchive()
    vi.spyOn(archive, 'hasDay').mockResolvedValue(false)
    const cloud = new GitHubContentsClient({ owner: 'owner', repository: 'store', branch: 'main' }, 'test-token')
    vi.spyOn(cloud, 'getSnapshot').mockResolvedValue({ commitSha: 'commit', treeSha: 'tree' })
    vi.spyOn(cloud, 'getFile').mockResolvedValue(null)
    const submit = vi.spyOn(cloud, 'putFile').mockResolvedValue('request')
    const source = new CombinedBybitSource(cloud, vi.fn(), archive, () => start + 86_400_000)
    const cursor = { sessionId: 'ic-session', symbol: 'US500', timeframe: '1m', currentTime: start,
      visibleUntil: start + 1000 }
    const scan = () => source.visitTrades({ fromUs: start * 1000, untilUs: (start + 1000) * 1000 },
      vi.fn(), new AbortController().signal)
    try {
      source.select({ ticker: 'US500', exchange: 'CTRADER' }, cursor)
      expect(await scan()).toBe(false)
      expect(await scan()).toBe(false)
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
      expect(submit.mock.calls[0][0]).toBe('data/bybit-requests/SPYUSDT/2026-11-18.json')
    } finally { source.release() }
  })
})
