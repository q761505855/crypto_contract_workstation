import { openDB, type DBSchema } from 'idb'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, bybitDay } from '../bybit/trades'

const sourceOffset = 8 * BYBIT_HOUR_MS
const swapSymbol = /^[A-Z0-9]+-[A-Z0-9]+-SWAP$/
const archiveName = /^([A-Z0-9]+-[A-Z0-9]+-SWAP)-trades-(\d{4}-\d{2}-\d{2})\.zip$/
const maxZipTail = 22 + 65_535
const readWrite = { mode: 'readwrite' } as const

export interface OkxLocalFile {
  symbol: string
  day: string
  filename: string
}

export interface OkxLocalTrade {
  id: string
  time: number
  price: string
  size: string
  side: 'Buy' | 'Sell'
}

export interface OkxLocalDownloadResult {
  day: string
  status: 'saved' | 'existing' | 'unavailable' | 'failed'
  message?: string
}

interface LocalDirectory extends FileSystemDirectoryHandle {
  queryPermission(options: typeof readWrite): Promise<PermissionState>
  requestPermission(options: typeof readWrite): Promise<PermissionState>
}

interface LocalDirectoryDB extends DBSchema {
  directories: { key: 'okx'; value: LocalDirectory }
}

let db: ReturnType<typeof openDB<LocalDirectoryDB>> | undefined
function database() {
  return db ??= openDB<LocalDirectoryDB>('workstation-local-market-data', 1, {
    upgrade: store => { store.createObjectStore('directories') },
  }).catch(error => {
    db = undefined
    throw error
  })
}

function directoryPicker() {
  return (globalThis as typeof globalThis & {
    showDirectoryPicker?: (options: typeof readWrite) => Promise<LocalDirectory>
  }).showDirectoryPicker
}

function dateValue(day: string): number {
  const time = Date.parse(day)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(time) && bybitDay(time) === day ? time : NaN
}

function filename(symbol: string, day: string): string {
  if (!swapSymbol.test(symbol)) throw new Error('OKX 永续合约代码无效')
  if (!Number.isFinite(dateValue(day))) throw new Error('OKX 日档日期无效')
  return `${symbol}-trades-${day}.zip`
}

async function findFile(folder: LocalDirectory, name: string): Promise<FileSystemFileHandle | undefined> {
  try { return await folder.getFileHandle(name) }
  catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error
  }
}

function zipError(): Error { return new Error('OKX 日档 ZIP 无效或不完整') }

function zipDirectory(tail: Uint8Array<ArrayBuffer>, size: number): { start: number; length: number } {
  const data = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (data.getUint32(offset, true) !== 0x06054b50 || offset + 22 + data.getUint16(offset + 20, true) !== tail.length) continue
    const start = data.getUint32(offset + 16, true)
    const length = data.getUint32(offset + 12, true)
    if (data.getUint16(offset + 4, true) !== 0 || data.getUint16(offset + 6, true) !== 0 ||
        data.getUint16(offset + 8, true) !== 1 || data.getUint16(offset + 10, true) !== 1 ||
        start + length !== size - tail.length + offset || length < 46 || length > 46 + 3 * 65_535) throw zipError()
    return { start, length }
  }
  throw zipError()
}

async function csvEntry(file: File) {
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - maxZipTail)).arrayBuffer())
  const directory = zipDirectory(tail, file.size)
  const entry = new DataView(await file.slice(directory.start, directory.start + directory.length).arrayBuffer())
  const nameLength = entry.getUint16(28, true)
  const method = entry.getUint16(10, true)
  const compressed = entry.getUint32(20, true)
  const size = entry.getUint32(24, true)
  const local = entry.getUint32(42, true)
  if (entry.getUint32(0, true) !== 0x02014b50 || (entry.getUint16(8, true) & 1) ||
      (method !== 0 && method !== 8) || 46 + nameLength + entry.getUint16(30, true) + entry.getUint16(32, true) !== directory.length ||
      local + 30 > directory.start || compressed === 0 || size === 0) throw zipError()
  const csvName = new TextDecoder().decode(new Uint8Array(entry.buffer, 46, nameLength))
  if (!csvName.endsWith('.csv')) throw zipError()

  const header = new DataView(await file.slice(local, local + 30).arrayBuffer())
  const start = local + 30 + header.getUint16(26, true) + header.getUint16(28, true)
  if (header.getUint32(0, true) !== 0x04034b50 || header.getUint16(8, true) !== method ||
      start + compressed > directory.start) throw zipError()
  const content = file.slice(start, start + compressed).stream()
  return { body: method === 8 ? content.pipeThrough(new DecompressionStream('deflate-raw')) : content, size }
}

const tradeColumns = ['instrument_name', 'trade_id', 'side', 'price', 'size', 'created_time']
const positiveDecimal = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

async function scanArchive(file: File, symbol: string, day: string, onTrade: (trade: OkxLocalTrade) => void, signal?: AbortSignal) {
  const { body, size } = await csvEntry(file)
  const from = dateValue(day) - sourceOffset
  const to = from + BYBIT_DAY_MS
  let bytes = 0
  const utf8 = body.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      bytes += chunk.length
      if (bytes > size) throw zipError()
      controller.enqueue(chunk)
    },
  })).pipeThrough(new TextDecoderStream('utf-8', { fatal: true }))
  const reader = utf8.getReader()
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  let columns: number[] | undefined
  let rows = 0
  let partial = ''
  let nextYield = performance.now() + 16
  const line = (raw: string) => {
    const value = raw.trim()
    if (!value) return
    const fields = value.split(',')
    if (!columns) {
      columns = tradeColumns.map(name => fields.indexOf(name))
      if (columns.includes(-1) || new Set(fields).size !== fields.length) throw new Error('OKX 日档 CSV 字段无效')
      return
    }
    const [tickerColumn, idColumn, sideColumn, priceColumn, sizeColumn, timeColumn] = columns
    const ticker = fields[tickerColumn]
    const id = fields[idColumn]
    const sideValue = fields[sideColumn]?.toLowerCase()
    const price = fields[priceColumn]
    const size = fields[sizeColumn]
    const amount = Number(price)
    const contracts = Number(size)
    const stamp = fields[timeColumn]
    const time = Number(stamp)
    if (ticker !== symbol || !/^\d+$/.test(id) || (sideValue !== 'buy' && sideValue !== 'sell') ||
        !positiveDecimal.test(price) || !positiveDecimal.test(size) || !(amount > 0) || !(contracts > 0) ||
        !Number.isFinite(amount * contracts) || !/^\d+$/.test(stamp) || !Number.isSafeInteger(time) || time < from || time >= to) {
      throw new Error('OKX 日档成交记录无效')
    }
    rows++
    onTrade({ id, time, price, size, side: sideValue === 'buy' ? 'Buy' : 'Sell' })
  }
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      const text = partial + value
      let start = 0
      for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
        line(text.slice(start, end))
        start = end + 1
      }
      partial = text.slice(start)
      if (partial.length > 16_384) throw new Error('OKX 日档 CSV 行过长')
      if (performance.now() >= nextYield) {
        await new Promise(resolve => setTimeout(resolve, 0))
        nextYield = performance.now() + 16
      }
    }
    signal?.throwIfAborted()
    if (bytes !== size) throw zipError()
    line(partial)
    if (!rows) throw new Error('OKX 日档没有成交记录')
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
  }
}

function checkDownloadZip(contentLength: string | null) {
  const prefix = new Uint8Array(4)
  const signature = new DataView(prefix.buffer)
  const tail = new Uint8Array(maxZipTail)
  let bytes = 0
  let position = 0
  return new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      if (bytes < prefix.length) prefix.set(chunk.subarray(0, prefix.length - bytes), bytes)
      bytes += chunk.length
      if (chunk.length >= tail.length) {
        tail.set(chunk.subarray(chunk.length - tail.length))
        position = 0
      } else {
        const beforeWrap = Math.min(tail.length - position, chunk.length)
        tail.set(chunk.subarray(0, beforeWrap), position)
        tail.set(chunk.subarray(beforeWrap), 0)
        position = (position + chunk.length) % tail.length
      }
      if (bytes >= prefix.length && signature.getUint32(0, true) !== 0x04034b50) throw zipError()
      controller.enqueue(chunk)
    },
    flush() {
      if (bytes < 4 || (contentLength !== null && bytes !== Number(contentLength))) throw zipError()
      if (bytes < tail.length) zipDirectory(tail.subarray(0, bytes), bytes)
      else {
        const ordered = new Uint8Array(tail.length)
        ordered.set(tail.subarray(position))
        ordered.set(tail.subarray(0, position), tail.length - position)
        zipDirectory(ordered, bytes)
      }
    },
  })
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

export class OkxLocalFiles {
  private folder?: LocalDirectory
  private allowed = false
  private changes = 0
  private restoring?: Promise<void>
  private readonly listeners = new Set<() => void>()

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  get available(): boolean { return typeof directoryPicker() === 'function' }
  get ready(): boolean { return this.allowed }
  get name(): string | undefined { return this.folder?.name }
  get revision(): number { return this.changes }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  refresh(): void {
    this.changes++
    for (const listener of this.listeners) listener()
  }

  restore(): Promise<void> {
    if (this.folder) return Promise.resolve()
    return this.restoring ??= this.restoreFolder().catch(error => {
      this.restoring = undefined
      throw error
    })
  }

  private async restoreFolder(): Promise<void> {
    if (!this.available || this.folder) return
    const folder = await (await database()).get('directories', 'okx')
    if (!folder || this.folder) return
    const allowed = await folder.queryPermission(readWrite) === 'granted'
    if (this.folder) return
    this.folder = folder
    this.allowed = allowed
    this.refresh()
  }

  async pick(): Promise<void> {
    const pick = directoryPicker()
    if (!pick) throw new Error('当前浏览器不支持选择可读写的本地文件夹')
    const folder = await pick.call(globalThis, readWrite)
    const allowed = await folder.queryPermission(readWrite) === 'granted'
    this.folder = folder
    this.allowed = allowed
    this.refresh()
    try { await (await database()).put('directories', folder, 'okx') }
    catch (cause) { throw new Error('当前可使用此文件夹，刷新后需要重新选择', { cause }) }
  }

  async authorize(): Promise<void> {
    const folder = this.folder
    if (!folder) throw new Error('请先选择 OKX 日档文件夹')
    const allowed = await folder.requestPermission(readWrite) === 'granted'
    if (this.folder !== folder) return
    if (this.allowed !== allowed) {
      this.allowed = allowed
      this.refresh()
    }
    if (!allowed) throw new Error('请授予 OKX 日档文件夹的读写权限')
  }

  async list(): Promise<OkxLocalFile[]> {
    if (!this.folder || !this.allowed) return []
    const files: OkxLocalFile[] = []
    for await (const entry of this.folder.values()) {
      const match = archiveName.exec(entry.name)
      if (entry.kind !== 'file' || !match || !Number.isFinite(dateValue(match[2]))) continue
      const [, symbol, day] = match
      files.push({ symbol, day, filename: entry.name })
    }
    return files.sort((a, b) => b.day.localeCompare(a.day) || a.symbol.localeCompare(b.symbol))
  }

  async scan(symbol: string, day: string, onTrade: (trade: OkxLocalTrade) => void, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    const name = filename(symbol, day)
    if (!this.folder || !this.allowed) return false
    const handle = await findFile(this.folder, name)
    if (!handle) return false
    await scanArchive(await handle.getFile(), symbol, day, onTrade, signal)
    return true
  }

  async read(symbol: string, day: string, signal?: AbortSignal): Promise<OkxLocalTrade[] | undefined> {
    const trades: OkxLocalTrade[] = []
    return await this.scan(symbol, day, trade => trades.push(trade), signal) ? trades : undefined
  }

  async download(symbol: string, from: string, to: string, onProgress: (result: OkxLocalDownloadResult) => void, signal?: AbortSignal): Promise<void> {
    filename(symbol, from)
    const start = dateValue(from)
    const end = dateValue(to)
    if (!Number.isFinite(end) || start > end) throw new Error('请选择有效的 OKX 日档日期范围')
    const folder = this.folder
    if (!folder || !this.allowed) throw new Error('请先授予 OKX 日档文件夹读写权限')

    // The catalog only accepts short ranges. Progress covers both endpoints.
    const batchSize = 10
    let saved = false
    try {
      for (let batch = start; batch <= end; batch += batchSize * BYBIT_DAY_MS) {
        signal?.throwIfAborted()
        const last = Math.min(end, batch + (batchSize - 1) * BYBIT_DAY_MS)
        let index: Promise<Map<string, string>> | undefined
        for (let time = batch; time <= last; time += BYBIT_DAY_MS) {
          signal?.throwIfAborted()
          const day = bybitDay(time)
          const name = filename(symbol, day)
          let result: OkxLocalDownloadResult
          try {
            const process = async (): Promise<OkxLocalDownloadResult> => {
              const current = await findFile(folder, name)
              if (current && (await current.getFile()).size > 0) return { day, status: 'existing' }
              index ??= this.downloadIndex(symbol, batch, last, signal)
              const url = (await index).get(name)
              if (!url) return { day, status: 'unavailable' }
              return { day, status: await this.saveArchive(folder, name, url, signal) }
            }
            const locks = globalThis.navigator?.locks
            result = locks ? await locks.request(`workstation-okx-download:${name}`, { signal }, process) : await process()
          } catch (error) {
            signal?.throwIfAborted()
            result = { day, status: 'failed', message: errorMessage(error) }
          }
          saved ||= result.status === 'saved'
          onProgress(result)
        }
      }
    } finally {
      if (saved && this.folder === folder) this.refresh()
    }
  }

  private async downloadIndex(symbol: string, start: number, end: number, signal?: AbortSignal): Promise<Map<string, string>> {
    const query = new URLSearchParams({ module: '1', instType: 'SWAP', dateAggrType: 'daily',
      instFamilyList: symbol.replace(/-SWAP$/, ''), begin: String(start - sourceOffset), end: String(end - sourceOffset) })
    const timeout = AbortSignal.timeout(20_000)
    const response = await this.fetcher.call(globalThis, `https://www.okx.com/api/v5/public/market-data-history?${query}`,
      { credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    if (!response.ok) throw new Error(`OKX 日档清单查询失败（HTTP ${response.status}）`)
    const result: { code?: string; data?: { details: { groupDetails: { filename: string; url: string }[] }[] }[] } = await response.json()
    if (result.code !== '0' || !Array.isArray(result.data)) throw new Error('OKX 日档清单返回无效结果')
    const files = new Map<string, string>()
    for (const group of result.data) {
      if (!Array.isArray(group?.details)) throw new Error('OKX 日档清单返回无效结果')
      for (const item of group.details) {
        if (!Array.isArray(item?.groupDetails)) throw new Error('OKX 日档清单返回无效结果')
        for (const file of item.groupDetails) {
          if (typeof file?.filename !== 'string' || typeof file.url !== 'string') throw new Error('OKX 日档清单返回无效结果')
          files.set(file.filename, file.url)
        }
      }
    }
    return files
  }

  private async saveArchive(folder: LocalDirectory, name: string, address: string, signal?: AbortSignal): Promise<'saved' | 'unavailable'> {
    const url = new URL(address)
    if (url.origin !== 'https://static.okx.com' || url.username || url.password || !url.pathname.endsWith(`/${name}`)) {
      throw new Error('OKX 日档下载地址无效')
    }
    const response = await this.fetcher.call(globalThis, url.href, { credentials: 'omit', redirect: 'error', signal })
    if (response.status === 404) return 'unavailable'
    if (response.status !== 200 || !response.body) throw new Error(`OKX 日档下载失败（HTTP ${response.status}）`)
    const file = await folder.getFileHandle(name, { create: true })
    let writer: FileSystemWritableFileStream | undefined
    try {
      writer = await file.createWritable()
      const length = response.headers.has('content-encoding') ? null : response.headers.get('content-length')
      await response.body.pipeThrough(checkDownloadZip(length)).pipeTo(writer, { signal, preventClose: true })
      signal?.throwIfAborted()
      await writer.close()
    } catch (error) {
      await writer?.abort(error).catch(() => {})
      if (!response.body.locked) await response.body.cancel().catch(() => {})
      if (await file.getFile().then(file => file.size === 0).catch(() => false)) await folder.removeEntry(name).catch(() => {})
      throw error
    }
    return 'saved'
  }
}

export const okxLocalFiles = new OkxLocalFiles()
