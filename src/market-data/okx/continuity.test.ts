import { describe, expect, it, vi } from 'vitest'
import { GitHubContentsClient } from '../../github-sync/github-client'
import { BybitArchive } from '../bybit/archive'
import { CombinedBybitSource } from '../bybit/combined-source'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, type BybitTrade } from '../bybit/trades'
import { OkxArchive, okxArchiveDay } from './archive'
import { getOkxTrades } from './live'
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
    const received = await getOkxTrades(instrument, start * 1000, (start + 2) * 1000, new AbortController().signal, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(received.map(trade => trade.id)).toEqual(Array.from({ length: 101 }, (_, index) => String(index + 2)))
    expect(received[0]).toMatchObject({ venue: 'OKX', side: 'sell', size: 0.25 })
  })

  it('优先使用 OKX，确认无成交的小时保持为空，缺档才读取 Bybit', async () => {
    const okx = new OkxArchive()
    const bybit = new BybitArchive()
    const primary = okxTrade(instrument, String(start + 1), '1', 'buy', '7000', '1')
    const secondary: BybitTrade = { ...primary, id: 'legacy', timeUs: (start + 2 * hour + 1) * 1000, venue: undefined }
    vi.spyOn(okx, 'loadHour').mockImplementation(async (_instrument, stamp) =>
      stamp === start ? [primary] : stamp === start + hour ? [] : null)
    const readFallback = vi.spyOn(bybit, 'loadHour').mockResolvedValue([secondary])
    const cloud = new GitHubContentsClient({ owner: 'owner', repository: 'store', branch: 'main' })
    const source = new CombinedBybitSource(cloud, vi.fn(), bybit, () => start + 4 * BYBIT_DAY_MS, okx)
    source.select(symbol, { sessionId: 'test', symbol: symbol.ticker, timeframe: '15m', currentTime: start + 3 * hour, visibleUntil: start + 3 * hour })
    const trades: BybitTrade[] = []
    try {
      expect(await source.visitTrades({ fromUs: start * 1000, untilUs: (start + 3 * hour) * 1000 },
        trade => trades.push(trade), new AbortController().signal)).toBe(true)
      expect(trades).toEqual([primary, secondary])
      expect(readFallback).toHaveBeenCalledExactlyOnceWith('SPYUSDT', start + 2 * hour)
      const published = vi.spyOn(okx, 'hasCloudDay').mockResolvedValue(true)
      const request = vi.spyOn(cloud, 'putFile')
      expect(await source.downloadDays('2026-10-20', '', vi.fn())).toContain('OKX 1 天')
      expect(published).toHaveBeenCalledExactlyOnceWith(instrument, '2026-10-20', undefined)
      expect(request).not.toHaveBeenCalled()
    } finally { source.release() }
  })
})
