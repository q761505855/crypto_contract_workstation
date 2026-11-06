import { describe, expect, it, vi } from 'vitest'
import type { MarketCandle } from '../market-data/models'
import { IndexedDbMarketDataStore, openWorkstationDatabase } from './market-data-store'

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
  it('commits more than two bursts in one atomic transaction', async () => {
    const databaseName = `burst-success-${crypto.randomUUID()}`
    await openWorkstationDatabase(databaseName)
    const store = new IndexedDbMarketDataStore(databaseName)
    const rows = Array.from({ length: 2501 }, (_, index) => candle(index * 60_000))
    const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction')
    try {
      await store.putCandles('trade', rows)
      expect(transactions).toHaveBeenCalledTimes(1)
    } finally {
      transactions.mockRestore()
    }
    expect(await store.getCandles('trade', 'BTCUSDT', '1m', 0, rows.at(-1)!.openTime)).toEqual(rows)
  })

  it('stops enqueueing after the first burst is cancelled and rolls back completed requests', async () => {
    const store = new IndexedDbMarketDataStore(`burst-cancel-${crypto.randomUUID()}`)
    const previous = [candle(0), candle(3000 * 60_000)]
    await store.putCandles('trade', previous)
    const rows = Array.from({ length: 2501 }, (_, index) => ({ ...candle(index * 60_000), close: '1.8' }))
    const controller = new AbortController()
    const nativePut = IDBObjectStore.prototype.put
    let queued = 0
    let queuedAtCancel = 0
    const write = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = key === undefined ? nativePut.call(this, value) : nativePut.call(this, value, key)
      if (this.name === 'tradeCandles' && ++queued === 1000) {
        request.addEventListener('success', () => {
          queuedAtCancel = queued
          controller.abort(new Error('new period owns the chart'))
        }, { once: true })
      }
      return request
    })
    try {
      await expect(store.putCandles('trade', rows, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      write.mockRestore()
    }
    expect(queuedAtCancel).toBe(1000)
    expect(queued).toBe(1000)
    expect(await store.getCandles('trade', 'BTCUSDT', '1m', 0, previous.at(-1)!.openTime)).toEqual(previous)
  })

  it('reports a synchronous native put failure from a later burst and rolls back earlier bursts', async () => {
    const store = new IndexedDbMarketDataStore(`burst-failure-${crypto.randomUUID()}`)
    const previous = candle(0)
    await store.putCandles('trade', [previous])
    const rows = Array.from({ length: 2501 }, (_, index) => ({ ...candle(index * 60_000), close: '1.8' }))
    rows[1001].openTime = NaN
    await expect(store.putCandles('trade', rows)).rejects.toMatchObject({ name: 'DataError' })
    expect(await store.getCandles('trade', 'BTCUSDT', '1m', 0, 3000 * 60_000)).toEqual([previous])
  })

  it('rejects a pre-cancelled batch without writing and preserves committed candles', async () => {
    const store = new IndexedDbMarketDataStore(`pre-cancel-${crypto.randomUUID()}`)
    await store.putCandles('trade', [candle(0)])
    const controller = new AbortController()
    controller.abort(new Error('cancelled by navigation'))
    await expect(store.putCandles('trade', [candle(60_000)], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(await store.getCandles('trade', 'BTCUSDT', '1m', 0, 120_000)).toEqual([candle(0)])
  })

  it('aborts an active native transaction and rolls back the entire batch while preserving previous commits', async () => {
    const store = new IndexedDbMarketDataStore(`mid-cancel-${crypto.randomUUID()}`)
    await store.putCandles('trade', [candle(0)])
    const controller = new AbortController()
    const nativePut = IDBObjectStore.prototype.put
    let observed = false
    const write = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = key === undefined ? nativePut.call(this, value) : nativePut.call(this, value, key)
      if (this.name === 'tradeCandles' && !observed) {
        observed = true
        request.addEventListener('success', () => controller.abort(new Error('new chart period')), { once: true })
      }
      return request
    })
    try {
      const update = { ...candle(0), close: '1.8' }
      await expect(store.putCandles('trade', [update, candle(60_000), candle(120_000)], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      write.mockRestore()
    }
    expect(observed).toBe(true)
    expect(await store.getCandles('trade', 'BTCUSDT', '1m', 0, 120_000)).toEqual([candle(0)])
    await store.putCandles('trade', [candle(180_000)])
    expect(await store.getCandles('trade', 'BTCUSDT', '1m', 0, 180_000)).toEqual([candle(0), candle(180_000)])
  })

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
