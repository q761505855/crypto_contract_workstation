import type { SymbolInfo } from '@klinecharts/pro'
import { writePreference } from '../storage/preference-events'
import { ctraderStorage } from '../storage/ctrader-storage'
import { normalizeMarketTicker } from './models'

export const SELECTED_SYMBOL_STORAGE_KEY = 'marketData.selectedSymbol'

export function validateSymbolTicker(value: unknown): string {
  const ticker = normalizeMarketTicker(value)
  if (ticker === undefined) throw new Error('交易品种代码无效')
  return ticker
}

export function validateSelectedSymbol(value: unknown): SymbolInfo {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('当前交易对配置无效')
  }
  const item = value as Record<string, unknown>
  const ticker = validateSymbolTicker(item.ticker)
  if (item.exchange !== 'CTRADER' && (ticker.length <= 4 || !ticker.endsWith('USDT'))) {
    throw new Error('当前交易品种必须是 cTrader 品种或旧版 USDT 交易对')
  }
  const symbol: SymbolInfo = { ticker }
  for (const key of ['name', 'shortName', 'exchange', 'market', 'priceCurrency', 'type', 'logo'] as const) {
    if (item[key] === undefined) continue
    if (typeof item[key] !== 'string') throw new Error(`当前交易对 ${key} 无效`)
    symbol[key] = item[key]
  }
  for (const key of ['pricePrecision', 'volumePrecision'] as const) {
    const precision = item[key]
    if (precision === undefined) continue
    if (typeof precision !== 'number' || !Number.isInteger(precision) || precision < 0 || precision > 20) {
      throw new Error(`当前交易对 ${key} 无效`)
    }
    symbol[key] = precision
  }
  return symbol
}

export function readSelectedSymbol(storage: Pick<Storage, 'getItem'> = ctraderStorage): SymbolInfo | null {
  try {
    const saved = storage.getItem(SELECTED_SYMBOL_STORAGE_KEY)
    return saved === null ? null : validateSelectedSymbol(JSON.parse(saved))
  } catch {
    return null
  }
}

export function saveSelectedSymbol(symbol: SymbolInfo, storage: Pick<Storage, 'setItem'> = ctraderStorage): void {
  try {
    writePreference(storage, SELECTED_SYMBOL_STORAGE_KEY, JSON.stringify(validateSelectedSymbol(symbol)))
  } catch {
    // Selecting a product remains usable when browser storage is unavailable.
  }
}
