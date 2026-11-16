import { mergeDrawings, sameDrawingData, validateDrawingArchive, type DrawingArchive, type DrawingStore } from '../chart/drawings'
import { GitHubConflictError, type GitHubContentsClient } from './github-client'
import { sha256 } from './sync-service'

export const DRAWING_CLOUD_PATH = 'data/chart-drawings/archive.json'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const archiveBytes = (archive: DrawingArchive) => encoder.encode(JSON.stringify(archive))

async function encodeArchive(archive: DrawingArchive): Promise<Uint8Array> {
  const bytes = archiveBytes(archive)
  return encoder.encode(JSON.stringify({ schemaVersion: 1, size: bytes.length, checksum: await sha256(bytes), archive }))
}

async function decodeArchive(bytes: Uint8Array): Promise<DrawingArchive> {
  const file = JSON.parse(decoder.decode(bytes))
  if (file?.schemaVersion !== 1 || file.archive === undefined) throw new Error('不支持的云端绘图存档格式')
  const content = encoder.encode(JSON.stringify(file.archive))
  if (file.size !== content.length || await sha256(content) !== file.checksum) throw new Error('云端绘图存档校验失败')
  return validateDrawingArchive(file.archive)
}

type DrawingSyncStatus = { phase: 'checking' | 'pending' | 'synced' | 'error' | 'conflict'; message: string }

export class DrawingAutoSync {
  private status: DrawingSyncStatus = { phase: 'checking', message: '正在检查云端绘图…' }
  private readonly listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private polling?: ReturnType<typeof setInterval>
  private unsubscribe?: () => void
  private running?: Promise<void>
  private retryDelay = 5_000
  private resolution?: 'local' | 'remote'

  constructor(readonly store: DrawingStore, private readonly client: Pick<GitHubContentsClient, 'getSnapshot' | 'getFile' | 'commitFiles' | 'canWrite'>) {}

  getStatus = (): DrawingSyncStatus => this.status
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.store.subscribe(this.changed)
    window.addEventListener('online', this.wake)
    window.addEventListener('focus', this.wake)
    this.polling = setInterval(() => {
      if (document.visibilityState === 'visible') this.wake()
    }, 60_000)
    void this.flush()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    window.removeEventListener('online', this.wake)
    window.removeEventListener('focus', this.wake)
    clearTimeout(this.timer)
    clearInterval(this.polling)
  }

  resolve = (resolution: 'local' | 'remote'): void => {
    this.resolution = resolution
    void this.flush()
  }

  flush = (): Promise<void> => {
    if (this.running) return this.running
    clearTimeout(this.timer)
    this.running = this.run().finally(() => { this.running = undefined })
    return this.running
  }

  private wake = (): void => {
    if (this.status.phase !== 'conflict') void this.flush()
  }

  private changed = (): void => {
    const { local, base } = this.store.read()
    if (this.status.phase === 'conflict' && local.epoch === base.epoch && !sameDrawingData(local, base)) return
    if (!sameDrawingData(local, base)) {
      this.setStatus('pending', '绘图已保存在本机，等待云端同步…')
      this.schedule(1_000)
    } else if (this.status.phase === 'conflict') {
      this.schedule(1_000)
    }
  }

  private schedule(delay: number): void {
    if (!this.unsubscribe) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      if (this.running) this.schedule(1_000)
      else void this.flush()
    }, delay)
  }

  private async run(): Promise<void> {
    try {
      if (navigator.locks?.request) {
        await navigator.locks.request('workstation:drawing-sync', { ifAvailable: true }, async lock => {
          if (lock) await this.cycle()
          else this.schedule(1_000)
        })
      } else await this.cycle()
      this.retryDelay = 5_000
    } catch (error) {
      this.setStatus('error', `绘图同步失败：${error instanceof Error ? error.message : String(error)}`)
      this.schedule(error instanceof GitHubConflictError ? 1_000 : this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, 60_000)
    }
  }

  private async cycle(): Promise<void> {
    const raw = this.store.snapshot()
    const { local, base, cloudBytes: previousCloudBytes } = this.store.read(raw)
    const pending = !sameDrawingData(local, base)
    const signal = AbortSignal.timeout(8_000)
    const snapshot = pending && this.client.canWrite() ? await this.client.getSnapshot({ signal }) : undefined
    const file = await this.client.getFile(DRAWING_CLOUD_PATH, { ref: snapshot?.commitSha, signal })
    const remote = file ? await decodeArchive(file.bytes) : base
    if (raw !== this.store.snapshot()) { this.schedule(1_000); return }

    const resolution = this.resolution
    // A browser that has never seen the cloud can have brand-new offline
    // drawings even when the remote archive already has a clear epoch.
    const firstRead = previousCloudBytes === null && local.epoch === base.epoch
    const rebase = (value: DrawingArchive) => firstRead && value.epoch === base.epoch ? { ...value, epoch: remote.epoch } : value
    const { archive, conflicts } = mergeDrawings(rebase(base), rebase(local), remote, resolution)
    if (conflicts.length && !resolution) {
      this.setStatus('conflict', `${conflicts.length} 个绘图存在同步冲突，本地修改已保留`)
      return
    }
    let cloudBytes = file?.bytes.length ?? 0
    let acknowledged = remote
    if (snapshot && !sameDrawingData(archive, remote)) {
      const bytes = await encodeArchive(archive)
      if (raw !== this.store.snapshot()) { this.schedule(1_000); return }
      await this.client.commitFiles([{ path: DRAWING_CLOUD_PATH, bytes }], '自动同步工作站绘图', snapshot)
      cloudBytes = bytes.length
      acknowledged = archive
    }
    if (resolution === this.resolution) this.resolution = undefined
    // Any new local edit during the commit remains pending against the uploaded snapshot.
    const next = await this.store.acceptCloud(acknowledged, cloudBytes,
      current => mergeDrawings(rebase(local), rebase(current), archive, 'local').archive)
    if (sameDrawingData(acknowledged, next)) this.setStatus('synced', '绘图已与云端同步')
    else if (!this.client.canWrite()) this.setStatus('pending', '绘图已保存在本机，云端连接只读')
    else this.setStatus('pending', '绘图已保存在本机，等待云端同步…')
  }

  private setStatus(phase: DrawingSyncStatus['phase'], message: string): void {
    if (this.status.phase === phase && this.status.message === message) return
    this.status = { phase, message }
    this.listeners.forEach(listener => listener())
  }
}
