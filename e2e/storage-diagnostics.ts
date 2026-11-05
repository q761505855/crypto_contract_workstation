import type { Page } from '@playwright/test'

export async function traceNativeRestoreWrites(page: Page, statusSelector = '[data-testid="backup-status"]') {
  await page.evaluate((statusSelector) => {
    interface TransactionTrace {
      id: number
      startedMs: number
      database: string
      stores: string[]
      puts: number
      deletes: number
      clears: number
      errorCount: number
      completedMs?: number
      abortedMs?: number
      error?: string
    }
    const start = performance.now()
    const elapsed = () => Math.round(performance.now() - start)
    const trace = {
      transactions: [] as TransactionTrace[],
      statuses: [] as Array<{ elapsedMs: number; text: string }>,
    }
    Object.assign(window, { nativeRestoreTrace: trace })
    const transactions = new WeakMap<IDBTransaction, TransactionTrace>()
    let sequence = 0
    const originalTransaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args) {
      const transaction = Reflect.apply(originalTransaction, this, args) as IDBTransaction
      if (transaction.mode !== 'readwrite') return transaction
      const entry: TransactionTrace = {
        id: ++sequence, startedMs: elapsed(), database: this.name,
        stores: Array.from(transaction.objectStoreNames), puts: 0, deletes: 0, clears: 0, errorCount: 0,
      }
      transactions.set(transaction, entry)
      trace.transactions.push(entry)
      if (trace.transactions.length > 200) trace.transactions.shift()
      transaction.addEventListener('complete', () => { entry.completedMs = elapsed() })
      transaction.addEventListener('abort', () => {
        entry.abortedMs = elapsed()
        entry.error = transaction.error?.name ?? 'AbortError'
      })
      transaction.addEventListener('error', () => {
        entry.errorCount++
        entry.error = transaction.error?.name ?? 'RequestError'
      })
      return transaction
    }
    // Count synchronous enqueues, without adding an event listener per minute.
    for (const [method, counter] of [['put', 'puts'], ['delete', 'deletes'], ['clear', 'clears']] as const) {
      const original = IDBObjectStore.prototype[method]
      Object.assign(IDBObjectStore.prototype, {
        [method]: function (this: IDBObjectStore, ...args: unknown[]) {
          const entry = transactions.get(this.transaction)
          if (entry) entry[counter]++
          return Reflect.apply(original, this, args)
        },
      })
    }
    const status = document.querySelector(statusSelector)
    if (status) {
      const captureStatus = () => {
        const text = status.textContent ?? ''
        if (trace.statuses.at(-1)?.text !== text) trace.statuses.push({ elapsedMs: elapsed(), text })
      }
      captureStatus()
      new MutationObserver(captureStatus).observe(status, { childList: true, subtree: true, characterData: true })
    }
  }, statusSelector)
}
