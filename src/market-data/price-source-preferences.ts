import { ctraderStorage } from '../storage/ctrader-storage'
import { writePreference } from '../storage/preference-events'

export type PriceSource = 'ctrader' | 'okx' | 'okx-local' | 'databento-cme'
export const PRICE_SOURCE_KEY = 'marketData.priceSource.v1'

export function isOkxPriceSource(source: unknown): source is 'okx' | 'okx-local' {
  return source === 'okx' || source === 'okx-local'
}

export function isLocalPriceSource(source: unknown): source is 'okx-local' | 'databento-cme' {
  return source === 'okx-local' || source === 'databento-cme'
}

export function isPriceSource(source: unknown): source is PriceSource {
  return source === 'ctrader' || isOkxPriceSource(source) || source === 'databento-cme'
}

const priceSourceLabels: Record<PriceSource, string> = {
  ctrader: 'cTrader',
  okx: 'OKX',
  'okx-local': 'OKX-本地',
  'databento-cme': 'Databento-CME',
}

export function priceSourceLabel(source: PriceSource): string {
  return priceSourceLabels[source]
}

export function validatePriceSource(value: unknown): PriceSource {
  if (!isPriceSource(value)) throw new Error('preferences.priceSource 必须是 ctrader、okx、okx-local 或 databento-cme')
  return value
}

export function readPriceSource(storage: Pick<Storage, 'getItem'> = ctraderStorage): PriceSource {
  try {
    const value = storage.getItem(PRICE_SOURCE_KEY)
    if (value !== null) return validatePriceSource(JSON.parse(value))
  } catch { /* Damaged local preferences use the original price source. */ }
  return 'ctrader'
}

export function savePriceSource(source: PriceSource): void {
  writePreference(ctraderStorage, PRICE_SOURCE_KEY, JSON.stringify(validatePriceSource(source)))
}
