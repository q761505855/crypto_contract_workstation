import type { CTraderAccount } from './ctrader-client'
import { readCTraderAccount, saveCTraderAccount } from './ctrader-account-preferences'

interface AccountSelectionSnapshot {
  accounts: readonly CTraderAccount[]
  selectedKey?: string
}

const EMPTY_SELECTION: AccountSelectionSnapshot = { accounts: [] }

export class CTraderAccountSelection {
  private pending?: (key: string) => void
  private snapshot = EMPTY_SELECTION
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): AccountSelectionSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  choose = async (accounts: readonly CTraderAccount[], signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    const remembered = readCTraderAccount()
    const preferred = accounts.find(account => account.key === remembered)
    if (preferred) return preferred.key
    if (accounts.length === 1) return accounts[0].key
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', abort)
        this.pending = undefined
        this.publish(EMPTY_SELECTION)
      }
      const abort = () => {
        finish()
        reject(signal.reason)
      }
      this.pending = key => {
        finish()
        resolve(key)
      }
      signal.addEventListener('abort', abort, { once: true })
      this.publish({ accounts })
    })
  }

  selected = (accounts: readonly CTraderAccount[], selectedKey: string): void => {
    this.publish({ accounts, selectedKey })
  }

  select(key: string): boolean {
    if (this.snapshot.selectedKey === key || !this.snapshot.accounts.some(account => account.key === key)) return false
    saveCTraderAccount(key)
    if (!this.pending) return true
    this.pending(key)
    return false
  }

  private publish(snapshot: AccountSelectionSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
