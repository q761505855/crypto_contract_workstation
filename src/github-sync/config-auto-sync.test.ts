import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkstationBackupService, type BackupPreferences } from '../storage/backup-service'
import { savePinnedPeriods } from '../chart/period-preferences'
import { CONFIG_BASELINE_KEY } from './config-auto-sync'
import { PREFERENCES_RESTORED } from '../storage/preference-events'
import { ConfigAutoSync, mergeConfig } from './config-auto-sync'
import type { GitHubSyncService, RemoteConfig } from './sync-service'
import type { GitHubContentsClient } from './github-client'

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}
const base: BackupPreferences = { binanceRestBaseUrl: 'https://fapi.binance.com', favoriteSymbols: ['BTCUSDT'], pinnedPeriods: ['1m'], candleType: 'candle_solid' }
const running: ConfigAutoSync[] = []
afterEach(() => { running.splice(0).forEach(service => service.stop()); vi.useRealTimers() })

async function setup(remote: BackupPreferences | null = base) {
  const storage = new MemoryStorage()
  const backups = new WorkstationBackupService(`auto-${crypto.randomUUID()}`, storage)
  let value = structuredClone(remote)
  let fail = false
  const writes: BackupPreferences[] = []
  const transport = {
    readConfig: vi.fn(async (): Promise<RemoteConfig> => {
      if (fail) throw new Error('offline')
      return { snapshot: { commitSha: 'head', treeSha: 'tree' }, manifest: null, preferences: structuredClone(value) }
    }),
    writeConfig: vi.fn(async (_client: unknown, prefs: BackupPreferences) => { writes.push(structuredClone(prefs)); value = structuredClone(prefs) }),
  }
  const auto = new ConfigAutoSync({ storage, backups, sync: transport as unknown as GitHubSyncService, client: {} as GitHubContentsClient })
  running.push(auto)
  return { auto, storage, backups, writes, transport, remote: (prefs: BackupPreferences) => { value = prefs }, offline: (state: boolean) => { fail = state } }
}

describe('automatic configuration sync', () => {
  it('merges independent changes and preserves empty arrays and false', () => {
    const result = mergeConfig(base, { ...base, favoriteSymbols: [] }, { ...base, pinnedPeriods: [] })
    expect(result.conflicts).toEqual([])
    expect(result.preferences).toEqual({ ...base, favoriteSymbols: [], pinnedPeriods: [] })
    const conflict = mergeConfig(base, { ...base, pinnedPeriods: [] }, { ...base, pinnedPeriods: ['1d'] })
    expect(conflict.conflicts).toEqual(['pinnedPeriods'])
    expect(conflict.preferences.pinnedPeriods).toEqual([])
  })
  it('restores cloud configuration at startup and leaves missing legacy fields intact', async () => {
    const s = await setup({ binanceRestBaseUrl: base.binanceRestBaseUrl, favoriteSymbols: [] })
    savePinnedPeriods(['1d'], s.storage)
    await s.auto.start()
    expect((await s.backups.exportPreferences()).data.preferences).toMatchObject({ favoriteSymbols: [], pinnedPeriods: ['1d'] })
    expect(s.writes).toHaveLength(0)
    expect(s.auto.getStatus().phase).toBe('synced')
  })
  it('uploads edits without an explicit sync action and debounces repeated writes', async () => {
    vi.useFakeTimers()
    const s = await setup()
    await s.auto.start()
    savePinnedPeriods(['1d'], s.storage); s.auto.changed()
    savePinnedPeriods([], s.storage); s.auto.changed()
    await vi.advanceTimersByTimeAsync(999)
    expect(s.writes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.writes).toHaveLength(1)
    expect(s.writes[0].pinnedPeriods).toEqual([])
  })
  it('persists offline edits across restart and merges changes from another device', async () => {
    const s = await setup()
    await s.auto.start()
    savePinnedPeriods([], s.storage); s.auto.changed()
    s.offline(true); await s.auto.flush()
    expect(s.auto.getStatus().phase).toBe('error')
    s.auto.stop()
    s.offline(false); s.remote({ ...base, favoriteSymbols: ['ETHUSDT'] })
    const next = new ConfigAutoSync({ storage: s.storage, backups: s.backups, sync: s.transport as unknown as GitHubSyncService, client: {} as GitHubContentsClient })
    running.push(next)
    await next.start()
    expect(s.writes.at(-1)).toMatchObject({ pinnedPeriods: [], favoriteSymbols: ['ETHUSDT'] })
    expect((await s.backups.exportPreferences()).data.preferences).toMatchObject({ pinnedPeriods: [], favoriteSymbols: ['ETHUSDT'] })
  })
  it('keeps concurrent same-field edits locally and does not overwrite the cloud', async () => {
    const s = await setup()
    await s.auto.start()
    savePinnedPeriods([], s.storage); s.auto.changed()
    s.remote({ ...base, pinnedPeriods: ['1d'] })
    await s.auto.flush()
    expect(s.auto.getStatus().phase).toBe('conflict')
    expect(s.writes).toHaveLength(0)
    expect((await s.backups.exportPreferences()).data.preferences?.pinnedPeriods).toEqual([])
    await s.auto.resolve('local')
    expect(s.writes.at(-1)?.pinnedPeriods).toEqual([])
  })
  it('does not discard an edit made while an upload is in progress', async () => {
    const s = await setup()
    await s.auto.start()
    s.transport.writeConfig.mockImplementationOnce(async (_client: unknown, prefs: BackupPreferences) => {
      s.writes.push(prefs); s.remote(prefs)
      savePinnedPeriods(['1d'], s.storage); s.auto.changed()
    })
    savePinnedPeriods([], s.storage); s.auto.changed()
    await s.auto.flush()
    expect((await s.backups.exportPreferences()).data.preferences?.pinnedPeriods).toEqual(['1d'])
    await s.auto.flush()
    expect(s.writes.at(-1)?.pinnedPeriods).toEqual(['1d'])
  })
  it('keeps independent remote edits when another local edit arrives during the merge upload', async () => {
    const s = await setup()
    await s.auto.start()
    s.remote({ ...base, favoriteSymbols: ['ETHUSDT'] })
    s.transport.writeConfig.mockImplementationOnce(async (_client: unknown, prefs: BackupPreferences) => {
      s.writes.push(prefs); s.remote(prefs)
      savePinnedPeriods(['1d'], s.storage); s.auto.changed()
    })
    savePinnedPeriods([], s.storage); s.auto.changed()
    await s.auto.flush()
    await s.auto.flush()
    expect(s.writes.at(-1)).toMatchObject({ favoriteSymbols: ['ETHUSDT'], pinnedPeriods: ['1d'] })
    expect((await s.backups.exportPreferences()).data.preferences).toMatchObject({ favoriteSymbols: ['ETHUSDT'], pinnedPeriods: ['1d'] })
  })
  it('notifies the current UI after another tab finishes applying a configuration', async () => {
    const s = await setup()
    await s.auto.start()
    const restored = vi.fn()
    window.addEventListener(PREFERENCES_RESTORED, restored)
    window.dispatchEvent(new StorageEvent('storage', { key: CONFIG_BASELINE_KEY, newValue: '{}' }))
    expect(restored).toHaveBeenCalledOnce()
    window.removeEventListener(PREFERENCES_RESTORED, restored)
  })
})
