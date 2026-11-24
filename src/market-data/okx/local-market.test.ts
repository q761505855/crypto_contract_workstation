import { describe, expect, it, vi } from 'vitest'
import type { OkxLocalFiles, OkxLocalTrade } from './local-files'
import { OkxLocalMarket } from './local-market'
import type { OkxMarketService } from './market'

const symbol = 'BTC-USDT-SWAP'
const date = (value: string) => Date.parse(value)
const day = date('2025-01-02T00:00:00Z')
const minute = 60_000
const hour = 60 * minute

function trade(id: string, time: number, price: number, size = 1): OkxLocalTrade {
  return { id, time, price: String(price), size: String(size), side: 'Buy' }
}

function marketFor(days: Record<string, OkxLocalTrade[]>) {
  const files = {
    revision: 0,
    restore: async () => {},
    list: async () => Object.keys(days).map(day => ({ day, symbol, filename: `${symbol}-trades-${day}.zip` })),
    scan: vi.fn(async (_symbol: string, date: string, accept: (trade: OkxLocalTrade) => void) => {
      const rows = days[date]
      rows?.forEach(accept)
      return !!rows
    }),
  }
  const exchange = { getSymbols: vi.fn() }
  const market = new OkxLocalMarket(files as unknown as OkxLocalFiles, exchange as unknown as OkxMarketService)
  return { market, files, exchange }
}

describe('OKX local trade candles', () => {
  it('builds OHLC from millisecond and numeric trade ID order and reuses lower-period aggregation', async () => {
    const { market, files, exchange } = marketFor({
      '2025-01-02': [trade('10', day + 999, 105, 3), trade('9', day + 999, 100, 2),
        trade('11', day + 2 * minute, 80, 5), trade('12', day + 4 * minute, 98)],
      '2025-01-03': [trade('13', day + 18 * hour, 130)],
    })
    const m = await market.loadCandles('trade', symbol, '1m', day, day + 4 * minute)
    expect(m.map(bar => bar.openTime)).toEqual([day, day + 2 * minute, day + 4 * minute])
    expect(m[0]).toMatchObject({ open: '100', high: '105', low: '100', close: '105',
      volume: '0.05', quoteVolume: '5.15', tradeCount: 2, isClosed: true, source: 'okx-local' })
    const [five] = await market.loadCandles('trade', symbol, '5m', day, day)
    expect(five).toMatchObject({ open: '100', low: '80', close: '98', volume: '0.11', tradeCount: 4 })
    const [oneHour] = await market.loadCandles('trade', symbol, '1h', day, day)
    expect(oneHour).toMatchObject({ low: '80', high: '105', close: '98', tradeCount: 4 })
    const [oneDay] = await market.loadCandles('trade', symbol, '1d', day, day)
    expect(oneDay).toMatchObject({ openTime: day, closeTime: day + 24 * hour - 1,
      open: '100', high: '130', low: '80', close: '130', volume: '0.12', tradeCount: 5, isClosed: true })
    expect(files.scan).toHaveBeenCalledTimes(2)
    expect(exchange.getSymbols).not.toHaveBeenCalled()
  })

  it('marks archive gaps as incomplete and invalidates aggregates when files change', async () => {
    const days = { '2025-01-02': [trade('1', day, 100)], '2025-01-06': [trade('2', day + 4 * 24 * hour, 110)] }
    const { market, files } = marketFor(days)
    const to = date('2025-01-06T00:00:00Z')
    const daily = await market.loadCandles('trade', symbol, '1d', day, to)
    expect(daily.map(bar => [bar.openTime, bar.isClosed])).toEqual([[day, false], [to, false]])
    const [month] = await market.loadCandles('trade', symbol, '1M', date('2025-01-01'), date('2025-01-01'))
    expect(month).toMatchObject({ open: '100', close: '110', isClosed: false, tradeCount: 2 })
    days['2025-01-02'] = [trade('1', day, 200)]
    files.revision++
    const older = await market.loadRecentCandlesPage(symbol, '1m', to - 1, {})
    expect(older.candles.map(bar => bar.close)).toEqual(['200'])
  })

  it('streams local order flow in trade order and reports missing date coverage', async () => {
    const { market } = marketFor({
      '2025-01-02': [trade('10', day + minute, 105), trade('9', day + minute, 100), trade('8', day, 90)],
    })
    const rows: string[] = []
    const coverage: boolean[] = []
    const end = day + 17 * hour
    const complete = await market.visitTrades(symbol, (day + 1) * 1000, end * 1000,
      trade => rows.push(trade.id), new AbortController().signal, (_, __, found) => coverage.push(found))
    expect(rows).toEqual(['9', '10'])
    expect(coverage).toEqual([true, false])
    expect(complete).toBe(false)
  })
})
