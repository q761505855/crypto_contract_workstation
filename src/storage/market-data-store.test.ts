import { describe, expect, it } from 'vitest'
import type { MarketCandle } from '../market-data/models'
import { IndexedDbMarketDataStore } from './market-data-store'

function candle(openTime: number): MarketCandle {
  return {
    symbol: 'BTCUSDT',
    timeframe: '1m',
    openTime,
    closeTime: openTime + 59_999,
    open: '1',
    high: '2',
    low: '0.5',
    close: '1.5',
    volume: '10',
    quoteVolume: '15',
    tradeCount: 2,
    isClosed: true,
    source: 'binance',
  }
}

describe('IndexedDbMarketDataStore', () => {
  it('rolls back an entire candle batch when a later record cannot be stored', async () => {
    const store = new IndexedDbMarketDataStore(`atomic-${crypto.randomUUID()}`)
    await expect(store.putCandles('trade', [candle(0), {...candle(60_000), openTime:NaN}])).rejects.toThrow()
    expect(await store.getCandles('trade','BTCUSDT','1m',0,120_000)).toEqual([])
  })
  it('creates the versioned stores, upserts compound keys, and reports gaps', async () => {
    const store = new IndexedDbMarketDataStore(`test-${crypto.randomUUID()}`)
    await store.putCandles('trade', [
      candle(0),
      candle(60_000),
      candle(60_000),
      candle(180_000),
    ])

    await expect(
      store.getCandles('trade', 'BTCUSDT', '1m', 0, 180_000),
    ).resolves.toHaveLength(3)
    await expect(
      store.getSeriesSummary('trade', 'BTCUSDT', '1m'),
    ).resolves.toEqual({
      count: 3,
      firstOpenTime: 0,
      lastOpenTime: 180_000,
      gaps: [{ from: 120_000, to: 120_000 }],
    })
    await expect(
      store.getCandles('mark', 'BTCUSDT', '1m', 0, 180_000),
    ).resolves.toEqual([])
  })

  it('stores symbols and deletes only the selected series', async () => {
    const store = new IndexedDbMarketDataStore(`test-${crypto.randomUUID()}`)
    await store.putSymbols([
      {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        contractType: 'PERPETUAL',
        status: 'TRADING',
        onboardDate: 1,
        pricePrecision: 2,
        quantityPrecision: 3,
      },
    ])
    await store.putCandles('trade', [candle(0)])
    await store.putCandles('mark', [candle(0)])

    await expect(store.getSymbols()).resolves.toHaveLength(1)
    await store.deleteSeries('trade', 'BTCUSDT', '1m')
    await expect(
      store.getCandles('trade', 'BTCUSDT', '1m', 0, 0),
    ).resolves.toEqual([])
    await expect(
      store.getCandles('mark', 'BTCUSDT', '1m', 0, 0),
    ).resolves.toHaveLength(1)
  })
})
