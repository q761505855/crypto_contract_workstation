import type { SymbolInfo } from '@klinecharts/pro'
import { writePreference } from '../storage/preference-events'
import { ctraderStorage } from '../storage/ctrader-storage'
import { normalizeMarketTicker } from './models'

export const SELECTED_SYMBOL_STORAGE_KEY = 'marketData.selectedSymbol'
export const OKX_SYMBOL_STORAGE_KEY = 'marketData.okxSelectedSymbol.v1'
export const DATABENTO_SYMBOL_STORAGE_KEY = 'marketData.databentoSelectedSymbol.v1'

export function validateSelectedDatabentoSymbol(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9._-]{0,63}$/i.test(value)) {
    throw new Error('当前 Databento 品种须为有效的产品子文件夹名称')
  }
  return value.toUpperCase()
}

export function readSelectedDatabentoSymbol(storage: Pick<Storage, 'getItem'> = ctraderStorage): string | null {
  try {
    const saved = storage.getItem(DATABENTO_SYMBOL_STORAGE_KEY)
    return saved === null ? null : validateSelectedDatabentoSymbol(JSON.parse(saved))
  } catch { return null }
}

export function validateSymbolTicker(value: unknown): string {
  const ticker = normalizeMarketTicker(value)
  if (ticker === undefined) throw new Error('交易品种代码无效')
  return ticker
}

export function validateSelectedSymbol(value: unknown): SymbolInfo {
  return validateProduct(value, 'ctrader')
}

export function validateDatabentoReplaySymbol(value: unknown): SymbolInfo {
  return validateProduct(value, 'cme')
}

function validateProduct(value: unknown, source: 'okx' | 'cme' | 'ctrader'): SymbolInfo {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('当前交易对配置无效')
  }
  const item = value as Record<string, unknown>
  const ticker = source === 'cme' ? validateSelectedDatabentoSymbol(item.ticker) : validateSymbolTicker(item.ticker)
  if (source === 'cme' && (item.exchange !== 'CME' || item.type !== 'FUTURES')) throw new Error('Databento 回放产品必须是 CME 期货')
  if (source === 'okx' && !/^[A-Z0-9]+-USDT-SWAP$/.test(ticker) ||
    source === 'ctrader' && (item.exchange === 'OKX' || item.exchange === 'CME' ||
      (item.exchange !== 'CTRADER' && (ticker.length <= 4 || !ticker.endsWith('USDT'))))) {
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

export function validateSelectedOkxSymbol(value: unknown): SymbolInfo {
  const symbol = validateProduct(value, 'okx')
  if (symbol.exchange !== 'OKX' || symbol.priceCurrency !== 'USDT' || symbol.type !== 'PERPETUAL') {
    throw new Error('当前 OKX 品种必须是 USDT 永续合约')
  }
  return symbol
}

export function readSelectedOkxSymbol(storage: Pick<Storage, 'getItem'> = ctraderStorage): SymbolInfo | null {
  try {
    const saved = storage.getItem(OKX_SYMBOL_STORAGE_KEY)
    return saved === null ? null : validateSelectedOkxSymbol(JSON.parse(saved))
  } catch {
    return null
  }
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
    if (symbol.exchange === 'OKX') writePreference(storage, OKX_SYMBOL_STORAGE_KEY, JSON.stringify(validateSelectedOkxSymbol(symbol)))
    else if (symbol.exchange === 'CME') writePreference(storage, DATABENTO_SYMBOL_STORAGE_KEY, JSON.stringify(validateSelectedDatabentoSymbol(symbol.ticker)))
    else writePreference(storage, SELECTED_SYMBOL_STORAGE_KEY, JSON.stringify(validateSelectedSymbol(symbol)))
  } catch {
    // Selecting a product remains usable when browser storage is unavailable.
  }
}
