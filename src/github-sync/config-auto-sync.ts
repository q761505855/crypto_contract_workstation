import { WorkstationBackupService, type BackupPreferences, validateBackupEnvelope } from '../storage/backup-service'
import { CONFIG_PENDING_KEY, PREFERENCES_CHANGED, PREFERENCES_RESTORED } from '../storage/preference-events'
import { GitHubConflictError, type GitHubContentsClient } from './github-client'
import { configurationEnvelope, type GitHubSyncService } from './sync-service'

export const CONFIG_BASELINE_KEY = 'github.configBaseline.v1'
type LocalStorage = Pick<Storage, 'getItem' | 'setItem'>
export interface ConfigSyncStatus {
  phase: 'checking' | 'pending' | 'syncing' | 'synced' | 'error' | 'conflict'
  message: string
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
}
const equal = (left: unknown, right: unknown) => stable(left) === stable(right)

/** Arrays are one setting; objects (including workspace panel switches) merge by field. */
export function mergeConfig(base: BackupPreferences | undefined, local: BackupPreferences, remote: BackupPreferences, resolution?: 'local' | 'remote', remoteBase = base): { preferences: BackupPreferences; conflicts: string[] } {
  const conflicts: string[] = []
  const merge = (beforeHere: unknown, beforeThere: unknown, here: unknown, there: unknown, path: string): unknown => {
    // Absent remote optional fields are legacy omissions, never deletion commands.
    if (there === undefined) return here
    if (equal(here, there)) return here
    if (object(here) && object(there) && (beforeHere === undefined || object(beforeHere)) && (beforeThere === undefined || object(beforeThere))) {
      return Object.fromEntries([...new Set([...Object.keys(here), ...Object.keys(there)])].map(key => [
        key, merge(object(beforeHere) ? beforeHere[key] : undefined, object(beforeThere) ? beforeThere[key] : undefined, here[key], there[key], path ? `${path}.${key}` : key),
      ]))
    }
    if (equal(beforeHere, here)) return there
    if (equal(beforeThere, there)) return here
    conflicts.push(path)
    return resolution === 'remote' ? there : here
  }
  return { preferences: merge(base, remoteBase, local, remote, '') as BackupPreferences, conflicts }
}

interface Options {
  storage: LocalStorage
  backups: WorkstationBackupService
  sync: GitHubSyncService
  client: GitHubContentsClient
}

export class ConfigAutoSync {
  private status: ConfigSyncStatus = { phase: 'checking', message: '正在检查云端配置…' }
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | null = null
  private again = false
  private stopped = true
  private retryDelay = 5_000
  private resolution: 'local' | 'remote' | undefined
  private controller: AbortController | undefined

  constructor(private readonly options: Options) {}

  getStatus = (): ConfigSyncStatus => this.status
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  async start(): Promise<void> {
    if (!this.stopped) return this.flush()
    this.stopped = false
    window.addEventListener(PREFERENCES_CHANGED, this.changed)
    window.addEventListener('online', this.wake)
    window.addEventListener('focus', this.wake)
    window.addEventListener('storage', this.storageChanged)
    await this.flush()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.controller?.abort()
    window.removeEventListener(PREFERENCES_CHANGED, this.changed)
    window.removeEventListener('online', this.wake)
    window.removeEventListener('focus', this.wake)
    window.removeEventListener('storage', this.storageChanged)
  }

  changed = (): void => {
    try { this.options.storage.setItem(CONFIG_PENDING_KEY, 'true') }
    catch { this.setStatus('error', '配置已修改，无法记录云端待同步状态'); return }
    this.setStatus('pending', '配置已保存，等待自动同步…')
    if (this.running) this.again = true
    this.schedule(1_000)
  }

  private wake = (): void => { if (this.status.phase !== 'conflict') void this.flush() }
  private storageChanged = (event: StorageEvent): void => {
    if (event.key === CONFIG_PENDING_KEY && event.newValue === 'true') this.schedule(1_000)
    if (event.key === CONFIG_BASELINE_KEY) {
      // The baseline is written after the full configuration. A receiving tab
      // must replace its old component state even if storage already equals Git.
      window.dispatchEvent(new CustomEvent(PREFERENCES_RESTORED, { detail: { source: 'cloud' } }))
      this.schedule(1_000)
    }
  }

  async resolve(resolution: 'local' | 'remote'): Promise<void> {
    this.resolution = resolution
    await this.flush()
  }

  flush = (): Promise<void> => {
    if (this.stopped) return Promise.resolve()
    clearTimeout(this.timer)
    if (this.running) { this.again = true; return this.running }
    this.again = false
    this.running = this.lockedCycle().finally(() => {
      this.running = null
      if (this.again && !this.stopped) this.schedule(1_000)
    })
    return this.running
  }

  private async lockedCycle(): Promise<void> {
    // Serialize cooperating pages. Git's non-forced ref update still guards
    // independent devices and browsers without Web Locks.
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      await navigator.locks.request('workstation:config-sync', { ifAvailable: true }, async lock => {
        if (lock) await this.cycle()
        else this.schedule(1_000)
      })
    } else await this.cycle()
  }

  private async local(): Promise<BackupPreferences> { return (await this.options.backups.exportPreferences()).data.preferences! }

  private async cycle(): Promise<void> {
    const { storage, sync, client, backups } = this.options
    this.controller = new AbortController()
    const timeout = setTimeout(() => this.controller?.abort(), 8_000)
    try {
      this.setStatus('checking', '正在检查云端配置…')
      const raw = storage.getItem(CONFIG_BASELINE_KEY)
      let base: BackupPreferences | undefined
      let remoteBase: BackupPreferences | undefined
      if (raw) {
        try {
          const value = JSON.parse(raw)
          const validate = (value: BackupPreferences) => validateBackupEnvelope(configurationEnvelope(value)).data.preferences!
          if (value.schemaVersion === 1 && value.local && value.remote) {
            base = validate(value.local); remoteBase = validate(value.remote)
          } else { base = validate(value); remoteBase = base }
        }
        catch { /* A damaged baseline cannot authorize discarding pending edits. */ }
      }
      const local = await this.local()
      const pending = storage.getItem(CONFIG_PENDING_KEY) === 'true' || (base !== undefined && !equal(base, local))
      const remote = await sync.readConfig(client, this.controller.signal)
      if (this.stopped) return
      if (!equal(local, await this.local())) { this.again = true; return }
      let desired = local
      if (remote.preferences) {
        if (!pending) desired = { ...local, ...remote.preferences }
        else {
          const result = mergeConfig(base, local, remote.preferences, this.resolution, remoteBase)
          if (result.conflicts.length && !this.resolution) {
            this.setStatus('conflict', `配置存在冲突，本地修改已保留：${result.conflicts.join('、')}`)
            return
          }
          desired = result.preferences
        }
      }
      // Validation precedes any local or remote writes, including merged values.
      desired = validateBackupEnvelope(configurationEnvelope(desired), local.chartIndicators).data.preferences!
      if (pending) {
        this.setStatus('syncing', '正在自动上传配置…')
        await sync.writeConfig(client, desired, remote)
      }
      if (this.stopped) return
      this.resolution = undefined
      if (!equal(local, await this.local())) {
        // A successful upload acknowledges only its immutable snapshot.
        storage.setItem(CONFIG_BASELINE_KEY, JSON.stringify({ schemaVersion: 1, local, remote: desired }))
        storage.setItem(CONFIG_PENDING_KEY, 'true')
        this.again = true
        this.setStatus('pending', '上传期间有新修改，继续自动同步…')
        return
      }
      if (!equal(local, desired)) await backups.import(configurationEnvelope(desired), undefined, { source: 'cloud' })
      const baseline = { schemaVersion: 1, local: await this.local(), remote: pending ? desired : remote.preferences ?? desired }
      const nextBaseline = JSON.stringify(baseline)
      if (storage.getItem(CONFIG_BASELINE_KEY) !== nextBaseline) storage.setItem(CONFIG_BASELINE_KEY, nextBaseline)
      storage.setItem(CONFIG_PENDING_KEY, 'false')
      this.retryDelay = 5_000
      this.setStatus('synced', '应用配置已与云端同步')
    } catch (error) {
      if (this.stopped) return
      this.setStatus('error', `配置待同步：${error instanceof Error ? error.message : String(error)}；将自动重试`)
      this.schedule(error instanceof GitHubConflictError ? 1_000 : this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, 60_000)
    } finally {
      clearTimeout(timeout)
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.flush() }, delay)
  }

  private setStatus(phase: ConfigSyncStatus['phase'], message: string): void {
    this.status = { phase, message }
    this.listeners.forEach(listener => listener())
  }
}
