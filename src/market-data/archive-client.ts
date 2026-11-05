import Decimal from 'decimal.js'
import { unzipSync } from 'fflate'
import type { CandleKind, MarketCandle } from './models'
import { normalizeKline } from './normalizer'

export interface ArchiveLoadOptions { signal?: AbortSignal }

const ROOT = 'https://data.binance.vision/data/futures/um'
const MINUTE = 60_000
const MAX_ZIP_BYTES = 32 * 1024 * 1024
const MAX_CSV_BYTES = 64 * 1024 * 1024
const MAX_CHECKSUM_BYTES = 4096
const HEADER_COLUMNS = [
  ['open_time'], ['open'], ['high'], ['low'], ['close'], ['volume'], ['close_time'],
  ['quote_volume', 'quote_asset_volume'], ['count', 'number_of_trades'],
  ['taker_buy_volume', 'taker_buy_base_asset_volume'],
  ['taker_buy_quote_volume', 'taker_buy_quote_asset_volume'], ['ignore'],
]

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('币安归档读取已取消', 'AbortError')
}

async function readBounded(response: Response, limit: number, label: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  checkAbort(signal)
  const declaredLength = response.headers.get('Content-Length')
  if (declaredLength !== null && Number(declaredLength) > limit) {
    await response.body?.cancel()
    throw new Error(`${label}大小过大，已停止读取`)
  }
  if (!response.body) throw new Error(`${label}响应内容为空`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      checkAbort(signal)
      const { done, value } = await reader.read()
      checkAbort(signal)
      if (done) break
      length += value.byteLength
      if (length > limit) {
        await reader.cancel()
        throw new Error(`${label}大小过大，已停止读取`)
      }
      chunks.push(value)
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function parseCsv(bytes: Uint8Array, symbol: string, kind: CandleKind, from: number, to: number, signal?: AbortSignal): MarketCandle[] {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    throw new Error('CSV 不是有效的 UTF-8 文本')
  }
  const lines = text.trimEnd().split(/\r?\n/)
  const now = Date.now()
  const candles: MarketCandle[] = []
  let previousTime = -1
  for (let index = 0; index < lines.length; index++) {
    checkAbort(signal)
    const fields = lines[index]!.split(',').map((field) => field.trim())
    if (index === 0 && fields[0] === 'open_time') {
      if (fields.length !== 12 || !fields.every((field, column) => HEADER_COLUMNS[column]!.includes(field))) {
        throw new Error('CSV 表头结构无效')
      }
      continue
    }
    const invalid = (reason: string): never => { throw new Error(`CSV 第 ${index + 1} 行${reason}`) }
    if (fields.length !== 12 || fields.some((field) => field.length === 0)) invalid('字段缺失或列数无效')
    for (const column of [0, 6, 8]) {
      if (!/^\d+$/.test(fields[column]!) || !Number.isSafeInteger(Number(fields[column]))) invalid('时间或交易笔数必须是非负安全整数')
    }
    const openTime = Number(fields[0])
    const closeTime = Number(fields[6])
    if (openTime % MINUTE !== 0 || closeTime !== openTime + MINUTE - 1) invalid('不是完整的 1 分钟时间范围')
    if (openTime < from || openTime >= to) invalid('时间超出请求日期范围')
    if (openTime <= previousTime) invalid('时间顺序错误或存在重复分钟')
    if (closeTime >= now) invalid('尚未收盘或属于未来分钟')
    for (const column of [1, 2, 3, 4, 5, 7, 9, 10, 11]) {
      const value = fields[column]!
      if (!/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) invalid('存在非法非负数字')
    }
    const open = new Decimal(fields[1]!)
    const high = new Decimal(fields[2]!)
    const low = new Decimal(fields[3]!)
    const close = new Decimal(fields[4]!)
    if (high.lt(open) || high.lt(close) || low.gt(open) || low.gt(close) || high.lt(low)) invalid('OHLC 价格关系无效')
    candles.push(normalizeKline(fields, symbol, '1m', kind, now))
    previousTime = openTime
    if (candles.length > (to - from) / MINUTE) invalid('分钟数量超出请求日期范围')
  }
  if (candles.length === 0) throw new Error('CSV 未包含任何有效分钟 K 线')
  return candles
}

export class BinanceArchiveClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  loadMonth(kind: CandleKind, symbol: string, year: number, month: number, options: ArchiveLoadOptions = {}): Promise<MarketCandle[] | null> {
    return this.load(kind, symbol, year, month, undefined, options)
  }

  loadDay(kind: CandleKind, symbol: string, year: number, month: number, day: number, options: ArchiveLoadOptions = {}): Promise<MarketCandle[] | null> {
    return this.load(kind, symbol, year, month, day, options)
  }

  private async load(kind: CandleKind, symbol: string, year: number, month: number, day: number | undefined, options: ArchiveLoadOptions): Promise<MarketCandle[] | null> {
    const { signal } = options
    checkAbort(signal)
    if (kind !== 'trade') throw new Error('标记价格归档已停用，仅支持普通 K 线')
    symbol = symbol.toUpperCase()
    if (!/^[A-Z0-9]{2,40}$/.test(symbol)) throw new Error('币安归档交易对名称无效')
    if (!Number.isInteger(year) || year < 1970 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12 ||
      (day !== undefined && (!Number.isInteger(day) || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()))) {
      throw new Error('币安归档日期无效')
    }
    const date = `${year}-${String(month).padStart(2, '0')}${day === undefined ? '' : `-${String(day).padStart(2, '0')}`}`
    const basename = `${symbol}-1m-${date}`
    const zipName = `${basename}.zip`
    const csvName = `${basename}.csv`
    const url = `${ROOT}/${day === undefined ? 'monthly' : 'daily'}/klines/${symbol}/1m/${zipName}`
    const label = `币安成交归档 ${symbol} ${date}`
    try {
      const response = await this.fetcher.call(globalThis, url, { signal })
      checkAbort(signal)
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`ZIP 下载失败：HTTP ${response.status}`)
      const zip = await readBounded(response, MAX_ZIP_BYTES, 'ZIP 归档', signal)
      checkAbort(signal)
      const checksumResponse = await this.fetcher.call(globalThis, `${url}.CHECKSUM`, { signal })
      checkAbort(signal)
      if (!checksumResponse.ok) throw new Error(`校验文件下载失败：HTTP ${checksumResponse.status}`)
      const checksum = new TextDecoder().decode(await readBounded(checksumResponse, MAX_CHECKSUM_BYTES, '校验文件', signal)).trim()
      const match = /^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/.exec(checksum)
      if (!match || match[2] !== zipName) throw new Error('校验文件格式或归档文件名无效')
      const digest = await crypto.subtle.digest('SHA-256', zip)
      checkAbort(signal)
      const actual = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
      if (actual !== match[1]!.toLowerCase()) throw new Error('ZIP SHA-256 校验失败')
      let matches = 0
      const files = unzipSync(zip, { filter: (file) => {
        checkAbort(signal)
        if (file.name !== csvName) return false
        matches++
        if (matches > 1) throw new Error('ZIP 存在重复的预期 CSV 文件')
        if (file.originalSize > MAX_CSV_BYTES || file.size > MAX_ZIP_BYTES) throw new Error('CSV 大小过大，已停止解压')
        return true
      } })
      checkAbort(signal)
      const csv = files[csvName]
      if (!csv || matches !== 1) throw new Error(`ZIP 缺少预期 CSV 文件 ${csvName}`)
      if (csv.byteLength > MAX_CSV_BYTES) throw new Error('CSV 大小过大，已停止解析')
      const from = Date.UTC(year, month - 1, day ?? 1)
      const to = day === undefined ? Date.UTC(year, month, 1) : from + 86_400_000
      return parseCsv(csv, symbol, kind, from, to, signal)
    } catch (error) {
      checkAbort(signal)
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new Error(`${label}读取失败：${error instanceof Error ? error.message : '未知错误'}`, { cause: error })
    }
  }
}
