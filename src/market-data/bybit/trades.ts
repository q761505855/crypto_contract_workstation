import type { SymbolInfo } from '@klinecharts/pro'
import catalog from './instruments.json'

export type BybitSymbol = keyof typeof catalog.firstDays
export const BYBIT_DAY_MS = 86_400_000
export const BYBIT_HOUR_MS = 3_600_000

export interface BybitTrade {
  timeUs: number
  id: string
  side: 'buy' | 'sell'
  price: number
  size: number
}

export function bybitFirstDay(symbol: BybitSymbol): string { return catalog.firstDays[symbol] }
export function bybitCategory(symbol: BybitSymbol): 'spot' | 'linear' { return catalog.spot.includes(symbol) ? 'spot' : 'linear' }

export interface BybitMapping { symbol: BybitSymbol; relation: 'direct' | 'etf' | 'oil' }

export function bybitMapping(symbol: Pick<SymbolInfo, 'ticker' | 'exchange'>): BybitMapping | undefined {
  const ticker = symbol.ticker.toUpperCase()
  if (symbol.exchange !== 'CTRADER' || !Object.hasOwn(catalog.links, ticker)) return
  const [contract, relation] = catalog.links[ticker as keyof typeof catalog.links]
  return { symbol: contract as BybitSymbol, relation: relation as BybitMapping['relation'] }
}

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
