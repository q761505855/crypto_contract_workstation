import { expect, it, vi } from 'vitest'
import { OkxMarketService } from './market'

const minute = 60_000
const start = Date.UTC(2026, 10, 20, 16)
const ticker = 'BTC-USDT-SWAP'

it('builds synthetic OHLC and base-currency volume from contiguous OKX candles', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ code: '0', data: [
    [String(start + 3 * minute), '11', '14', '10', '13', '100', '2', '26', '1'],
    [String(start + 2 * minute), '10', '12', '8', '11', '100', '3', '33', '1'],
    [String(start + minute), '8', '11', '7', '10', '100', '1', '10', '1'],
    [String(start), '9', '10', '7', '8', '100', '4', '32', '1'],
  ] }))
  const market = new OkxMarketService(fetcher, undefined, () => start + 5 * minute)
  const rows = await market.loadCandles('trade', ticker, '4m', start, start)
  expect(rows).toMatchObject([{ source: 'okx', timeframe: '4m', open: '9', high: '14', low: '7',
    close: '13', volume: '10', quoteVolume: '101', closeTime: start + 4 * minute - 1, isClosed: true }])
  const history = new URL(String(fetcher.mock.calls[0][0]))
  expect(history.pathname).toBe('/api/v5/market/history-candles')
  expect(history.searchParams.get('after')).toBe(String(start + 4 * minute))
  expect(history.searchParams.get('bar')).toBe('1m')
})

it('uses UTC daily bars and rejects malformed OKX price rows', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ code: '0', data: [
    [String(start), '9', '8', '7', '9', '100', '4', '36', '1'],
  ] }))
  const market = new OkxMarketService(fetcher)
  await expect(market.loadCandles('trade', ticker, '1d', start, start)).rejects.toThrow('OKX K 线字段无效')
  expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('bar')).toBe('1Dutc')
})
