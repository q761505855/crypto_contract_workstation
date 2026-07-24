import { describe, expect, it, vi } from 'vitest'
import { BinanceRestClient } from './rest-client'

function row(openTime: number): unknown[] {
  return [
    openTime,
    '100',
    '110',
    '90',
    '105',
    '10',
    openTime + 59_999,
    '1000',
    12,
    '0',
    '0',
    '0',
  ]
}

describe('BinanceRestClient', () => {
  it('filters exchange information through the public futures endpoint', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        symbols: [
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
        ],
      }),
    )
    const client = new BinanceRestClient(
      'https://example.test',
      fetcher as typeof fetch,
    )

    await expect(client.getExchangeSymbols()).resolves.toEqual([
      expect.objectContaining({ symbol: 'BTCUSDT' }),
    ])
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.test/fapi/v1/exchangeInfo',
      expect.objectContaining({ signal: undefined }),
    )
  })

  it('automatically pages and advances from the last open time', async () => {
    const minute = 60_000
    const firstPage = Array.from({ length: 1_000 }, (_, index) =>
      row(index * minute),
    )
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(firstPage))
      .mockResolvedValueOnce(Response.json([row(1_000 * minute)]))
    const progress = vi.fn()
    const client = new BinanceRestClient(
      'https://example.test',
      fetcher as typeof fetch,
      () => 2_000 * minute,
    )

    const candles = await client.downloadRange(
      'trade',
      'BTCUSDT',
      '1m',
      0,
      1_000 * minute,
      { onProgress: progress },
    )

    expect(candles).toHaveLength(1_001)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1]?.[0]).toContain(
      `startTime=${1_000 * minute}`,
    )
    expect(progress).toHaveBeenLastCalledWith({
      kind: 'trade',
      received: 1,
      stored: 1_001,
      page: 2,
    })
  })

  it('backs off once after a rate-limit response', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{}', {
          status: 429,
          headers: { 'Retry-After': '2' },
        }),
      )
      .mockResolvedValueOnce(Response.json([]))
    const sleep = vi.fn(async () => undefined)
    const client = new BinanceRestClient(
      'https://example.test',
      fetcher as typeof fetch,
      Date.now,
      sleep,
    )

    await client.downloadRange('mark', 'BTCUSDT', '5m', 0, 1)
    expect(sleep).toHaveBeenCalledWith(2_000)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
