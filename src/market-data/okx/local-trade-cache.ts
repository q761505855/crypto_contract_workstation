import { scanOkxArchive, type OkxLocalFile, type OkxLocalFiles } from './local-files'
import { buildLocalTradeIndex, localTradeIndexBytes, type LocalTradeIndex } from './local-trade-index'
import type { LocalTradeIndexResult, LocalTradeIndexTask } from './local-trade-index.worker'
import { reserveWorker, workerCapacity } from '../worker-capacity'

const CACHE_BYTES = 96 * 1024 * 1024

function indexInWorker(worker: Worker, task: LocalTradeIndexTask, signal: AbortSignal): Promise<LocalTradeIndex | undefined> {
  return new Promise((resolve, reject) => {
    const stop = () => { worker.terminate(); signal.removeEventListener('abort', abort) }
    const abort = () => { stop(); reject(signal.reason) }
    worker.onmessage = ({ data }: MessageEvent<LocalTradeIndexResult>) => {
      stop()
      if ('index' in data) resolve(data.index)
      else reject(new Error(data.error))
    }
    worker.onerror = event => {
      event.preventDefault()
      stop()
      const { file, archive } = task
      void buildLocalTradeIndex(async accept => {
        await scanOkxArchive(file, archive.symbol, archive.day, accept, signal)
        return true
      }).then(resolve, reject)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else {
      try { worker.postMessage(task) }
      catch (error) { stop(); reject(error) }
    }
  })
}

export class OkxLocalTradeCache {
  readonly parallelism = workerCapacity || 1
  private readonly lanes = Array.from({ length: this.parallelism }, () => Promise.resolve())
  private nextLane = 0
  private readonly entries = new Map<string, { index: LocalTradeIndex; bytes: number }>()
  private readonly pending = new Map<string, Promise<LocalTradeIndex | undefined>>()
  private bytes = 0

  constructor(private readonly files: OkxLocalFiles, private readonly signal: AbortSignal) {}

  read(archive: OkxLocalFile): Promise<LocalTradeIndex | undefined> {
    const key = archive.filename
    const cached = this.entries.get(key)
    if (cached) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return Promise.resolve(cached.index)
    }
    const pending = this.pending.get(key)
    if (pending) return pending

    const lane = this.nextLane++ % this.parallelism
    const result = this.lanes[lane].then(async () => {
      this.signal.throwIfAborted()
      const index = await this.build(archive)
      this.signal.throwIfAborted()
      if (index) this.remember(key, index)
      return index
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, result)
    this.lanes[lane] = result.then(() => {}, () => {})
    return result
  }

  private remember(key: string, index: LocalTradeIndex): void {
    const bytes = localTradeIndexBytes(index)
    if (bytes > CACHE_BYTES) return
    while (this.bytes + bytes > CACHE_BYTES) {
      const [oldest, cached] = this.entries.entries().next().value!
      this.entries.delete(oldest)
      this.bytes -= cached.bytes
    }
    this.entries.set(key, { index, bytes })
    this.bytes += bytes
  }

  private async build(archive: OkxLocalFile): Promise<LocalTradeIndex | undefined> {
    if (workerCapacity) {
      let worker: Worker | undefined
      const file = await this.files.archiveFile(archive.symbol, archive.day)
      this.signal.throwIfAborted()
      if (!file) return
      const release = await reserveWorker(this.signal)
      try {
        this.signal.throwIfAborted()
        try { worker = new Worker(new URL('./local-trade-index.worker.ts', import.meta.url), { type: 'module' }) }
        catch { /* Browsers can restrict worker creation even when the API exists. */ }
        if (worker) return await indexInWorker(worker, { file, archive }, this.signal)
      } finally { release() }
    }
    return buildLocalTradeIndex(accept => this.files.scan(archive.symbol, archive.day, accept, this.signal))
  }
}
