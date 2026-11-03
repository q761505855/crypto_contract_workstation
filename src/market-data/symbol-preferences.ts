import type { SymbolInfo } from '@klinecharts/pro'

export const SELECTED_SYMBOL_STORAGE_KEY = 'marketData.selectedSymbol'

export function validateSelectedSymbol(value: unknown): SymbolInfo {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('当前交易对配置无效')
  }
  const item = value as Record<string, unknown>
  if (typeof item.ticker !== 'string') throw new Error('当前交易对代码无效')
  const ticker = item.ticker.trim().toUpperCase()
  if (ticker.length <= 4 || !ticker.endsWith('USDT')) throw new Error('当前交易对必须是 USDT 交易对')
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

export function readSelectedSymbol(storage: Pick<Storage, 'getItem'> = localStorage): SymbolInfo | null {
  try {
    const saved = storage.getItem(SELECTED_SYMBOL_STORAGE_KEY)
    return saved === null ? null : validateSelectedSymbol(JSON.parse(saved))
  } catch {
    return null
  }
}

export function saveSelectedSymbol(symbol: SymbolInfo, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(SELECTED_SYMBOL_STORAGE_KEY, JSON.stringify(validateSelectedSymbol(symbol)))
  } catch {
    // Selecting a product remains usable when browser storage is unavailable.
  }
}
