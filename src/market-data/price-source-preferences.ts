import { ctraderStorage } from '../storage/ctrader-storage'
import { writePreference } from '../storage/preference-events'

export type PriceSource = 'ctrader' | 'okx' | 'okx-local'
export const PRICE_SOURCE_KEY = 'marketData.priceSource.v1'

export function isOkxPriceSource(source: unknown): source is 'okx' | 'okx-local' {
  return source === 'okx' || source === 'okx-local'
}

const priceSourceLabels: Record<PriceSource, string> = {
  ctrader: 'cTrader',
  okx: 'OKX',
  'okx-local': 'OKX-本地',
}

export function priceSourceLabel(source: PriceSource): string {
  return priceSourceLabels[source]
}

export function validatePriceSource(value: unknown): PriceSource {
  if (value !== 'ctrader' && !isOkxPriceSource(value)) throw new Error('preferences.priceSource 必须是 ctrader、okx 或 okx-local')
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
