import { describe, expect, it, vi } from 'vitest'
import type { MarketDataService } from './market-data-service'
import { BinanceDatafeed } from './binance-datafeed'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import type { LiveStreamSubscriptionInput } from './live-stream'
import { readIndicatorHistory } from './indicator-history'

describe('BinanceDatafeed', () => {
  it('uses normal candle loading for indicator history without changing chart selection', async () => {
    const loadCandles = vi.fn(async () => [])
    const feed = new BinanceDatafeed({ loadCandles } as unknown as MarketDataService)
    const selection = vi.fn()
    feed.setSelectionListener(selection)
    await readIndicatorHistory(feed, DEFAULT_SYMBOL, SUPPORTED_PERIODS[0], 0, 60_000)
    expect(loadCandles).toHaveBeenCalledOnce()
    expect(selection).not.toHaveBeenCalled()
  })

  it('searches the dynamic USDT perpetual symbol list', async () => {
    const service = {
      getSymbols: vi.fn(async () => [
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
        {
          symbol: 'ETHUSDT',
          baseAsset: 'ETH',
          quoteAsset: 'USDT',
          contractType: 'PERPETUAL',
          status: 'TRADING',
          onboardDate: 2,
          pricePrecision: 2,
          quantityPrecision: 3,
        },
      ]),
    } as unknown as MarketDataService
    const datafeed = new BinanceDatafeed(service)

    await expect(datafeed.searchSymbols('eth')).resolves.toEqual([
      expect.objectContaining({ ticker: 'ETHUSDT' }),
    ])
  })

  it('keeps the complete symbol list independent from favorites', async () => {
    const service = {
      getSymbols: vi.fn(async () => [
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
        {
          symbol: 'ETHUSDT',
          baseAsset: 'ETH',
          quoteAsset: 'USDT',
          contractType: 'PERPETUAL',
          status: 'TRADING',
          onboardDate: 2,
          pricePrecision: 2,
          quantityPrecision: 3,
        },
        {
          symbol: 'SOLUSDT',
          baseAsset: 'SOL',
          quoteAsset: 'USDT',
          contractType: 'PERPETUAL',
          status: 'TRADING',
          onboardDate: 3,
          pricePrecision: 3,
          quantityPrecision: 0,
        },
      ]),
    } as unknown as MarketDataService
    const datafeed = new BinanceDatafeed(service)

    await expect(datafeed.searchSymbols()).resolves.toEqual([
      expect.objectContaining({ ticker: 'BTCUSDT' }),
      expect.objectContaining({ ticker: 'ETHUSDT' }),
      expect.objectContaining({ ticker: 'SOLUSDT' }),
    ])
    await expect(datafeed.searchSymbols('sol')).resolves.toEqual([
      expect.objectContaining({ ticker: 'SOLUSDT' }),
    ])
  })

  it('caps chart requests to one low-weight page and maps stored decimals', async () => {
    const loadCandles = vi.fn(async () => [
      {
        symbol: 'BTCUSDT',
        timeframe: '1m',
        openTime: 60_000,
        closeTime: 119_999,
        open: '1.25',
        high: '2.5',
        low: '1',
        close: '2',
        volume: '10',
        quoteVolume: '20',
        tradeCount: 1,
        isClosed: true,
        source: 'binance',
      },
    ])
    const service = { loadCandles } as unknown as MarketDataService
    const datafeed = new BinanceDatafeed(service)
    const period = SUPPORTED_PERIODS[0]
    const selectionListener = vi.fn()
    datafeed.setSelectionListener(selectionListener)

    await expect(
      datafeed.getHistoryKLineData(
        DEFAULT_SYMBOL,
        period,
        0,
        1_000 * 60_000,
      ),
    ).resolves.toEqual([
      {
        timestamp: 60_000,
        open: 1.25,
        high: 2.5,
        low: 1,
        close: 2,
        volume: 10,
        turnover: 20,
      },
    ])
    expect(loadCandles).toHaveBeenCalledWith(
      'trade',
      'BTCUSDT',
      '1m',
      502 * 60_000,
      1_000 * 60_000,
      expect.any(Object),
    )
    expect(selectionListener).toHaveBeenCalledWith({
      symbol: DEFAULT_SYMBOL,
      period,
    })
  })

  it('starts and stops WebSocket work only while live mode is enabled', () => {
    let subscriptionInput: LiveStreamSubscriptionInput | null = null
    const stop = vi.fn()
    const liveStream = {
      setKeepAlive: vi.fn(),
      subscribe: vi.fn((input: LiveStreamSubscriptionInput) => {
        subscriptionInput = input
        return stop
      }),
    }
    const datafeed = new BinanceDatafeed(
      {} as MarketDataService,
      liveStream,
    )
    const callback = vi.fn()
    const statusListener = vi.fn()
    datafeed.setLiveStatusListener(statusListener)
    datafeed.subscribe(
      DEFAULT_SYMBOL,
      SUPPORTED_PERIODS[0],
      callback,
    )
    expect(liveStream.subscribe).not.toHaveBeenCalled()

    datafeed.setLiveEnabled(true)
    expect(liveStream.setKeepAlive).toHaveBeenLastCalledWith(true)
    expect(liveStream.subscribe).toHaveBeenCalledOnce()
    expect(subscriptionInput).toMatchObject({
      symbol: 'BTCUSDT',
      timeframe: '1m',
    })
    subscriptionInput!.onStatus({
      connection: 'connected',
      lastMessageTime: 1,
      latencyMs: 2,
      candleClosed: false,
      lastPrice: '101',
      markPrice: '100',
      reconnectAttempt: 0,
      warning: '',
    })
    expect(statusListener).toHaveBeenLastCalledWith(
      expect.objectContaining({ connection: 'connected' }),
    )

    datafeed.setLiveEnabled(false)
    expect(liveStream.setKeepAlive).toHaveBeenLastCalledWith(false)
    expect(stop).toHaveBeenCalledOnce()
    expect(statusListener).toHaveBeenLastCalledWith(
      expect.objectContaining({ connection: 'disconnected' }),
    )
  })
})
