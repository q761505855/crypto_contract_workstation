import { describe, expect, it, vi } from 'vitest'
import { BinanceRestClient } from './rest-client'
import { BinanceRequestGuard } from './request-guard'

function createClient(
  baseUrl: string,
  fetcher: typeof fetch,
  now: () => number = Date.now,
  sleep: (milliseconds: number) => Promise<void> = async () => undefined,
) {
  let offset = 0
  const storage = new Map<string, string>()
  const clock = () => now() + offset
  const guard = new BinanceRequestGuard({
    now: clock,
    sleep: async (milliseconds) => { await sleep(milliseconds); offset += milliseconds },
    storage: () => ({ getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) } }),
    exclusive: async (action) => action(),
  })
  return new BinanceRestClient(baseUrl, fetcher, clock, sleep, guard)
}

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
    const client = createClient(
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
    const firstPage = Array.from({ length: 499 }, (_, index) =>
      row(index * minute),
    )
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(firstPage))
      .mockResolvedValueOnce(Response.json([row(499 * minute)]))
    const progress = vi.fn()
    const client = createClient(
      'https://example.test',
      fetcher as typeof fetch,
      () => 2_000 * minute,
    )

    const candles = await client.downloadRange(
      'trade',
      'BTCUSDT',
      '1m',
      0,
      499 * minute,
      { onProgress: progress },
    )

    expect(candles).toHaveLength(500)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1]?.[0]).toContain(
      `startTime=${499 * minute}`,
    )
    expect(fetcher.mock.calls[0]?.[0]).toContain('limit=499')
    expect(progress).toHaveBeenLastCalledWith({
      kind: 'trade',
      received: 1,
      stored: 500,
      page: 2,
    })
  })

  it('never retries even a short 429 response', async () => {
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
    const client = createClient(
      'https://example.test',
      fetcher as typeof fetch,
      Date.now,
      sleep,
    )

    await expect(client.downloadRange('mark', 'BTCUSDT', '5m', 0, 1)).rejects.toThrow('HTTP 429')
    expect(sleep).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('stops queued endpoints after an IP ban and never resumes automatically', async () => {
    let now = 1_000_000
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ msg: 'IP banned' }, {
        status: 418, headers: { 'Retry-After': '120' },
      }))
      .mockResolvedValueOnce(Response.json({ symbols: [] }))
    const sleep = vi.fn(async () => undefined)
    const client = createClient('https://example.test', fetcher, () => now, sleep)
    const results = await Promise.allSettled([
      client.downloadRange('trade', 'ETHUSDT', '15m', 0, 1),
      client.downloadRange('mark', 'BTCUSDT', '1w', 0, 1),
      client.getExchangeSymbols(),
    ])
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(results[0]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('HTTP 418') }) })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
    now += 120_001
    await expect(client.getExchangeSymbols()).rejects.toThrow('HTTP 418')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('respects the ban expiry in the error body when the header is unavailable', async () => {
    let now = Date.UTC(2026, 9, 26)
    const expiry = now + 600_000
    const fetcher = vi.fn(async () => Response.json({
      msg: `Way too many requests; IP banned until ${expiry}.`,
    }, { status: 418 }))
    const client = createClient('https://example.test', fetcher, () => now)
    await expect(client.getExchangeSymbols()).rejects.toThrow('HTTP 418')
    now += 300_000
    await expect(client.getExchangeSymbols()).rejects.toThrow('HTTP 418')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('does not retry a ban response without a readable JSON body or Retry-After', async () => {
    let now = 1_000_000
    const fetcher = vi.fn(async () => new Response('Access denied', { status: 418 }))
    const sleep = vi.fn(async () => undefined)
    const client = createClient('https://example.test', fetcher, () => now, sleep)
    await expect(client.getExchangeSymbols()).rejects.toThrow('已暂停新增远程请求')
    now += 60_000
    await expect(client.getExchangeSymbols()).rejects.toThrow('HTTP 418')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('blocks other endpoints instead of waiting on a long 429 cooldown', async () => {
    const fetcher = vi.fn(async () => new Response('{}', {
      status: 429, headers: { 'Retry-After': '60' },
    }))
    const sleep = vi.fn(async () => undefined)
    const client = createClient('https://example.test', fetcher, () => 1_000_000, sleep)
    await expect(client.getExchangeSymbols()).rejects.toThrow('HTTP 429')
    await expect(client.downloadRange('trade', 'BTCUSDT', '1m', 0, 1)).rejects.toThrow('HTTP 429')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('uses a conservative cooldown when a rate-limit response has no Retry-After', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 429 }))
    const sleep = vi.fn(async () => undefined)
    const client = createClient('https://example.test', fetcher, Date.now, sleep)
    await expect(client.getExchangeSymbols()).rejects.toThrow('HTTP 429')
    await expect(client.getExchangeSymbols()).rejects.toThrow('HTTP 429')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('paces and serializes concurrent requests', async () => {
    let now = 1_000_000
    let resolve!: (response: Response) => void
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
      .mockResolvedValueOnce(Response.json([]))
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds })
    const client = createClient('https://example.test', fetcher, () => now, sleep)
    const first = client.downloadRange('trade', 'BTCUSDT', '1m', 0, 1)
    const second = client.downloadRange('mark', 'BTCUSDT', '1m', 0, 1)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    resolve(Response.json([]))
    await Promise.all([first, second])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(2_000)
  })

  it('never sends negative timestamps and skips ranges entirely before the epoch', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([]))
    const client = createClient('https://example.test', fetcher)
    await expect(client.downloadRange('trade', 'ETHUSDT', '1w', -300_844_800_000, -1)).resolves.toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    await client.downloadRange('trade', 'ETHUSDT', '1w', -300_844_800_000, 345_600_000)
    expect(fetcher.mock.calls[0]?.[0]).toContain('startTime=0')
  })

  it('does not bypass a protection pause when the API base address changes', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 429 }))
    const client = createClient('https://example.test', fetcher)
    await expect(client.getExchangeSymbols()).rejects.toThrow('HTTP 429')
    client.setBaseUrl('https://other.test')
    await expect(client.getExchangeSymbols()).rejects.toThrow('HTTP 429')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('checkpoints a completed page before a later page triggers protection', async () => {
    const firstPage = Array.from({ length: 499 }, (_, index) => row(index * 60_000))
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(firstPage))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
    const client = createClient('https://example.test', fetcher, () => 100_000_000)
    const onPage = vi.fn()
    await expect(client.downloadRange('trade', 'BTCUSDT', '1m', 0, 1_000 * 60_000, { onPage })).rejects.toThrow('HTTP 429')
    expect(onPage).toHaveBeenCalledOnce()
    expect(onPage.mock.calls[0][0]).toHaveLength(499)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
