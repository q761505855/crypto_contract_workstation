import type { CTraderAccount } from './ctrader-client'

const EMPTY_ACCOUNTS: readonly CTraderAccount[] = []

export class CTraderAccountSelection {
  private pending?: { accounts: readonly CTraderAccount[]; select(key: string): void }
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): readonly CTraderAccount[] => this.pending?.accounts ?? EMPTY_ACCOUNTS

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  choose = (accounts: readonly CTraderAccount[], signal: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const finish = () => {
      signal.removeEventListener('abort', abort)
      this.pending = undefined
      this.publish()
    }
    const abort = () => { finish(); reject(signal.reason) }
    this.pending = { accounts, select: key => { finish(); resolve(key) } }
    signal.addEventListener('abort', abort, { once: true })
    this.publish()
  })

  select(key: string): void {
    const pending = this.pending
    if (pending?.accounts.some(account => account.key === key)) pending.select(key)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
