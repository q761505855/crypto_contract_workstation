import { nextOpenTime } from './intervals'
import {
  normalizeExchangeInfo,
  normalizeKlines,
} from './normalizer'
import type {
  CandleKind,
  DownloadProgress,
  MarketCandle,
  MarketSymbol,
} from './models'

const DEFAULT_BASE_URL = 'https://fapi.binance.com'
const PAGE_LIMIT = 1_000
const MAX_RETRIES = 3

type FetchLike = typeof fetch
type Sleep = (milliseconds: number) => Promise<void>

export interface DownloadRangeOptions {
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
}

function normalizedBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('行情基础地址必须使用 HTTP 或 HTTPS')
  }
  return url.toString().replace(/\/$/, '')
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

export class BinanceRestClient {
  private baseUrl: string

  constructor(
    baseUrl = DEFAULT_BASE_URL,
    private readonly fetcher: FetchLike = fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = defaultSleep,
  ) {
    this.baseUrl = normalizedBaseUrl(baseUrl)
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizedBaseUrl(baseUrl)
  }

  async getExchangeSymbols(signal?: AbortSignal): Promise<MarketSymbol[]> {
    const payload = await this.getJson('/fapi/v1/exchangeInfo', {}, signal)
    return normalizeExchangeInfo(payload)
  }

  async downloadRange(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
    from: number,
    to: number,
    options: DownloadRangeOptions = {},
  ): Promise<MarketCandle[]> {
    const result = new Map<number, MarketCandle>()
    let cursor = from
    let page = 0

    while (cursor <= to) {
      const payload = await this.getJson(
        kind === 'trade'
          ? '/fapi/v1/klines'
          : '/fapi/v1/markPriceKlines',
        {
          symbol: symbol.toUpperCase(),
          interval: timeframe,
          startTime: String(cursor),
          endTime: String(to),
          limit: String(PAGE_LIMIT),
        },
        options.signal,
      )
      const rows = normalizeKlines(
        payload,
        symbol,
        timeframe,
        kind,
        this.now(),
      )
      page += 1
      for (const candle of rows) {
        result.set(candle.openTime, candle)
      }
      options.onProgress?.({
        kind,
        received: rows.length,
        stored: result.size,
        page,
      })
      if (rows.length === 0 || rows.length < PAGE_LIMIT) {
        break
      }
      const nextCursor = nextOpenTime(rows.at(-1)!.openTime, timeframe)
      if (nextCursor <= cursor) {
        throw new Error('币安 K 线分页游标没有前进')
      }
      cursor = nextCursor
    }

    return [...result.values()].sort(
      (left, right) => left.openTime - right.openTime,
    )
  }

  private async getJson(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const query = new URLSearchParams(params)
    const url = `${this.baseUrl}${path}${query.size > 0 ? `?${query}` : ''}`

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      let response: Response
      try {
        response = await this.fetcher.call(globalThis, url, {
          headers: { Accept: 'application/json' },
          signal,
        })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error
        }
        throw new Error(
          `无法连接币安公开行情接口：${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }

      if (response.ok) {
        return response.json()
      }

      if ((response.status === 418 || response.status === 429) && attempt < 2) {
        const retryAfter = Number(response.headers.get('Retry-After'))
        const waitMilliseconds = Number.isFinite(retryAfter)
          ? Math.max(1_000, retryAfter * 1_000)
          : 1_000 * 2 ** attempt
        await this.sleep(waitMilliseconds)
        continue
      }

      let detail = ''
      try {
        const payload = (await response.json()) as {
          code?: unknown
          msg?: unknown
        }
        if (typeof payload.msg === 'string') {
          detail = `：${payload.msg}`
        }
      } catch {
        // The HTTP status remains sufficient when the body is not JSON.
      }
      throw new Error(`币安行情请求失败（HTTP ${response.status}）${detail}`)
    }

    throw new Error('币安行情请求重试次数已用尽')
  }
}

export { DEFAULT_BASE_URL }
