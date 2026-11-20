import { ctraderStorage } from '../storage/ctrader-storage'
import { writePreference } from '../storage/preference-events'

export const CTRADER_ACCOUNT_KEY = 'marketData.ctraderAccount.v1'

export function validateCTraderAccount(value: unknown): string {
  const match = typeof value === 'string' ? /^(?:demo|live):([1-9]\d*)$/.exec(value) : null
  if (!match || match[0] !== value || !Number.isSafeInteger(Number(match[1]))) {
    throw new Error('preferences.ctraderAccount 无效')
  }
  return match[0]
}

export function readCTraderAccount(storage: Pick<Storage, 'getItem'> = ctraderStorage): string | undefined {
  try {
    const value = storage.getItem(CTRADER_ACCOUNT_KEY)
    return value === null ? undefined : validateCTraderAccount(JSON.parse(value))
  } catch {
    return undefined
  }
}

export function saveCTraderAccount(key: string): void {
  writePreference(ctraderStorage, CTRADER_ACCOUNT_KEY, JSON.stringify(validateCTraderAccount(key)))
}
