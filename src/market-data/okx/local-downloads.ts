import { BYBIT_DAY_MS, bybitDayStart } from '../bybit/trades'
import type { OkxLocalDownloadResult, OkxLocalFiles } from './local-files'

interface Request {
  symbol: string
  from: string
  to: string
  anchor: string
  onArchive?(day: string): Promise<void> | void
}

interface DownloadState {
  status: 'running' | 'stopping' | 'finished' | 'stopped' | 'failed'
  symbol: string
  total: number
  results: readonly OkxLocalDownloadResult[]
  message?: string
}

export class OkxLocalDownloads {
  private controller?: AbortController
  private state?: DownloadState
  private readonly listeners = new Set<() => void>()

  constructor(private readonly files: OkxLocalFiles) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly snapshot = () => this.state

  private publish(state: DownloadState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }

  stop(): void {
    if (!this.controller || !this.state || this.controller.signal.aborted) return
    this.publish({ ...this.state, status: 'stopping' })
    this.controller.abort()
  }

  async start({ symbol, from, to, anchor, onArchive }: Request): Promise<void> {
    if (this.controller) return
    const total = (bybitDayStart(to) - bybitDayStart(from)) / BYBIT_DAY_MS + 1
    const operation = new AbortController()
    this.controller = operation
    this.publish({ symbol, total, results: [], status: 'running' })
    let message: string | undefined
    try {
      await this.files.download(symbol, from, to, async result => {
        this.publish({ ...this.state!, results: [...this.state!.results, result] })
        if (result.status === 'saved' || result.status === 'existing') await onArchive?.(result.day)
      }, operation.signal, anchor)
    } catch (error) {
      if (!operation.signal.aborted) message = error instanceof Error ? error.message : '下载中断，请重试。'
    } finally {
      this.controller = undefined
      this.publish({ ...this.state!, message, status: operation.signal.aborted ? 'stopped' : message ? 'failed' : 'finished' })
    }
  }
}
