import type { SymbolInfo } from '@klinecharts/pro'

const symbols = {
  SPYUSDT: { name: '标普 500 ETF 永续', precision: 2, firstDay: '2026-05-14' },
  QQQUSDT: { name: '纳斯达克 100 ETF 永续', precision: 2, firstDay: '2026-05-07' },
  XAUUSDT: { name: '黄金永续', precision: 2, firstDay: '2026-03-09' },
  BTCUSDT: { name: '比特币永续', precision: 2, firstDay: '2020-03-25' },
}

export type BybitSymbol = keyof typeof symbols
export const BYBIT_SYMBOLS = Object.keys(symbols) as BybitSymbol[]
export const BYBIT_DAY_MS = 86_400_000
export const BYBIT_HOUR_MS = 3_600_000

export interface BybitTrade {
  timeUs: number
  id: string
  side: 'buy' | 'sell'
  price: number
  size: number
}

export function bybitSymbol(value: string): BybitSymbol | undefined {
  return Object.hasOwn(symbols, value) ? value as BybitSymbol : undefined
}

export function bybitSymbolInfo(symbol: BybitSymbol): SymbolInfo {
  return { ticker: symbol, shortName: symbol, exchange: 'BYBIT', market: 'USDT 永续', type: 'PERPETUAL',
    name: symbols[symbol].name, priceCurrency: 'USDT', pricePrecision: symbols[symbol].precision, volumePrecision: 3 }
}

export function bybitFirstDay(symbol: BybitSymbol): string { return symbols[symbol].firstDay }

export function bybitDay(timestamp: number): string { return new Date(timestamp).toISOString().slice(0, 10) }

export function bybitDayStart(day: string): number {
  const time = Date.parse(day)
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(time) || bybitDay(time) !== day) {
    throw new Error('Bybit UTC 日期无效')
  }
  return time
}

export function bybitTrade(timeUs: number, id: unknown, side: unknown, price: unknown, size: unknown): BybitTrade {
  const amount = (value: unknown) => typeof value === 'string' && value.trim() ? Number(value) : NaN
  const parsedPrice = amount(price)
  const parsedSize = amount(size)
  if (!Number.isSafeInteger(timeUs) || timeUs <= 0 || typeof id !== 'string' || !/^[\w-]+$/.test(id) ||
      (side !== 'Buy' && side !== 'Sell') || !Number.isFinite(parsedPrice) || parsedPrice <= 0 ||
      !Number.isFinite(parsedSize) || parsedSize <= 0 || !Number.isFinite(parsedPrice * parsedSize)) {
    throw new Error('Bybit 逐笔成交格式无效')
  }
  return { timeUs, id, side: side === 'Buy' ? 'buy' : 'sell', price: parsedPrice, size: parsedSize }
}

export function bybitTradeTime(seconds: string): number {
  if (!/^\d+(?:\.\d{1,6})?$/.test(seconds)) throw new Error('Bybit 成交时间无效')
  const [whole, fraction = ''] = seconds.split('.')
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'))
}
