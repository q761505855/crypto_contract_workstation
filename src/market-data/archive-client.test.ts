import { createHash } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { BinanceArchiveClient } from './archive-client'

const start = Date.UTC(2025, 8, 1)
const basename = 'BTCUSDT-1m-2025-09'
const header = 'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore'

function row(time = start): string[] {
  return [String(time), '100', '110', '90', '105', '10', String(time + 59_999), '1000', '12', '4', '400', '0']
}

function fixture(csv: string, name = `${basename}.csv`, checksum?: string, extra: Record<string, Uint8Array> = {}) {
  // fflate uses instanceof Uint8Array; jsdom's TextEncoder returns a Node realm array.
  const zip = zipSync({ [name]: new Uint8Array(strToU8(csv)), ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, new Uint8Array(value)])) })
  const digest = createHash('sha256').update(zip).digest('hex')
  const fetcher = vi.fn<typeof fetch>(async (input) => String(input).endsWith('.CHECKSUM')
    ? new Response(checksum ?? `${digest}  ${name.split('/').at(-1)!.replace(/\.csv$/, '.zip')}\n`)
    : new Response(new Uint8Array(zip)))
  return { fetcher, client: new BinanceArchiveClient(fetcher), zip }
}

describe('BinanceArchiveClient', () => {
  it('reads the verified monthly trade CSV into closed canonical minutes and leaves gaps visible', async () => {
    const { client, fetcher } = fixture(`${header}\r\n${row().join(',')}\r\n${row(start + 120_000).join(',')}\r\n`)
    const candles = await client.loadMonth('trade', 'btcusdt', 2025, 9)
    expect(candles).toEqual([
      { symbol: 'BTCUSDT', timeframe: '1m', openTime: start, closeTime: start + 59_999, open: '100', high: '110', low: '90', close: '105', volume: '10', quoteVolume: '1000', tradeCount: 12, isClosed: true, source: 'binance' },
      expect.objectContaining({ openTime: start + 120_000 }),
    ])
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2025-09.zip',
      'https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2025-09.zip.CHECKSUM',
    ])
  })

  it('uses daily mark archives without a header, isolates kinds and ignores unrelated members', async () => {
    const { client, fetcher } = fixture(row().join(','), `${basename}-01.csv`, undefined, { '../untrusted.csv': strToU8('invalid') })
    const candles = await client.loadDay('mark', 'BTCUSDT', 2025, 9, 1)
    expect(candles).toEqual([expect.objectContaining({ volume: '0', quoteVolume: '0', tradeCount: 0, isClosed: true })])
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://data.binance.vision/data/futures/um/daily/markPriceKlines/BTCUSDT/1m/BTCUSDT-1m-2025-09-01.zip')
  })

  it('returns null only when the ZIP is absent and does not fetch a checksum', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }))
    await expect(new BinanceArchiveClient(fetcher).loadMonth('trade', 'BTCUSDT', 2025, 9)).resolves.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([403, 429, 500])('reports ZIP HTTP %s rather than treating it as missing', async (status) => {
    const client = new BinanceArchiveClient(async () => new Response('', { status }))
    await expect(client.loadMonth('trade', 'BTCUSDT', 2025, 9)).rejects.toThrow(`HTTP ${status}`)
  })

  it('rejects a missing checksum for an existing archive', async () => {
    const { zip } = fixture(row().join(','))
    const client = new BinanceArchiveClient(async (input) => String(input).endsWith('.CHECKSUM')
      ? new Response('', { status: 404 }) : new Response(new Uint8Array(zip)))
    await expect(client.loadMonth('trade', 'BTCUSDT', 2025, 9)).rejects.toThrow(/校验.*404/)
  })

  it.each(['invalid', `${'0'.repeat(64)}  ${basename}.zip`, `${'a'.repeat(64)}  OTHER.zip`])('rejects invalid or mismatched checksum %s', async (checksum) => {
    const { client } = fixture(row().join(','), undefined, checksum)
    await expect(client.loadMonth('trade', 'BTCUSDT', 2025, 9)).rejects.toThrow(/校验/)
  })

  it('rejects a verified archive without the exact expected member', async () => {
    const { client } = fixture(row().join(','), `nested/${basename}.csv`, undefined)
    await expect(client.loadMonth('trade', 'BTCUSDT', 2025, 9)).rejects.toThrow(/缺少预期 CSV/)
  })

  it('rejects malformed mark fields even though canonical mark volumes are zero', async () => {
    const fields = row()
    fields[5] = '-1'
    const { client } = fixture(fields.join(','))
    await expect(client.loadMonth('mark', 'BTCUSDT', 2025, 9)).rejects.toThrow(/CSV/)
  })

  it('does not hide corrupt ZIPs or network failures as unavailable archives', async () => {
    const zip = new Uint8Array([0, 1, 2, 3])
    const digest = createHash('sha256').update(zip).digest('hex')
    const client = new BinanceArchiveClient(async (input) => String(input).endsWith('.CHECKSUM')
      ? new Response(`${digest}  ${basename}.zip`) : new Response(new Uint8Array(zip)))
    await expect(client.loadMonth('trade', 'BTCUSDT', 2025, 9)).rejects.toThrow(/归档.*读取失败/)
    await expect(new BinanceArchiveClient(async () => { throw new TypeError('offline') })
      .loadMonth('trade', 'BTCUSDT', 2025, 9)).rejects.toThrow(/BTCUSDT 2025-09.*offline/)
  })

  it.each([
    ['empty timestamp', 0, ''], ['nonminute timestamp', 0, String(start + 1)],
    ['out of period', 0, String(Date.UTC(2025, 7, 31, 23, 59))],
    ['invalid close time', 6, String(start + 60_000)], ['missing volume', 5, ''],
    ['missing quote volume', 7, ''], ['negative volume', 5, '-1'],
    ['noninteger trades', 8, '1.5'], ['negative trades', 8, '-1'],
    ['unsafe trades', 8, '9007199254740992'], ['nonfinite number', 4, 'Infinity'],
    ['invalid OHLC', 2, '99'], ['negative mark volume', 5, '-1'],
    ['invalid unused numeric field', 10, 'NaN'],
  ])('rejects malformed CSV: %s', async (_, index, value) => {
    const fields = row()
    fields[Number(index)] = String(value)
    const { client } = fixture(fields.join(','))
    await expect(client.loadMonth('trade', 'BTCUSDT', 2025, 9)).rejects.toThrow(/CSV|分钟|OHLC/)
  })

  it.each([
    ['duplicates', [row(), row()]],
    ['descending rows', [row(start + 60_000), row()]],
    ['missing columns', [row().slice(0, 8)]],
    ['extra columns', [[...row(), '0']]],
  ])('rejects %s without silently repairing it', async (_, rows) => {
    const { client } = fixture(rows.map((fields) => fields.join(',')).join('\n'))
    await expect(client.loadMonth('trade', 'BTCUSDT', 2025, 9)).rejects.toThrow(/CSV|顺序|重复/)
  })

  it('checks OHLC without losing decimal precision', async () => {
    const fields = row()
    fields[1] = '100.000000000000000002'
    fields[2] = '100.000000000000000001'
    fields[4] = '100'
    const { client } = fixture(fields.join(','))
    await expect(client.loadMonth('trade', 'BTCUSDT', 2025, 9)).rejects.toThrow(/OHLC/)
  })

  it('rejects empty CSV and malformed headers', async () => {
    for (const csv of ['', header, `${header.replace('high', 'unknown')}\n${row().join(',')}`]) {
      const { client } = fixture(csv)
      await expect(client.loadMonth('trade', 'BTCUSDT', 2025, 9)).rejects.toThrow(/CSV/)
    }
  })

  it('checks day boundaries and rejects unfinished future minutes', async () => {
    const { client } = fixture(row(start + 86_400_000).join(','), `${basename}-01.csv`)
    await expect(client.loadDay('trade', 'BTCUSDT', 2025, 9, 1)).rejects.toThrow(/CSV|范围/)
    const future = Date.UTC(2099, 0, 1)
    const futureClient = fixture(row(future).join(','), 'BTCUSDT-1m-2099-01.csv').client
    await expect(futureClient.loadMonth('trade', 'BTCUSDT', 2099, 1)).rejects.toThrow(/收盘|未来/)
  })

  it('rejects oversized responses before reading their body', async () => {
    const client = new BinanceArchiveClient(async () => new Response('small', { headers: { 'Content-Length': String(100 * 1024 * 1024) } }))
    await expect(client.loadMonth('trade', 'BTCUSDT', 2025, 9)).rejects.toThrow(/大小|过大/)
  })

  it('rejects oversized declared CSV members before decompression', async () => {
    const zip = zipSync({ [`${basename}.csv`]: new Uint8Array(strToU8(row().join(','))) })
    // The central directory declares a huge original size while compressed bytes stay small.
    for (let index = 0; index < zip.length - 28; index++) {
      if (zip[index] === 0x50 && zip[index + 1] === 0x4b && zip[index + 2] === 1 && zip[index + 3] === 2) {
        new DataView(zip.buffer).setUint32(index + 24, 100 * 1024 * 1024, true)
        break
      }
    }
    const digest = createHash('sha256').update(zip).digest('hex')
    const client = new BinanceArchiveClient(async (input) => String(input).endsWith('.CHECKSUM')
      ? new Response(`${digest}  ${basename}.zip`) : new Response(new Uint8Array(zip)))
    await expect(client.loadMonth('trade', 'BTCUSDT', 2025, 9)).rejects.toThrow(/大小|过大/)
  })

  it('honors cancellation before requests and between archive and checksum', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetcher = vi.fn<typeof fetch>()
    await expect(new BinanceArchiveClient(fetcher).loadMonth('trade', 'BTCUSDT', 2025, 9, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()

    const second = new AbortController()
    const { zip } = fixture(row().join(','))
    const interruptingFetcher = vi.fn<typeof fetch>(async () => {
      second.abort()
      return new Response(new Uint8Array(zip))
    })
    await expect(new BinanceArchiveClient(interruptingFetcher).loadMonth('trade', 'BTCUSDT', 2025, 9, { signal: second.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(interruptingFetcher).toHaveBeenCalledTimes(1)
    expect(interruptingFetcher.mock.calls[0]?.[1]?.signal).toBe(second.signal)
  })

  it('cancels an in-flight body read when the caller aborts', async () => {
    const controller = new AbortController()
    let reading!: () => void
    const started = new Promise<void>((resolve) => { reading = resolve })
    const cancelled = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ pull() { reading() }, cancel: cancelled })
    const client = new BinanceArchiveClient(async () => new Response(stream))
    const result = client.loadMonth('trade', 'BTCUSDT', 2025, 9, { signal: controller.signal })
    await started
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('rejects invalid dates and symbols before issuing a request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new BinanceArchiveClient(fetcher)
    await expect(client.loadDay('trade', 'BTCUSDT', 2025, 2, 30)).rejects.toThrow(/日期/)
    await expect(client.loadMonth('trade', '../BTCUSDT', 2025, 9)).rejects.toThrow(/交易对/)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
