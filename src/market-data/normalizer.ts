import type { MarketCandle, MarketSymbol } from './models'

type BinanceKlineRow = readonly unknown[]

interface BinanceExchangeSymbol {
  symbol?: unknown
  baseAsset?: unknown
  quoteAsset?: unknown
  contractType?: unknown
  status?: unknown
  onboardDate?: unknown
  pricePrecision?: unknown
  quantityPrecision?: unknown
}

interface BinanceExchangeInfo {
  symbols?: unknown
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`币安响应缺少 ${field}`)
  }
  return value
}

function requiredFiniteNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`币安响应中的 ${field} 不是有效数字`)
  }
  return parsed
}

function decimalString(value: unknown, field: string): string {
  const text = requiredString(value, field)
  const parsed = Number(text)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`币安响应中的 ${field} 不是有效非负数`)
  }
  return text
}

export function normalizeExchangeInfo(payload: unknown): MarketSymbol[] {
  const rows = (payload as BinanceExchangeInfo | null)?.symbols
  if (!Array.isArray(rows)) {
    throw new Error('币安交易对列表响应格式无效')
  }

  return rows
    .filter((item): item is BinanceExchangeSymbol => {
      if (item === null || typeof item !== 'object') {
        return false
      }
      const candidate = item as BinanceExchangeSymbol
      return (
        candidate.quoteAsset === 'USDT' &&
        candidate.contractType === 'PERPETUAL' &&
        candidate.status === 'TRADING'
      )
    })
    .map((item) => ({
      symbol: requiredString(item.symbol, 'symbol'),
      baseAsset: requiredString(item.baseAsset, 'baseAsset'),
      quoteAsset: 'USDT',
      contractType: 'PERPETUAL' as const,
      status: 'TRADING' as const,
      onboardDate: requiredFiniteNumber(item.onboardDate ?? 0, 'onboardDate'),
      pricePrecision: requiredFiniteNumber(
        item.pricePrecision ?? 8,
        'pricePrecision',
      ),
      quantityPrecision: requiredFiniteNumber(
        item.quantityPrecision ?? 8,
        'quantityPrecision',
      ),
    }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
}

export function normalizeKline(
  row: BinanceKlineRow,
  symbol: string,
  timeframe: string,
  kind: 'trade' | 'mark',
  now: number,
): MarketCandle {
  if (!Array.isArray(row) || row.length < 7) {
    throw new Error('币安 K 线响应格式无效')
  }

  const openTime = requiredFiniteNumber(row[0], 'openTime')
  const open = decimalString(row[1], 'open')
  const high = decimalString(row[2], 'high')
  const low = decimalString(row[3], 'low')
  const close = decimalString(row[4], 'close')
  const closeTime = requiredFiniteNumber(row[6], 'closeTime')
  const volume = kind === 'trade' ? decimalString(row[5], 'volume') : '0'
  const quoteVolume =
    kind === 'trade' ? decimalString(row[7] ?? '0', 'quoteVolume') : '0'
  const tradeCount =
    kind === 'trade'
      ? requiredFiniteNumber(row[8] ?? 0, 'tradeCount')
      : 0

  const numericOpen = Number(open)
  const numericHigh = Number(high)
  const numericLow = Number(low)
  const numericClose = Number(close)
  if (
    numericHigh < Math.max(numericOpen, numericClose) ||
    numericLow > Math.min(numericOpen, numericClose) ||
    numericHigh < numericLow ||
    closeTime < openTime
  ) {
    throw new Error(`币安返回了非法 OHLC K 线：${symbol} ${timeframe} ${openTime}`)
  }

  return {
    symbol: symbol.toUpperCase(),
    timeframe,
    openTime,
    closeTime,
    open,
    high,
    low,
    close,
    volume,
    quoteVolume,
    tradeCount,
    isClosed: closeTime < now,
    source: 'binance',
  }
}

export function normalizeKlines(
  payload: unknown,
  symbol: string,
  timeframe: string,
  kind: 'trade' | 'mark',
  now: number,
): MarketCandle[] {
  if (!Array.isArray(payload)) {
    throw new Error('币安 K 线响应不是数组')
  }
  const unique = new Map<number, MarketCandle>()
  for (const row of payload) {
    const candle = normalizeKline(
      row as BinanceKlineRow,
      symbol,
      timeframe,
      kind,
      now,
    )
    unique.set(candle.openTime, candle)
  }
  return [...unique.values()].sort(
    (left, right) => left.openTime - right.openTime,
  )
}
