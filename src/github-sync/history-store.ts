import type { MarketCandle, MarketSymbol } from '../market-data/models'
import { BACKUP_FILE_TYPE, BACKUP_SCHEMA_VERSION, validateBackupEnvelope } from '../storage/backup-service'
import { GitHubContentsClient, type GitHubReadOptions, type GitHubSnapshot } from './github-client'
import { gunzip, gzip, manifest, sha256, type SyncManifest } from './sync-service'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
export interface HistoryMonth {
  tradeCandles: MarketCandle[]
  markCandles: MarketCandle[]
  symbolInfo?: MarketSymbol
}
interface Chunk extends HistoryMonth {
  fileType: 'crypto-contract-workstation-market-chunk'
  schemaVersion: 1
  symbol: string
  timeframe: '1m'
  year: number
  month: number
}
function monthPath(symbol: string, year: number, month: number): string {
  if (!/^[A-Z0-9]+USDT$/.test(symbol) || !Number.isInteger(year) || year < 1970 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) throw new Error('云端行情月份或交易对无效')
  return `data/market-history/${symbol}/1m/${year}/${String(month).padStart(2, '0')}.json.gz`
}
function validateMonth(value: HistoryMonth, symbol: string, year: number, month: number): HistoryMonth {
  const validated = validateBackupEnvelope({ fileType: BACKUP_FILE_TYPE, schemaVersion: BACKUP_SCHEMA_VERSION, kind: 'market-data', exportedAt: 0, data: { symbols: value.symbolInfo ? [value.symbolInfo] : [], tradeCandles: value.tradeCandles, markCandles: value.markCandles } }).data
  const tradeCandles = validated.tradeCandles!
  const markCandles = validated.markCandles!
  if ((value.symbolInfo && value.symbolInfo.symbol !== symbol) || [...tradeCandles, ...markCandles].some(candle => {
    const date = new Date(candle.openTime)
    return candle.symbol !== symbol || candle.timeframe !== '1m' || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || candle.openTime % 60_000 !== 0 || candle.closeTime !== candle.openTime + 59_999 || !candle.isClosed
  })) throw new Error('云端行情月份或分钟结构无效')
  return { tradeCandles, markCandles, ...(validated.symbols?.[0] ? { symbolInfo: validated.symbols[0] } : {}) }
}
function mergeCandles(remote: readonly MarketCandle[], local: readonly MarketCandle[]): MarketCandle[] {
  return [...new Map([...remote, ...local].map(candle => [candle.openTime, candle])).values()].sort((a, b) => a.openTime - b.openTime)
}
function mergeMonth(remote: HistoryMonth | null, local: HistoryMonth): HistoryMonth {
  const symbolInfo = local.symbolInfo ?? remote?.symbolInfo
  return { tradeCandles: mergeCandles(remote?.tradeCandles ?? [], local.tradeCandles), markCandles: mergeCandles(remote?.markCandles ?? [], local.markCandles), ...(symbolInfo ? { symbolInfo } : {}) }
}
function chunk(value: HistoryMonth, symbol: string, year: number, month: number): Chunk {
  return { fileType: 'crypto-contract-workstation-market-chunk', schemaVersion: 1, symbol, timeframe: '1m', year, month, ...value }
}

export class GitHubHistoryStore {
  constructor(private readonly client: GitHubContentsClient) {}

  canWrite(): boolean { return this.client.canWrite() }

  async loadMonth(symbol: string, year: number, month: number, options: { signal?: AbortSignal } = {}): Promise<HistoryMonth | null> {
    monthPath(symbol, year, month)
    options.signal?.throwIfAborted()
    const snapshot = await this.client.getSnapshot(options)
    const readOptions = { ref: snapshot.commitSha, signal: options.signal }
    const remote = await this.readManifest(readOptions)
    return this.readMonth(symbol, year, month, remote, readOptions)
  }

  async saveMonth(symbol: string, year: number, month: number, tradeCandles: readonly MarketCandle[], markCandles: readonly MarketCandle[], symbolInfo?: MarketSymbol): Promise<void> {
    const path = monthPath(symbol, year, month)
    const local = validateMonth({ tradeCandles: [...tradeCandles], markCandles: [...markCandles], ...(symbolInfo ? { symbolInfo } : {}) }, symbol, year, month)
    if (!this.canWrite()) throw new Error('请输入 GitHub Token')
    const snapshot: GitHubSnapshot = await this.client.getSnapshot()
    const options = { ref: snapshot.commitSha }
    const remoteManifest = await this.readManifest(options)
    const remote = await this.readMonth(symbol, year, month, remoteManifest, options)
    const merged = validateMonth(mergeMonth(remote, local), symbol, year, month)
    if (remote && JSON.stringify(chunk(remote, symbol, year, month)) === JSON.stringify(chunk(merged, symbol, year, month))) return
    const bytes = await gzip(encoder.encode(JSON.stringify(chunk(merged, symbol, year, month), null, 2)))
    const now = Date.now()
    const next: SyncManifest = { fileType: 'crypto-contract-workstation-manifest', schemaVersion: 1, updatedAt: now, files: [ ...(remoteManifest?.files.filter(entry => entry.path !== path) ?? []), { path, checksum: await sha256(bytes), size: bytes.length, category: 'market-data' as const, updatedAt: now } ].sort((a, b) => a.path.localeCompare(b.path)) }
    await this.client.commitFiles([{ path, bytes }, { path: 'manifest.json', bytes: encoder.encode(JSON.stringify(next, null, 2)) }], `Archive ${symbol} ${year}-${String(month).padStart(2, '0')}`, snapshot)
  }

  private async readManifest(options: GitHubReadOptions): Promise<SyncManifest | null> {
    const file = await this.client.getFile('manifest.json', options)
    options.signal?.throwIfAborted()
    return file ? manifest(JSON.parse(decoder.decode(file.bytes))) : null
  }

  private async readMonth(symbol: string, year: number, month: number, remote: SyncManifest | null, options: GitHubReadOptions): Promise<HistoryMonth | null> {
    const path = monthPath(symbol, year, month)
    const paths = [path.replace('data/market-history', 'market-data'), path]
    let result: HistoryMonth | null = null
    for (const name of paths) {
      const entry = remote?.files.find(file => file.path === name)
      if (!entry) continue
      if (entry.category !== 'market-data') throw new Error('云端行情清单分类无效')
      const file = await this.client.getFile(name, options)
      if (!file || file.bytes.length !== entry.size || await sha256(file.bytes) !== entry.checksum) throw new Error(`远端文件校验失败：${name}`)
      options.signal?.throwIfAborted()
      const value = JSON.parse(decoder.decode(await gunzip(file.bytes))) as Chunk
      if (value.fileType !== 'crypto-contract-workstation-market-chunk' || value.schemaVersion !== 1 || value.symbol !== symbol || value.timeframe !== '1m' || value.year !== year || value.month !== month) throw new Error(`远端行情分片格式无效：${name}`)
      const valid = validateMonth(value, symbol, year, month)
      result = mergeMonth(result, valid)
    }
    options.signal?.throwIfAborted()
    return result
  }
}
