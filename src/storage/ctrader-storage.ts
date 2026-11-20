const PREFIX = 'crypto-contract-workstation:ctrader:'

export const CTRADER_DATABASE_NAME = 'crypto-contract-workstation-ctrader'

export const ctraderStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem: key => localStorage.getItem(PREFIX + key),
  setItem: (key, value) => localStorage.setItem(PREFIX + key, value),
  removeItem: key => localStorage.removeItem(PREFIX + key),
}

/** Storage events report the browser key rather than the key presented to callers. */
export function browserStorageKey(storage: object, key: string): string {
  return storage === ctraderStorage ? PREFIX + key : key
}
