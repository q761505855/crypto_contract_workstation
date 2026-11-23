import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkstationBackupService, type BackupPreferences } from '../storage/backup-service'
import { browserStorageKey, ctraderStorage } from '../storage/ctrader-storage'
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

async function setup(remote: BackupPreferences | null = base, storage: Pick<Storage, 'getItem' | 'setItem'> = new MemoryStorage()) {
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
  it('keeps each captured window size together when both devices edit it', () => {
    const before = { ...base, chartWindowSize: { width: 1100, height: 760 } }
    const local = { ...base, chartWindowSize: { width: 900, height: 760 } }
    const remote = { ...base, chartWindowSize: { width: 1100, height: 600 } }
    expect(mergeConfig(before, local, remote)).toEqual({ preferences: local, conflicts: ['chartWindowSize'] })
    expect(mergeConfig(before, local, remote, 'remote').preferences).toEqual(remote)
    expect(mergeConfig(before, local, base).preferences).toEqual(local)
  })
  it('resolves concurrent bubble bounds together and merges independent order-flow groups', () => {
    const chartIndicators = { schemaVersion: 1 as const, main: [], sub: [] }
    const withBounds = (minRadius: number, maxRadius: number): BackupPreferences => ({
      ...base, chartIndicators: { ...chartIndicators, orderFlow: { bubbles: { minRadius, maxRadius } } },
    })
    const before = withBounds(5, 20)
    const local = withBounds(18, 20)
    const remote = withBounds(5, 10)
    remote.chartIndicators!.orderFlow!.profile = { rows: 64 }
    const unresolved = mergeConfig(before, local, remote)
    expect(unresolved.conflicts).toEqual(['chartIndicators.orderFlow.bubbles'])
    expect(unresolved.preferences.chartIndicators!.orderFlow).toEqual({ bubbles: { minRadius: 18, maxRadius: 20 }, profile: { rows: 64 } })
    expect(mergeConfig(before, local, remote, 'remote').preferences).toEqual(remote)
  })
  it('keeps cTrader product identity and display precision together across concurrent edits', () => {
    const before = { ...base, selectedSymbol: { ticker: 'EURUSD', exchange: 'CTRADER', pricePrecision: 5 } }
    const local = { ...base, selectedSymbol: { ticker: 'XAUUSD', exchange: 'CTRADER', pricePrecision: 2 } }
    const remote = { ...base, selectedSymbol: { ...before.selectedSymbol, pricePrecision: 4 } }
    expect(mergeConfig(before, local, remote)).toEqual({ preferences: local, conflicts: ['selectedSymbol'] })
    expect(mergeConfig(before, local, remote, 'remote').preferences).toEqual(remote)
  })
  it('refreshes other tabs for experiment config baselines only', async () => {
    localStorage.clear()
    const { auto } = await setup(base, ctraderStorage)
    await auto.start()
    const restored = vi.fn()
    window.addEventListener(PREFERENCES_RESTORED, restored)
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: CONFIG_BASELINE_KEY }))
      expect(restored).not.toHaveBeenCalled()
      window.dispatchEvent(new StorageEvent('storage', { key: browserStorageKey(ctraderStorage, CONFIG_BASELINE_KEY) }))
      expect(restored).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener(PREFERENCES_RESTORED, restored)
      localStorage.clear()
    }
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
