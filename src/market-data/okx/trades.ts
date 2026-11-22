import type { SymbolInfo } from '@klinecharts/pro'
import { bybitMapping, type BybitMapping, type BybitTrade } from '../bybit/trades'
import catalog from './instruments.json'

export interface OkxInstrument {
  symbol: string
  contractValue: number
  firstDay: string
}

export interface OrderFlowMapping {
  symbol: string
  relation: BybitMapping['relation']
  okx?: OkxInstrument
  bybit?: BybitMapping
}

export function orderFlowMapping(symbol: Pick<SymbolInfo, 'ticker' | 'exchange'>): OrderFlowMapping | undefined {
  if (symbol.exchange !== 'CTRADER') return
  const ticker = symbol.ticker.toUpperCase()
  const entry = Object.hasOwn(catalog, ticker) ? catalog[ticker as keyof typeof catalog] : undefined
  const alias = ticker === 'US100' || ticker === 'NAS100' ? 'USTEC' : ticker
  const bybit = bybitMapping({ ...symbol, ticker: alias })
  if (!entry) return bybit && { ...bybit, bybit }
  const [instrument, contractValue, firstDay] = entry as [string, number, string]
  return { symbol: instrument, relation: bybit?.relation ?? 'direct', bybit,
    okx: { symbol: instrument, contractValue, firstDay } }
}

export function orderFlowLabel(mapping: OrderFlowMapping): string {
  return [mapping.okx && `OKX ${mapping.okx.symbol}`, mapping.bybit && `Bybit ${mapping.bybit.symbol}`].filter(Boolean).join(' / ')
}

export function okxTrade(instrument: OkxInstrument, time: string, id: string, side: string,
  price: string, contracts: string): BybitTrade {
  const timeUs = Number(time) * 1000
  const px = Number(price)
  const size = Number(contracts) * instrument.contractValue
  if (!Number.isSafeInteger(timeUs) || timeUs <= 0 || typeof id !== 'string' || !/^\d+$/.test(id) ||
      (side !== 'buy' && side !== 'sell') || !(px > 0) || !(size > 0) || !Number.isFinite(px * size)) {
    throw new Error('OKX 逐笔成交格式无效')
  }
  return { id, timeUs, price: px, size, side, venue: 'OKX' }
}

export function compareTrades(a: BybitTrade, b: BybitTrade): number {
  return a.timeUs - b.timeUs || a.id.length - b.id.length || (a.id < b.id ? -1 : a.id === b.id ? 0 : 1)
}

export function mergeOkxTrades(first: readonly BybitTrade[], second: readonly BybitTrade[]): BybitTrade[] {
  const trades = new Map(first.map(trade => [trade.id, trade]))
  for (const trade of second) trades.set(trade.id, trade)
  return [...trades.values()].sort(compareTrades)
}
