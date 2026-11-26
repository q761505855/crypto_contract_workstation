import { openDB } from 'idb'
import { bybitDay } from '../bybit/trades'

export interface DatabentoArchive {
  symbol: string
  day: string
  start: number
  filename: string
  handle: FileSystemFileHandle
}

const archiveName = /^glbx-mdp3-(\d{4})(\d\d)(\d\d)\.trades\.dbn(?:\.zst)?$/i
const read = { mode: 'read' } as const

interface LocalFolder extends FileSystemDirectoryHandle {
  queryPermission(options: typeof read): Promise<PermissionState>
  requestPermission(options: typeof read): Promise<PermissionState>
}

function picker() {
  return (globalThis as typeof globalThis & { showDirectoryPicker?: (options: typeof read) => Promise<LocalFolder> }).showDirectoryPicker
}

async function directoryStore() {
  return openDB('workstation-databento-files', 1, { upgrade: db => { db.createObjectStore('directories') } })
}

export class DatabentoFiles {
  private folder?: LocalFolder
  private granted = false
  private restoration?: Promise<void>
  private readonly listeners = new Set<() => void>()
  private index?: Promise<Map<string, DatabentoArchive[]>>
  private version = 0

  get revision() { return this.version }
  get name() { return this.folder?.name }
  get ready() { return this.granted }
  get available() { return Boolean(picker()) }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  refresh(): void {
    this.index = undefined
    this.version++
    for (const listener of this.listeners) listener()
  }

  restore(): Promise<void> {
    return this.restoration ??= (async () => {
      if (this.folder || !this.available) return
      try {
        const store = await directoryStore()
        try { this.folder ??= await store.get('directories', 'cme') }
        finally { store.close() }
        if (this.folder) {
          this.granted = await this.folder.queryPermission(read) === 'granted'
          this.refresh()
        }
      } catch { /* A folder can still be chosen for the current tab. */ }
    })()
  }

  async choose(): Promise<void> {
    const select = picker()
    if (!select) throw new Error('请在桌面 Chrome 或 Edge 中选择本地文件夹')
    this.folder = await select.call(globalThis, read)
    this.granted = await this.folder.queryPermission(read) === 'granted'
    this.refresh()
    try {
      const store = await directoryStore()
      try { await store.put('directories', this.folder, 'cme') }
      finally { store.close() }
    } catch { /* Keep using the selected folder in this tab. */ }
  }

  async authorize(): Promise<void> {
    if (!this.folder) return
    this.granted = await this.folder.requestPermission(read) === 'granted'
    this.refresh()
  }

  async list(force = false): Promise<Map<string, DatabentoArchive[]>> {
    await this.restore()
    if (!this.granted || !this.folder) return new Map()
    const pending = force || !this.index ? this.scan(this.folder) : this.index
    this.index = pending
    try { return await pending }
    catch (error) { if (this.index === pending) this.index = undefined; throw error }
  }

  private async scan(root: LocalFolder): Promise<Map<string, DatabentoArchive[]>> {
    const products = new Map<string, DatabentoArchive[]>()
    for await (const entry of root.values()) {
      if (entry.kind !== 'directory' || !/^[A-Z0-9][A-Z0-9._-]{0,63}$/i.test(entry.name)) continue
      const symbol = entry.name.toUpperCase()
      if (products.has(symbol)) throw new Error(`多个子文件夹对应同一个产品：${symbol}`)
      const folder = entry as FileSystemDirectoryHandle
      const days = new Map<string, DatabentoArchive>()
      for await (const file of folder.values()) {
        if (file.kind !== 'file') continue
        const match = archiveName.exec(file.name)
        if (!match) continue
        const day = `${match[1]}-${match[2]}-${match[3]}`
        const start = Date.parse(day)
        if (!Number.isFinite(start) || bybitDay(start) !== day) continue
        const prior = days.get(day)
        if (prior && !prior.filename.toLowerCase().endsWith('.zst')) continue
        days.set(day, { symbol, day, start, filename: file.name, handle: file as FileSystemFileHandle })
      }
      products.set(symbol, [...days.values()].sort((a, b) => a.start - b.start))
    }
    return new Map([...products].sort(([a], [b]) => a.localeCompare(b)))
  }
}
