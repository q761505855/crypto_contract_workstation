import { nextOpenTime } from './intervals'
import { BinanceRequestGuard, createBrowserRequestGuard } from './request-guard'
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
const PAGE_LIMIT = 499

type FetchLike = typeof fetch
type Sleep = (milliseconds: number) => Promise<void>

export interface DownloadRangeOptions {
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
  onPage?: (candles: readonly MarketCandle[]) => void | Promise<void>
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
  private requestQueue: Promise<unknown> = Promise.resolve()
  private pendingRequests = 0

  constructor(
    baseUrl = DEFAULT_BASE_URL,
    private readonly fetcher: FetchLike = fetch,
    private readonly now: () => number = Date.now,
    sleep: Sleep = defaultSleep,
    private readonly guard: BinanceRequestGuard = createBrowserRequestGuard(now, sleep),
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
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error('行情请求时间必须为有效时间戳')
    }
    to = Math.min(to, this.now())
    const result = new Map<number, MarketCandle>()
    let cursor = Math.max(0, from)
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
      await options.onPage?.(rows)
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

  private getJson(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const query = new URLSearchParams(params)
    const url = `${this.baseUrl}${path}${query.size > 0 ? `?${query}` : ''}`
    if (this.pendingRequests >= 2) {
      return Promise.reject(new Error('请求处理中，已停止新增远程请求，避免堆积；请稍后手动操作。'))
    }
    this.pendingRequests += 1
    const request = this.requestQueue
      .catch(() => undefined)
      .then(() => this.guard.request(
        () => this.fetcher.call(globalThis, url, {
          headers: { Accept: 'application/json' }, signal,
        }),
        signal,
      ))
      .finally(() => { this.pendingRequests -= 1 })
    this.requestQueue = request.catch(() => undefined)
    return request
  }
}

export { DEFAULT_BASE_URL }
