import { describe, expect, it, vi } from 'vitest'
import type {
  CandleKind,
  MarketCandle,
  MarketSymbol,
} from './models'
import type {
  MarketDataStore,
} from '../storage/market-data-store'
import type { BinanceRestClient } from './rest-client'
import type { DownloadRangeOptions } from './rest-client'
import { MarketDataService } from './market-data-service'

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

class MemoryStore implements MarketDataStore {
  symbols: MarketSymbol[] = []
  candles: Record<CandleKind, MarketCandle[]> = { trade: [], mark: [] }

  async putSymbols(symbols: readonly MarketSymbol[]) {
    this.symbols = [...symbols]
  }

  async getSymbols() {
    return [...this.symbols]
  }

  async putCandles(kind: CandleKind, candles: readonly MarketCandle[]) {
    const merged = new Map(
      this.candles[kind].map((item) => [item.openTime, item]),
    )
    candles.forEach((item) => merged.set(item.openTime, item))
    this.candles[kind] = [...merged.values()]
  }

  async getCandles(
    kind: CandleKind,
    _symbol: string,
    _timeframe: string,
    from: number,
    to: number,
  ) {
    return this.candles[kind].filter(
      (item) => item.openTime >= from && item.openTime <= to,
    )
  }

  async getSeriesSummary() {
    return {
      count: 0,
      firstOpenTime: null,
      lastOpenTime: null,
      gaps: [],
    }
  }

  async deleteSeries(kind: CandleKind) {
    this.candles[kind] = []
  }
}

describe('MarketDataService', () => {
  it('retries an aborted fallback replay batch on the next navigation without resetting all requests', async () => {
    const store = new MemoryStore()
    const controller = new AbortController()
    const downloadRange = vi.fn(async () => [candle(0)])
    downloadRange.mockImplementationOnce(async () => { controller.abort(); throw new DOMException('retired navigation', 'AbortError') })
    const service = new MarketDataService({ downloadRange } as unknown as BinanceRestClient, store)
    await expect(service.loadReplayCandles('trade', 'BTCUSDT', '1m', 0, 0, { signal: controller.signal, prefetchTo: 0 })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(service.loadReplayCandles('trade', 'BTCUSDT', '1m', 0, 0, { prefetchTo: 0 })).resolves.toEqual([candle(0)])
    expect(downloadRange).toHaveBeenCalledTimes(2)
  })
  it('fills a page ahead and reuses it for later replay steps', async () => {
    const store = new MemoryStore()
    const downloadRange = vi.fn(async (_kind, _symbol, _timeframe, from: number, to: number) =>
      Array.from({ length: (to - from) / 60_000 + 1 }, (_, index) => candle(from + index * 60_000)))
    const service = new MarketDataService({ downloadRange } as unknown as BinanceRestClient, store)
    await expect(service.loadReplayCandles('trade', 'BTCUSDT', '1m', 0, 0)).resolves.toEqual([candle(0)])
    expect(downloadRange).toHaveBeenCalledWith('trade', 'BTCUSDT', '1m', 0, 498 * 60_000, expect.any(Object))
    for (let index = 1; index < 30; index += 1) {
      await expect(service.loadReplayCandles('trade', 'BTCUSDT', '1m', index * 60_000, index * 60_000)).resolves.toEqual([candle(index * 60_000)])
    }
    expect(downloadRange).toHaveBeenCalledOnce()
  })

  it('combines nearby holes into a single request instead of one request per missing candle', async () => {
    const store = new MemoryStore()
    store.candles.trade = [candle(0), candle(2 * 60_000), candle(4 * 60_000)]
    const downloadRange = vi.fn(async (_kind, _symbol, _timeframe, from: number, to: number) =>
      Array.from({ length: (to - from) / 60_000 + 1 }, (_, index) => candle(from + index * 60_000)))
    const service = new MarketDataService({ downloadRange } as unknown as BinanceRestClient, store)
    await service.loadReplayCandles('trade', 'BTCUSDT', '1m', 0, 10 * 60_000, { prefetchTo: 10 * 60_000 })
    expect(downloadRange).toHaveBeenCalledOnce()
    expect(downloadRange).toHaveBeenCalledWith('trade', 'BTCUSDT', '1m', 60_000, 10 * 60_000, expect.any(Object))
  })

  it('shares an in-flight batch between overlapping replay windows', async () => {
    const store = new MemoryStore()
    const downloadRange = vi.fn(async (_kind, _symbol, _timeframe, from: number, to: number) =>
      Array.from({ length: (to - from) / 60_000 + 1 }, (_, index) => candle(from + index * 60_000)))
    const service = new MarketDataService({ downloadRange } as unknown as BinanceRestClient, store)
    const results = await Promise.all([
      service.loadReplayCandles('trade', 'BTCUSDT', '1m', 0, 2 * 60_000),
      service.loadReplayCandles('trade', 'BTCUSDT', '1m', 60_000, 4 * 60_000),
    ])
    expect(results.map((items) => items.length)).toEqual([3, 4])
    expect(downloadRange).toHaveBeenCalledOnce()
  })

  it('does not repeat a failed batch on every replay step and allows an explicit retry', async () => {
    const store = new MemoryStore()
    const downloadRange = vi.fn(async () => { throw new Error('HTTP 429 protection paused') })
    const service = new MarketDataService({ downloadRange } as unknown as BinanceRestClient, store)
    const onWarning = vi.fn()
    for (let index = 0; index < 5; index += 1) {
      await expect(service.loadReplayCandles('trade', 'BTCUSDT', '1m', index * 60_000, index * 60_000, { onWarning })).resolves.toEqual([])
    }
    expect(downloadRange).toHaveBeenCalledOnce()
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('不会逐根重试'))
    service.resetReplayRequests()
    await service.loadReplayCandles('trade', 'BTCUSDT', '1m', 0, 0)
    expect(downloadRange).toHaveBeenCalledTimes(2)
  })

  it('does not re-request a successfully attempted range that returned no data', async () => {
    const store = new MemoryStore()
    const downloadRange = vi.fn(async () => [])
    const service = new MarketDataService({ downloadRange } as unknown as BinanceRestClient, store)
    await service.loadReplayCandles('trade', 'BTCUSDT', '1m', 0, 60_000)
    await service.loadReplayCandles('trade', 'BTCUSDT', '1m', 60_000, 2 * 60_000)
    expect(downloadRange).toHaveBeenCalledOnce()
  })

  it('caps prefetch at the selected replay end', async () => {
    const store = new MemoryStore()
    const downloadRange = vi.fn(async () => [])
    const service = new MarketDataService({ downloadRange } as unknown as BinanceRestClient, store)
    await service.loadReplayCandles('trade', 'BTCUSDT', '1m', 0, 0, { prefetchTo: 5 * 60_000 })
    expect(downloadRange).toHaveBeenCalledWith('trade', 'BTCUSDT', '1m', 0, 5 * 60_000, expect.any(Object))
  })

  it('reads only completed cached candles and never downloads missing replay data', async () => {
    const store = new MemoryStore()
    store.candles.trade = [candle(0), { ...candle(60_000), isClosed: false }]
    const downloadRange = vi.fn()
    const service = new MarketDataService({ downloadRange } as unknown as BinanceRestClient, store)
    await expect(service.loadCachedCandles('trade', 'btcusdt', '1m', 0, 120_000)).resolves.toEqual([candle(0)])
    await expect(service.loadCachedCandles('trade', 'BTCUSDT', '1m', 120_000, 180_000)).resolves.toEqual([])
    expect(downloadRange).not.toHaveBeenCalled()
  })
  it('shares downloaded candles between concurrent overlapping requests', async () => {
    const store = new MemoryStore()
    const downloadRange = vi.fn(async (
      _kind, _symbol, _timeframe, from: number, to: number,
    ) => [0, 60_000, 120_000].filter((time) => time >= from && time <= to).map(candle))
    const service = new MarketDataService({ downloadRange } as unknown as BinanceRestClient, store)
    const results = await Promise.all([
      service.loadCandles('trade', 'BTCUSDT', '1m', 0, 60_000),
      service.loadCandles('trade', 'BTCUSDT', '1m', 0, 60_000),
      service.loadCandles('trade', 'BTCUSDT', '1m', 60_000, 120_000),
    ])
    expect(results.map((items) => items.map((item) => item.openTime))).toEqual([
      [0, 60_000], [0, 60_000], [60_000, 120_000],
    ])
    expect(downloadRange).toHaveBeenCalledTimes(2)
    expect(downloadRange.mock.calls[1]).toEqual([
      'trade', 'BTCUSDT', '1m', 120_000, 120_000, expect.any(Object),
    ])
  })

  it('does not download history before the symbol was listed', async () => {
    const store = new MemoryStore()
    const firstWeek = Date.UTC(2019, 8, 9)
    store.symbols = [{
      symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT',
      onboardDate: firstWeek + 86_400_000, contractType: 'PERPETUAL',
      status: 'TRADING', pricePrecision: 2, quantityPrecision: 3,
    }]
    const downloadRange = vi.fn(async () => [])
    const service = new MarketDataService({ downloadRange } as unknown as BinanceRestClient, store)
    await expect(service.loadCandles('trade', 'ETHUSDT', '1w', 0, firstWeek - 1)).resolves.toEqual([])
    expect(downloadRange).not.toHaveBeenCalled()
    await service.loadCandles('trade', 'ETHUSDT', '1w', Date.UTC(2013, 8, 16), firstWeek)
    expect(downloadRange).toHaveBeenCalledWith('trade', 'ETHUSDT', '1w', firstWeek, firstWeek, expect.any(Object))
  })

  it('shares an in-flight exchange information request', async () => {
    const store = new MemoryStore()
    const getExchangeSymbols = vi.fn(async () => [])
    const service = new MarketDataService({ getExchangeSymbols } as unknown as BinanceRestClient, store)
    await Promise.all([service.getSymbols(), service.getSymbols(), service.getSymbols()])
    expect(getExchangeSymbols).toHaveBeenCalledOnce()
  })

  it('does not call Binance when the requested range is fully cached', async () => {
    const store = new MemoryStore()
    store.candles.trade = [candle(0), candle(60_000), candle(120_000)]
    const downloadRange = vi.fn()
    const client = { downloadRange } as unknown as BinanceRestClient
    const service = new MarketDataService(client, store)

    await expect(
      service.loadCandles('trade', 'BTCUSDT', '1m', 0, 120_000),
    ).resolves.toHaveLength(3)
    expect(downloadRange).not.toHaveBeenCalled()
  })

  it('downloads only missing ranges and upserts the result', async () => {
    const store = new MemoryStore()
    store.candles.trade = [candle(0), candle(120_000)]
    const downloadRange = vi.fn(async () => [candle(60_000)])
    const client = { downloadRange } as unknown as BinanceRestClient
    const service = new MarketDataService(client, store)

    const result = await service.loadCandles(
      'trade',
      'BTCUSDT',
      '1m',
      0,
      120_000,
    )

    expect(downloadRange).toHaveBeenCalledOnce()
    expect(downloadRange).toHaveBeenCalledWith(
      'trade',
      'BTCUSDT',
      '1m',
      60_000,
      60_000,
      expect.any(Object),
    )
    expect(result.map((item) => item.openTime)).toEqual([
      0, 60_000, 120_000,
    ])
  })

  it('refreshes an unfinished cached candle before using it as history', async () => {
    const store = new MemoryStore()
    const stale = { ...candle(60_000), close: '1', isClosed: false }
    const replacement = { ...candle(60_000), close: '2', isClosed: true }
    store.candles.trade = [candle(0), stale, candle(120_000)]
    const downloadRange = vi.fn(async () => [replacement])
    const service = new MarketDataService(
      { downloadRange } as unknown as BinanceRestClient,
      store,
    )

    const result = await service.loadCandles(
      'trade',
      'BTCUSDT',
      '1m',
      0,
      120_000,
    )

    expect(downloadRange).toHaveBeenCalledOnce()
    expect(downloadRange).toHaveBeenCalledWith(
      'trade',
      'BTCUSDT',
      '1m',
      60_000,
      60_000,
      expect.any(Object),
    )
    expect(result).toContainEqual(replacement)
    expect(result).not.toContainEqual(stale)
  })

  it('returns available cache and warns when Binance is unavailable', async () => {
    const store = new MemoryStore()
    store.candles.trade = [candle(0)]
    const client = {
      downloadRange: vi.fn(async () => {
        throw new Error('offline')
      }),
    } as unknown as BinanceRestClient
    const service = new MarketDataService(client, store)
    const onWarning = vi.fn()

    await expect(
      service.loadCandles('trade', 'BTCUSDT', '1m', 0, 60_000, {
        onWarning,
      }),
    ).resolves.toEqual([candle(0)])
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('当前显示本地缓存'),
    )
  })

  it('force-refreshes the reconnect range even when a candle is cached', async () => {
    const store = new MemoryStore()
    store.candles.trade = [{ ...candle(60_000), close: '1', isClosed: false }]
    const replacement = { ...candle(60_000), close: '2', isClosed: true }
    const downloadRange = vi.fn(async () => [replacement])
    const service = new MarketDataService(
      { downloadRange } as unknown as BinanceRestClient,
      store,
    )

    await expect(
      service.refreshCandles('trade', 'btcusdt', '1m', 60_000, 60_000),
    ).resolves.toEqual([replacement])
    expect(downloadRange).toHaveBeenCalledWith(
      'trade',
      'BTCUSDT',
      '1m',
      60_000,
      60_000,
      expect.any(Object),
    )
    await expect(
      store.getCandles('trade', 'BTCUSDT', '1m', 60_000, 60_000),
    ).resolves.toEqual([replacement])
  })

  it('preserves downloaded pages when protection stops a later page', async () => {
    const store = new MemoryStore()
    const downloadRange = vi.fn(async (
      _kind, _symbol, _timeframe, _from, _to, options: DownloadRangeOptions,
    ) => {
      await options.onPage?.([candle(0), candle(60_000)])
      throw new Error('已达到本地保守请求上限')
    })
    const service = new MarketDataService({ downloadRange } as unknown as BinanceRestClient, store)
    const onWarning = vi.fn()
    await expect(service.loadCandles('trade', 'BTCUSDT', '1m', 0, 120_000, { onWarning })).resolves.toEqual([
      candle(0), candle(60_000),
    ])
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('本地保守请求上限'))
    expect(store.candles.trade).toHaveLength(2)
  })
})
