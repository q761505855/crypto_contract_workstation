import { describe, expect, it } from 'vitest'
import {
  normalizeExchangeInfo,
  normalizeKline,
  normalizeKlines,
} from './normalizer'

const VALID_ROW = [
  1_700_000_000_000,
  '100.00',
  '110.00',
  '90.00',
  '105.00',
  '12.5',
  1_700_000_059_999,
  '1280.25',
  42,
  '0',
  '0',
  '0',
] as const

describe('Binance response normalization', () => {
  it('keeps only trading USDT perpetual contracts and sorts them', () => {
    const symbols = normalizeExchangeInfo({
      symbols: [
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
          symbol: 'BTCUSDT',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          contractType: 'PERPETUAL',
          status: 'TRADING',
          onboardDate: 1,
          pricePrecision: 1,
          quantityPrecision: 3,
        },
        {
          symbol: 'BTCUSDC',
          baseAsset: 'BTC',
          quoteAsset: 'USDC',
          contractType: 'PERPETUAL',
          status: 'TRADING',
        },
        {
          symbol: 'OLDUSDT',
          baseAsset: 'OLD',
          quoteAsset: 'USDT',
          contractType: 'PERPETUAL',
          status: 'CLOSE',
        },
      ],
    })

    expect(symbols.map((symbol) => symbol.symbol)).toEqual([
      'BTCUSDT',
      'ETHUSDT',
    ])
  })

  it('preserves decimal strings and marks completed trade candles', () => {
    const candle = normalizeKline(
      VALID_ROW,
      'btcusdt',
      '1m',
      'trade',
      VALID_ROW[6] + 1,
    )

    expect(candle).toMatchObject({
      symbol: 'BTCUSDT',
      open: '100.00',
      close: '105.00',
      volume: '12.5',
      quoteVolume: '1280.25',
      tradeCount: 42,
      isClosed: true,
    })
  })

  it('rejects retired mark-price normalization even for an empty response', () => {
    expect(() => normalizeKline(VALID_ROW, 'BTCUSDT', '1m', 'mark', VALID_ROW[6] - 1)).toThrow(/标记价格.*停用/)
    expect(() => normalizeKlines([], 'BTCUSDT', '1m', 'mark', Date.now())).toThrow(/标记价格.*停用/)
  })

  it('rejects malformed OHLC and deduplicates matching open times', () => {
    const malformed: unknown[] = [...VALID_ROW]
    malformed[2] = '99.00'
    expect(() =>
      normalizeKline(malformed, 'BTCUSDT', '1m', 'trade', Date.now()),
    ).toThrow('非法 OHLC')

    expect(
      normalizeKlines(
        [VALID_ROW, VALID_ROW],
        'BTCUSDT',
        '1m',
        'trade',
        Date.now(),
      ),
    ).toHaveLength(1)
  })
})
