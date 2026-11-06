export const CONFIG_PENDING_KEY = 'github.configPending.v1'
export const PREFERENCES_CHANGED = 'workstation:preferences-changed'
export const PREFERENCES_RESTORED = 'workstation:preferences-restored'

/** Mark before writing: a closed/offline page must never lose its pending edit. */
export function writePreference(storage: Pick<Storage, 'getItem' | 'setItem'> | Pick<Storage, 'setItem'>, key: string, value: string): void {
  const readable = storage as Partial<Storage>
  if (readable.getItem?.(key) === value) return
  let browser = false
  try { browser = typeof localStorage !== 'undefined' && storage === localStorage } catch { /* Unavailable browser storage. */ }
  if (browser) storage.setItem(CONFIG_PENDING_KEY, 'true')
  storage.setItem(key, value)
  if (browser) window.dispatchEvent(new Event(PREFERENCES_CHANGED))
}

export function preferencesRestored(storage: Pick<Storage, 'setItem'>, source: 'local' | 'cloud'): void {
  if (source === 'local') storage.setItem(CONFIG_PENDING_KEY, 'true')
  if (typeof window === 'undefined') return
  // Only the actual browser storage belongs to the live UI.
  try {
    if (storage !== localStorage) return
    window.dispatchEvent(new CustomEvent(PREFERENCES_RESTORED, { detail: { source } }))
    if (source === 'local') window.dispatchEvent(new Event(PREFERENCES_CHANGED))
  } catch { /* Headless/custom storage has no UI to notify. */ }
}
