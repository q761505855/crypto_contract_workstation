import { describe, expect, it, vi } from 'vitest'
import { GitHubContentsClient } from '../../github-sync/github-client'
import { BybitArchive } from '../bybit/archive'
import { CombinedBybitSource, firstOkxHistoryDay } from '../bybit/combined-source'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, type BybitTrade } from '../bybit/trades'
import { OkxArchive, okxArchiveDay } from './archive'
import { readOkxTradePages, readOkxTradePagesForward } from './live'
import { orderFlowMapping, okxTrade } from './trades'

const symbol = { ticker: 'US500', exchange: 'CTRADER' }
const instrument = orderFlowMapping(symbol)!.okx!
const start = Date.parse('2026-10-20T00:00:00Z')
const hour = BYBIT_HOUR_MS

describe('OKX 成交来源', () => {
  it('映射指数点位并按 OKX 的合约面值折算成交数量', () => {
    expect(instrument.symbol).toBe('US500-USDT-SWAP')
    expect(orderFlowMapping({ ...symbol, ticker: 'USTEC' })).toMatchObject({
      okx: { symbol: 'US100-USDT-SWAP' }, bybit: { symbol: 'QQQUSDT', relation: 'etf' },
    })
    const bitcoin = orderFlowMapping({ ...symbol, ticker: 'BTCUSD' })!.okx!
    expect(okxTrade(bitcoin, String(start), '3', 'sell', '60000', '25')).toMatchObject({ size: 0.25, venue: 'OKX' })
    expect(okxArchiveDay(start + 16 * hour - 1)).toBe('2026-10-20')
    expect(okxArchiveDay(start + 16 * hour)).toBe('2026-10-21')
  })

  it('在同毫秒超过一页时按成交 ID 向前翻，并筛选出闭开区间内的成交', async () => {
    const row = (id: number, time: number) => ({ instId: instrument.symbol, tradeId: String(id), ts: String(time), px: '7000', sz: '0.25', side: 'sell' })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
      const args = new URL(String(input)).searchParams
      if (args.get('type') === '2') {
        expect(args.get('after')).toBe(String(start + 2))
        return Response.json({ code: '0', data: Array.from({ length: 100 }, (_, index) => row(102 - index, start + 1)) })
      }
      expect(args.get('after')).toBe('3')
      return Response.json({ code: '0', data: [row(3, start + 1), row(2, start + 1), row(1, start - 1)] })
    })
    const received: BybitTrade[] = []
    for await (const page of readOkxTradePages(instrument, start * 1000, (start + 2) * 1000, new AbortController().signal, fetcher)) {
      received.unshift(...page.rows)
    }
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(received.map(trade => trade.id)).toEqual(Array.from({ length: 101 }, (_, index) => String(index + 2)))
    expect(received[0]).toMatchObject({ venue: 'OKX', side: 'sell', size: 0.25 })
  })

  it('先发布靠近锚点的 API 页，再继续向左请求更早成交', async () => {
    const trades = Array.from({ length: 102 }, (_, index) => ({ instId: instrument.symbol, tradeId: String(index + 1),
      ts: String(start + index), px: '7000', sz: '1', side: 'buy' }))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ code: '0', data: trades.slice(2).reverse() }))
      .mockResolvedValueOnce(Response.json({ code: '0', data: trades.slice(0, 2).reverse() }))
    const stream = readOkxTradePages(instrument, start * 1000, (start + 102) * 1000, new AbortController().signal, fetcher)
    const nearest = await stream.next()
    expect(nearest.value).toMatchObject({ fromUs: (start + 3) * 1000, untilUs: (start + 102) * 1000 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const earlier = await stream.next()
    expect(earlier.value).toMatchObject({ fromUs: start * 1000, untilUs: (start + 3) * 1000 })
    expect(earlier.done ? [] : earlier.value.rows.map(trade => trade.id)).toEqual(['1', '2', '3'])
  })

  it('从回放锚点向右按 ID 区间逐页发布，保留未来数据的时间顺序', async () => {
    const trades = Array.from({ length: 208 }, (_, index) => ({ instId: instrument.symbol, tradeId: String(index + 1),
      ts: String(start + index), px: '7000', sz: '1', side: 'buy' }))
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
      const query = new URL(String(input)).searchParams
      const after = Number(query.get('after'))
      const before = Number(query.get('before'))
      const limit = Number(query.get('limit'))
      const rows = trades.filter(row => query.get('type') === '2' ? Number(row.ts) < after :
        Number(row.tradeId) > before && Number(row.tradeId) < after)
      return Response.json({ code: '0', data: rows.reverse().slice(0, limit) })
    })
    const stream = readOkxTradePagesForward(instrument, (start + 4) * 1000, (start + 206) * 1000,
      new AbortController().signal, fetcher)
    const first = await stream.next()
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(first.value).toMatchObject({ fromUs: (start + 4) * 1000, untilUs: (start + 103) * 1000 })
    const ids = first.done ? [] : first.value.rows.map(trade => Number(trade.id))
    for await (const page of stream) ids.push(...page.rows.map(trade => Number(trade.id)))
    expect(ids).toEqual(Array.from({ length: 202 }, (_, index) => index + 5))
  })

  it.each([false, true])('并发读取完整区间并保持限速（向右：%s）', async forward => {
    vi.resetModules()
    vi.useFakeTimers()
    try {
      const { readOkxTradePages, readOkxTradePagesForward, visitOkxTradePages } = await import('./live')
      const trades = Array.from({ length: 3600 }, (_, index) => ({ instId: instrument.symbol, tradeId: String(index + 1),
        ts: String(start + Math.floor(index / 5) * 20_000), px: '7000', sz: '1', side: 'buy' }))
      const fromUs = (start + 1) * 1000
      const untilUs = (start + 4 * hour) * 1000
      const signal = new AbortController().signal
      const measure = async (concurrent: boolean) => {
        const started = Date.now()
        const starts: number[] = []
        let pending = 0
        let peak = 0
        const fetcher: typeof fetch = async input => {
          starts.push(Date.now())
          peak = Math.max(peak, ++pending)
          const query = new URL(String(input)).searchParams
          const after = Number(query.get('after'))
          const before = Number(query.get('before') ?? 0)
          const rows = trades.filter(row => query.get('type') === '2' ? Number(row.ts) < after :
            Number(row.tradeId) > before && Number(row.tradeId) < after)
          await new Promise(resolve => setTimeout(resolve, 400))
          pending--
          return Response.json({ code: '0', data: rows.reverse().slice(0, Number(query.get('limit'))) })
        }
        const pages: import('./live').OkxTradePage[] = []
        if (concurrent) await visitOkxTradePages(instrument, fromUs, untilUs, forward, signal, page => pages.push(page), fetcher)
        else {
          const read = forward ? readOkxTradePagesForward : readOkxTradePages
          for await (const page of read(instrument, fromUs, untilUs, signal, fetcher)) pages.push(page)
        }
        return { pages, starts, peak, duration: Date.now() - started }
      }
      const sequential = measure(false)
      await vi.runAllTimersAsync()
      const baseline = await sequential
      const concurrent = measure(true)
      await vi.runAllTimersAsync()
      const result = await concurrent
      expect(result.peak).toBeGreaterThan(1)
      expect(result.peak).toBeLessThanOrEqual(4)
      expect(result.starts.slice(1).every((time, index) => time - result.starts[index] >= 125)).toBe(true)
      expect(result.duration).toBeLessThan(baseline.duration * 0.75)
      expect(forward ? result.pages[0].fromUs : result.pages[0].untilUs).toBe(forward ? fromUs : untilUs)
      const pages = result.pages.sort((left, right) => left.fromUs - right.fromUs)
      expect(pages[0].fromUs).toBe(fromUs)
      expect(pages.at(-1)?.untilUs).toBe(untilUs)
      expect(pages.slice(1).every((page, index) => page.fromUs === pages[index].untilUs)).toBe(true)
      expect(pages.flatMap(page => page.rows.map(row => row.id))).toEqual(trades.slice(5).map(row => row.tradeId))
    } finally { vi.useRealTimers() }
  })

  it('按 Retry-After 和 OKX 限流码退避后重试同一页', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    try {
      const { readOkxTradePages } = await import('./live')
      const starts: number[] = []
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        starts.push(Date.now())
        if (starts.length === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '3' } })
        if (starts.length === 2) return Response.json({ code: '50011' })
        return Response.json({ code: '0', data: [] })
      })
      const stream = readOkxTradePages(instrument, start * 1000, (start + 1000) * 1000, new AbortController().signal, fetcher)
      const next = stream.next()
      await vi.runAllTimersAsync()
      expect(await next).toMatchObject({ done: false, value: { rows: [] } })
      expect(starts.map(time => time - starts[0])).toEqual([0, 3000, 7000])
      expect(new Set(fetcher.mock.calls.map(([url]) => url)).size).toBe(1)
      await stream.return(undefined)
    } finally { vi.useRealTimers() }
  })

  it('按 UTC 自然月判断 OKX 能完整覆盖的日期，月末截到目标月最后一天', () => {
    expect(firstOkxHistoryDay(Date.parse('2025-05-31T00:00:00Z'))).toBe(Date.parse('2025-02-28'))
    expect(firstOkxHistoryDay(Date.parse('2024-05-31T00:00:01Z'))).toBe(Date.parse('2024-03-01'))
  })

  it('只有官方清单覆盖完整 UTC 日时才走归档，兼容黄金更名', async () => {
    const day = '2026-01-14'
    const files = ['XAUT-USDT-SWAP-trades-2026-01-14.zip', 'XAUT-USDT-SWAP-trades-2026-01-15.zip',
      'XAU-USDT-SWAP-trades-2026-01-15.zip']
    const result = (names: string[]) => Response.json({ code: '0', data: [{ details: [{ groupDetails:
      names.map(filename => ({ filename })),
    }] }] })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(result(files.slice(0, 2))).mockResolvedValueOnce(result(files))
    const okx = new OkxArchive(undefined, fetcher)
    const gold = orderFlowMapping({ ...symbol, ticker: 'XAUUSD' })!.okx!
    const signal = new AbortController().signal
    expect(await okx.hasSourceDay(gold, day, signal)).toBe(false)
    expect(await okx.hasSourceDay(gold, day, signal)).toBe(true)
    const query = new URL(String(fetcher.mock.calls[0][0])).searchParams
    expect(query.get('instFamilyList')).toBe('XAUT-USDT,XAU-USDT')
    expect(Number(query.get('begin'))).toBe(Date.parse('2026-01-14T00:00:00+08:00'))
    expect(Number(query.get('end'))).toBe(Date.parse('2026-01-15T00:00:00+08:00'))
  })

  it('优先使用 OKX，确认无成交的小时保持为空，缺档才读取 Bybit', async () => {
    const okx = new OkxArchive()
    const bybit = new BybitArchive()
    const primary = okxTrade(instrument, String(start + 1), '1', 'buy', '7000', '1')
    const secondary: BybitTrade = { ...primary, id: 'legacy', timeUs: (start + 2 * hour + 1) * 1000, venue: undefined }
    const readPrimary = vi.spyOn(okx, 'loadHour').mockImplementation(async (_instrument, stamp) =>
      stamp === start ? [primary] : stamp === start + hour ? [] : null)
    const readFallback = vi.spyOn(bybit, 'loadHour').mockResolvedValue([secondary])
    const cloud = new GitHubContentsClient({ owner: 'owner', repository: 'store', branch: 'main' })
    const source = new CombinedBybitSource(cloud, vi.fn(), bybit, () => start + 100 * BYBIT_DAY_MS, okx)
    source.select(symbol, { sessionId: 'test', symbol: symbol.ticker, timeframe: '15m', currentTime: start + 3 * hour, visibleUntil: start + 3 * hour })
    const trades: BybitTrade[] = []
    try {
      const scan = () => source.visitTrades({ fromUs: start * 1000, untilUs: (start + 3 * hour) * 1000 },
        trade => trades.push(trade), new AbortController().signal)
      expect(await scan()).toBe(false)
      expect(readPrimary).not.toHaveBeenCalled()
      expect(readFallback).not.toHaveBeenCalled()
      const published = vi.spyOn(okx, 'hasCloudDay').mockResolvedValue(true)
      const request = vi.spyOn(cloud, 'putFile')
      expect(await source.downloadDays('2026-10-20', '', vi.fn())).toBe('OKX 日档 1 天')
      expect(await scan()).toBe(true)
      expect(trades).toEqual([primary, secondary])
      expect(readFallback).toHaveBeenCalledExactlyOnceWith('SPYUSDT', start + 2 * hour)
      expect(published).toHaveBeenCalledExactlyOnceWith(instrument, '2026-10-20', undefined)
      expect(request).not.toHaveBeenCalled()
    } finally { source.release() }
  })
})
