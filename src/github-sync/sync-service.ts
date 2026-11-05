import type { MarketCandle, MarketSymbol } from '../market-data/models'
import type { ReplaySession } from '../replay/models'
import { normalizeSimulationStatePrices, type SimulationState } from '../simulation/models'
import {
  BACKUP_FILE_TYPE,
  BACKUP_SCHEMA_VERSION,
  type BackupEnvelope,
  type BackupPreferences,
  WorkstationBackupService,
  validateBackupEnvelope,
} from '../storage/backup-service'
import {
  GitHubConflictError,
  GitHubContentsClient,
  type GitHubFile,
} from './github-client'

const MANIFEST_TYPE = 'crypto-contract-workstation-manifest'
const MANIFEST_VERSION = 1
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type ConflictResolution =
  | 'stop'
  | 'keep-local'
  | 'keep-remote'
  | 'save-copy'

export interface SyncSelection {
  config: boolean
  sessions: boolean
  marketData: boolean
}

export const ALL_SYNC_SELECTION: SyncSelection = {
  config: true,
  sessions: true,
  marketData: true,
}

export interface SyncFile {
  path: string
  bytes: Uint8Array
  checksum: string
  size: number
  category: 'config' | 'session' | 'trade' | 'market-data'
}

export interface SyncManifestEntry {
  path: string
  checksum: string
  size: number
  category: SyncFile['category']
  updatedAt: number
}

export interface SyncManifest {
  fileType: typeof MANIFEST_TYPE
  schemaVersion: typeof MANIFEST_VERSION
  updatedAt: number
  files: SyncManifestEntry[]
}

export interface SyncComparison {
  localFiles: number
  localBytes: number
  remoteFiles: number
  remoteBytes: number
  changedFiles: number
  remoteExists: boolean
}

export interface SyncResult {
  files: number
  bytes: number
  copiedConflicts: number
  skippedConflicts: number
}

export type SyncProgress = (message: string) => void

interface MarketChunk {
  fileType: 'crypto-contract-workstation-market-chunk'
  schemaVersion: 1
  symbol: string
  timeframe: string
  year: number
  month: number
  symbolInfo: MarketSymbol
  tradeCandles: MarketCandle[]
  /** Legacy input only, omitted from new chunks. */
  markCandles?: MarketCandle[]
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value, null, 2))
}

function parseJson(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes))
  } catch {
    throw new Error(`远端文件 ${path} 不是有效 JSON`)
  }
}

async function transformStream(
  bytes: Uint8Array,
  format: 'gzip' | 'gunzip',
): Promise<Uint8Array> {
  const stream =
    format === 'gzip'
      ? new CompressionStream('gzip')
      : new DecompressionStream('gzip')
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes))
      controller.close()
    },
  })
  const transformed = source.pipeThrough(stream)
  return new Uint8Array(await new Response(transformed).arrayBuffer())
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return transformStream(bytes, 'gzip')
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return transformStream(bytes, 'gunzip')
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const source = new Uint8Array(bytes)
  const digest = await crypto.subtle.digest('SHA-256', source)
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

export function manifest(value: unknown): SyncManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('远端 manifest.json 格式无效')
  }
  const item = value as Partial<SyncManifest>
  if (
    item.fileType !== MANIFEST_TYPE ||
    item.schemaVersion !== MANIFEST_VERSION ||
    typeof item.updatedAt !== 'number' ||
    !Number.isFinite(item.updatedAt) ||
    !Array.isArray(item.files)
  ) {
    throw new Error('远端 manifest.json 类型或版本无效')
  }
  const seen = new Set<string>()
  const files = item.files.map((entry, index) => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      typeof entry.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.checksum) ||
      typeof entry.size !== 'number' ||
      !Number.isInteger(entry.size) ||
      entry.size < 0 ||
      !['config', 'session', 'trade', 'market-data'].includes(
        String(entry.category),
      ) ||
      typeof entry.updatedAt !== 'number'
      || !Number.isFinite(entry.updatedAt)
      || entry.path.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[\\%\x00-\x1f]/.test(segment))
    ) {
      throw new Error(`远端 manifest.json 的 files[${index}] 无效`)
    }
    if (seen.has(entry.path)) {
      throw new Error(`远端 manifest.json 包含重复路径 ${entry.path}`)
    }
    seen.add(entry.path)
    return entry as SyncManifestEntry
  })
  return { ...item, files } as SyncManifest
}

function monthKey(candle: MarketCandle): string {
  const date = new Date(candle.openTime)
  return [
    candle.symbol,
    candle.timeframe,
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
  ].join('/')
}

function chunkPath(chunk: MarketChunk): string {
  return `data/market-history/${chunk.symbol}/${chunk.timeframe}/${chunk.year}/${String(
    chunk.month,
  ).padStart(2, '0')}.json.gz`
}

function copyPath(path: string, timestamp: number): string {
  const suffix = `.local-${timestamp}`
  const extensionIndex = path.indexOf('.json')
  return extensionIndex === -1
    ? `${path}${suffix}`
    : `${path.slice(0, extensionIndex)}${suffix}${path.slice(extensionIndex)}`
}

function categorySelected(
  category: SyncFile['category'],
  selection: SyncSelection,
): boolean {
  if (category === 'config') return selection.config
  if (category === 'session' || category === 'trade') {
    return selection.sessions
  }
  return selection.marketData
}

function parseMarketChunkPath(path: string): {
  symbol: string
  timeframe: string
  year: number
  month: number
} | null {
  const match =
    /^(?:market-data|data\/market-history)\/([^/]+)\/([^/]+)\/(\d{4})\/(\d{2})\.json\.gz$/.exec(
      path,
    )
  if (match === null) return null
  return {
    symbol: match[1],
    timeframe: match[2],
    year: Number(match[3]),
    month: Number(match[4]),
  }
}

async function readMarketChunk(bytes: Uint8Array, path: string): Promise<{ chunk: MarketChunk; hadMarkCandles: boolean }> {
  const parts = parseMarketChunkPath(path)
  const chunk = parseJson(await gunzip(bytes), path) as Partial<MarketChunk>
  if (!parts || chunk.fileType !== 'crypto-contract-workstation-market-chunk' || chunk.schemaVersion !== 1 || chunk.symbol !== parts.symbol || chunk.timeframe !== parts.timeframe || chunk.year !== parts.year || chunk.month !== parts.month || parts.month < 1 || parts.month > 12 || !Array.isArray(chunk.tradeCandles) || (chunk.symbolInfo !== undefined && chunk.symbolInfo.symbol !== parts.symbol)) throw new Error(`${path} 行情分片格式无效`)
  const data = validateBackupEnvelope({ fileType: BACKUP_FILE_TYPE, schemaVersion: BACKUP_SCHEMA_VERSION, kind: 'market-data', exportedAt: 0, data: { symbols: chunk.symbolInfo ? [chunk.symbolInfo] : [], tradeCandles: chunk.tradeCandles, markCandles: chunk.markCandles } }).data
  if ([...data.tradeCandles!, ...(chunk.markCandles ?? [])].some(candle => {
    const date = new Date(candle.openTime)
    return candle.symbol !== parts.symbol || candle.timeframe !== parts.timeframe || date.getUTCFullYear() !== parts.year || date.getUTCMonth() + 1 !== parts.month
  })) throw new Error(`${path} 行情分片格式无效`)
  const result = { ...chunk, tradeCandles: data.tradeCandles } as MarketChunk
  delete result.markCandles
  return { chunk: result, hadMarkCandles: Object.hasOwn(chunk, 'markCandles') }
}

function mergeChunkCandles(remote: MarketCandle[], local: MarketCandle[]): MarketCandle[] {
  return [...new Map([...remote, ...local].map(candle => [candle.openTime, candle])).values()].sort((a, b) => a.openTime - b.openTime)
}

function mergeMarketChunks(remote: MarketChunk | null, local: MarketChunk): MarketChunk {
  return { ...local, tradeCandles: mergeChunkCandles(remote?.tradeCandles ?? [], local.tradeCandles) }
}

export class GitHubSyncService {
  constructor(
    private readonly backups: WorkstationBackupService,
    private readonly now: () => number = Date.now,
  ) {}

  async prepare(
    selection: SyncSelection = ALL_SYNC_SELECTION,
  ): Promise<SyncFile[]> {
    const backup = selection.config && !selection.sessions && !selection.marketData &&
      typeof this.backups.exportPreferences === 'function'
      ? await this.backups.exportPreferences()
      : await this.backups.exportAll()
    const data = backup.data
    const files: Array<{
      path: string
      bytes: Uint8Array
      category: SyncFile['category']
    }> = []
    const preferences = data.preferences!
    if (selection.config) {
      files.push(
        {
          path: 'config/preferences.json',
          bytes: jsonBytes({
            schemaVersion: 1,
            binanceRestBaseUrl: preferences.binanceRestBaseUrl,
            chartIndicators: preferences.chartIndicators,
            selectedSymbol: preferences.selectedSymbol,
            pinnedPeriods: preferences.pinnedPeriods,
          }),
          category: 'config',
        },
        {
          path: 'config/favorites.json',
          bytes: jsonBytes({
            schemaVersion: 1,
            favoriteSymbols: preferences.favoriteSymbols,
          }),
          category: 'config',
        },
      )
    }
    if (selection.sessions) {
      for (const session of data.sessions ?? []) {
        files.push({
          path: `sessions/${session.id}.json`,
          bytes: jsonBytes(session),
          category: 'session',
        })
      }
      for (const simulation of data.simulations ?? []) {
        files.push({
          path: `trades/${simulation.sessionId}.json`,
          bytes: jsonBytes(normalizeSimulationStatePrices(simulation)),
          category: 'trade',
        })
      }
    }
    const chunks = new Map<string, MarketChunk>()
    const symbols = new Map(
      (data.symbols ?? []).map((symbol) => [symbol.symbol, symbol]),
    )
    const append = (candle: MarketCandle) => {
      const key = monthKey(candle)
      let chunk = chunks.get(key)
      if (chunk === undefined) {
        const date = new Date(candle.openTime)
        chunk = {
          fileType: 'crypto-contract-workstation-market-chunk',
          schemaVersion: 1,
          symbol: candle.symbol,
          timeframe: candle.timeframe,
          year: date.getUTCFullYear(),
          month: date.getUTCMonth() + 1,
          symbolInfo:
            symbols.get(candle.symbol) ??
            {
              symbol: candle.symbol,
              baseAsset: candle.symbol.replace(/USDT$/, ''),
              quoteAsset: 'USDT',
              contractType: 'PERPETUAL',
              status: 'TRADING',
              onboardDate: 0,
              pricePrecision: 8,
              quantityPrecision: 8,
            },
          tradeCandles: [],
        }
        chunks.set(key, chunk)
      }
      chunk.tradeCandles.push(candle)
    }
    if (selection.marketData) {
      data.tradeCandles?.forEach(append)
      for (const chunk of [...chunks.values()].sort((left, right) =>
        chunkPath(left).localeCompare(chunkPath(right)),
      )) {
        files.push({
          path: chunkPath(chunk),
          bytes: await gzip(jsonBytes(chunk)),
          category: 'market-data',
        })
      }
    }
    return Promise.all(
      files
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(async (file) => ({
          ...file,
          checksum: await sha256(file.bytes),
          size: file.bytes.byteLength,
        })),
    )
  }

  async compare(
    client: GitHubContentsClient,
    selection: SyncSelection = ALL_SYNC_SELECTION,
  ): Promise<SyncComparison> {
    const local = await this.prepare(selection)
    const remoteFile = await client.getFile('manifest.json')
    if (remoteFile === null) {
      return {
        localFiles: local.length,
        localBytes: local.reduce((sum, file) => sum + file.size, 0),
        remoteFiles: 0,
        remoteBytes: 0,
        changedFiles: local.length,
        remoteExists: false,
      }
    }
    const remote = manifest(parseJson(remoteFile.bytes, 'manifest.json'))
    const selectedRemoteFiles = remote.files.filter((file) =>
      categorySelected(file.category, selection),
    )
    const remoteChecksums = new Map(
      selectedRemoteFiles.map((file) => [file.path, file.checksum]),
    )
    const localPaths = new Set(local.map((file) => file.path))
    const changedLocal = local.filter(
      (file) => remoteChecksums.get(file.path) !== file.checksum,
    ).length
    const remoteOnly = selectedRemoteFiles.filter(
      (file) => !localPaths.has(file.path),
    ).length
    return {
      localFiles: local.length,
      localBytes: local.reduce((sum, file) => sum + file.size, 0),
      remoteFiles: selectedRemoteFiles.length,
      remoteBytes: selectedRemoteFiles.reduce(
        (sum, file) => sum + file.size,
        0,
      ),
      changedFiles: changedLocal + remoteOnly,
      remoteExists: true,
    }
  }

  async upload(
    client: GitHubContentsClient,
    resolution: ConflictResolution,
    selection: SyncSelection = ALL_SYNC_SELECTION,
    onProgress?: SyncProgress,
  ): Promise<SyncResult> {
    const localFiles = await this.prepare(selection)
    const baseline = new Map<string, string | null>()
    const desired = new Map<string, SyncFile>()
    const makeFile = async (path: string, bytes: Uint8Array, category: SyncFile['category']): Promise<SyncFile> => ({
      path, bytes, category, size: bytes.length, checksum: await sha256(bytes),
    })
    // A selected conflict policy permits one rebuild against a fresh head.
    // The second ref race stops; neither attempt ever forces a branch update.
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = await client.getSnapshot()
      const cache = new Map<string, GitHubFile | null>()
      const read = async (path: string): Promise<GitHubFile | null> => {
        if (!cache.has(path)) {
          const value = await client.getFile(path, { ref: snapshot.commitSha })
          cache.set(path, value)
          if (attempt === 0) baseline.set(path, value?.sha ?? null)
        }
        return cache.get(path)!
      }
      const changed = (path: string, file: GitHubFile | null) => attempt > 0 && (baseline.get(path) ?? null) !== (file?.sha ?? null)
      const manifestFile = await read('manifest.json')
      const remote = manifestFile ? manifest(parseJson(manifestFile.bytes, 'manifest.json')) : null
      const entries = new Map((remote?.files ?? []).map(entry => [entry.path, entry]))
      const pending = new Map<string, SyncFile>()
      let copiedConflicts = 0
      let skippedConflicts = 0
      let byteCount = 0
      const stage = (file: SyncFile) => {
        pending.set(file.path, file)
        entries.set(file.path, this.entry(file))
      }
      for (const [index, prepared] of localFiles.entries()) {
        // Rebuild from actual local rows on every attempt. A previous merged
        // candidate includes remote-only rows that a newer head may correct.
        let file = prepared
        onProgress?.(`准备上传 ${index + 1}/${localFiles.length}：${file.path}`)
        const current = await read(file.path)
        let conflicted = changed(file.path, current)
        let remoteMonth: MarketChunk | null = null
        if (file.category === 'market-data') {
          let localChunk = (await readMarketChunk(file.bytes, file.path)).chunk
          const oldPath = file.path.replace('data/market-history/', 'market-data/')
          for (const remotePath of [oldPath, file.path]) {
            const entry = entries.get(remotePath)
            if (!entry) continue
            const remoteFile = await read(remotePath)
            if (!remoteFile || remoteFile.bytes.length !== entry.size || await sha256(remoteFile.bytes) !== entry.checksum) throw new Error(`远端文件校验失败：${remotePath}`)
            conflicted ||= changed(remotePath, remoteFile)
            const value = await readMarketChunk(remoteFile.bytes, remotePath)
            remoteMonth = mergeMarketChunks(remoteMonth, value.chunk)
            if (remotePath !== file.path && value.hadMarkCandles) {
              stage(await makeFile(remotePath, await gzip(jsonBytes(value.chunk)), 'market-data'))
            }
          }
          // Resolve cloud aliases first (canonical wins), then overlay only
          // actual local candles once. Legacy-only rows must not masquerade as
          // local rows and override their canonical replacement.
          localChunk = mergeMarketChunks(remoteMonth, localChunk)
          file = await makeFile(file.path, await gzip(jsonBytes(localChunk)), file.category)
        }
        if (attempt === 0) desired.set(file.path, file)
        if (conflicted && resolution !== 'keep-local' && resolution !== 'stop') {
          if (current === null && remoteMonth === null && resolution === 'keep-remote') throw new GitHubConflictError(file.path)
          if (current !== null || remoteMonth !== null) {
            const winner = remoteMonth
              ? await makeFile(file.path, await gzip(jsonBytes(remoteMonth)), file.category)
              : await makeFile(file.path, current!.bytes, file.category)
            if (remoteMonth) stage(winner)
            else entries.set(winner.path, this.entry(winner))
            if (resolution === 'keep-remote') skippedConflicts++
            else {
              // Copies deliberately retain the established .local-* naming and
              // remain outside the active business manifest.
              const original = desired.get(file.path) ?? file
              const path = copyPath(file.path, this.now())
              if (await read(path) !== null) throw new GitHubConflictError(path, '同名冲突副本已存在，已停止覆盖')
              pending.set(path, { ...original, path })
              copiedConflicts++
            }
            byteCount += winner.size
            continue
          }
        }
        stage(file)
        byteCount += file.size
      }
      const nextManifest: SyncManifest = {
        fileType: MANIFEST_TYPE,
        schemaVersion: MANIFEST_VERSION,
        updatedAt: this.now(),
        files: [...entries.values()].sort((left, right) => left.path.localeCompare(right.path)),
      }
      try {
        onProgress?.('正在原子提交业务文件与清单…')
        await client.commitFiles([
          ...pending.values(),
          { path: 'manifest.json', bytes: jsonBytes(nextManifest) },
        ], 'Sync workstation data and manifest', snapshot)
        return { files: localFiles.length, bytes: byteCount, copiedConflicts, skippedConflicts }
      } catch (error) {
        if (!(error instanceof GitHubConflictError) || resolution === 'stop' || attempt > 0) throw error
      }
    }
    throw new GitHubConflictError('manifest.json')
  }

  async pull(
    client: GitHubContentsClient,
    onProgress?: SyncProgress,
  ): Promise<SyncResult> {
    const manifestFile = await client.getFile('manifest.json')
    if (manifestFile === null) {
      throw new Error('远端仓库中没有 manifest.json')
    }
    const remote = manifest(parseJson(manifestFile.bytes, 'manifest.json'))
    if (remote.files.length === 0) return {files:0,bytes:0,copiedConflicts:0,skippedConflicts:0}
    const hasConfig = remote.files.some((entry) => entry.category === 'config')
    const hasSessions = remote.files.some(
      (entry) => entry.category === 'session' || entry.category === 'trade',
    )
    const hasMarketData = remote.files.some(
      (entry) => entry.category === 'market-data',
    )
    const configOnly = hasConfig && !hasSessions && !hasMarketData
    const current = configOnly && typeof this.backups.exportPreferences === 'function'
      ? await this.backups.exportPreferences()
      : await this.backups.exportAll()
    const preferences: Partial<BackupPreferences> = hasConfig
      ? {}
      : { ...current.data.preferences! }
    const sessions: ReplaySession[] = hasSessions
      ? []
      : [...(current.data.sessions ?? [])]
    const simulations: SimulationState[] = hasSessions
      ? []
      : [...(current.data.simulations ?? [])]
    const tradeCandles: MarketCandle[] = hasMarketData
      ? []
      : [...(current.data.tradeCandles ?? [])]
    const symbols = new Map<string, MarketSymbol>(
      hasMarketData
        ? []
        : (current.data.symbols ?? []).map((symbol) => [
            symbol.symbol,
            symbol,
          ]),
    )
    let bytes = 0
    // Migrated minute chunks may coexist with legacy files. Read legacy first
    // so the project data path wins for overlapping candle identities.
    const orderedFiles = [...remote.files].sort((left, right) => Number(right.path.startsWith('market-data/')) - Number(left.path.startsWith('market-data/')))
    for (const [index, entry] of orderedFiles.entries()) {
      onProgress?.(`拉取 ${index + 1}/${remote.files.length}：${entry.path}`)
      const file = await client.getFile(entry.path)
      if (file === null) {
        throw new Error(`远端清单中的文件不存在：${entry.path}`)
      }
      bytes += file.bytes.byteLength
      if (
        file.bytes.byteLength !== entry.size ||
        (await sha256(file.bytes)) !== entry.checksum
      ) {
        throw new Error(`远端文件校验失败：${entry.path}`)
      }
      if (entry.path === 'config/preferences.json') {
        const value = parseJson(file.bytes, entry.path) as {
          schemaVersion?: unknown
          binanceRestBaseUrl?: unknown
          chartIndicators?: unknown
          selectedSymbol?: unknown
          pinnedPeriods?: unknown
        }
        if (
          value.schemaVersion !== 1 ||
          typeof value.binanceRestBaseUrl !== 'string'
        ) {
          throw new Error(`${entry.path} 格式无效`)
        }
        preferences.binanceRestBaseUrl = value.binanceRestBaseUrl
        if (value.pinnedPeriods !== undefined) {
          preferences.pinnedPeriods = value.pinnedPeriods as BackupPreferences['pinnedPeriods']
        }
        if (value.selectedSymbol !== undefined) {
          preferences.selectedSymbol = value.selectedSymbol as BackupPreferences['selectedSymbol']
        }
        if (value.chartIndicators !== undefined) {
          preferences.chartIndicators =
            value.chartIndicators as BackupPreferences['chartIndicators']
        }
      } else if (entry.path === 'config/favorites.json') {
        const value = parseJson(file.bytes, entry.path) as {
          schemaVersion?: unknown
          favoriteSymbols?: unknown
        }
        if (
          value.schemaVersion !== 1 ||
          !Array.isArray(value.favoriteSymbols)
        ) {
          throw new Error(`${entry.path} 格式无效`)
        }
        preferences.favoriteSymbols = value.favoriteSymbols as string[]
      } else if (/^sessions\/[^/]+\.json$/.test(entry.path)) {
        sessions.push(parseJson(file.bytes, entry.path) as ReplaySession)
      } else if (/^trades\/[^/]+\.json$/.test(entry.path)) {
        simulations.push(
          parseJson(file.bytes, entry.path) as SimulationState,
        )
      } else if (parseMarketChunkPath(entry.path) !== null) {
        const { chunk } = await readMarketChunk(file.bytes, entry.path)
        tradeCandles.push(...chunk.tradeCandles)
        if (chunk.symbolInfo !== undefined) symbols.set(chunk.symbolInfo.symbol, chunk.symbolInfo)
      } else {
        throw new Error(`远端清单包含不支持的路径：${entry.path}`)
      }
    }
    onProgress?.('正在合并已校验的云端数据…')
    const uniqueCandles = (candles: MarketCandle[]) => [...new Map(candles.map(candle => [`${candle.symbol}:${candle.timeframe}:${candle.openTime}`, candle])).values()].sort(this.candleOrder)
    const backup: BackupEnvelope = {
      fileType: BACKUP_FILE_TYPE,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind: configOnly ? 'preferences' : 'all',
      exportedAt: remote.updatedAt,
      data: {
        preferences: preferences as BackupPreferences,
        symbols: [],
        tradeCandles: uniqueCandles(tradeCandles),
        sessions,
        simulations,
      },
    }
    const symbolMap = new Map<string, ReplaySession['symbol']>()
    for (const session of sessions) {
      symbolMap.set(session.symbol.ticker, session.symbol)
    }
    for (const candle of tradeCandles) {
      if (!symbolMap.has(candle.symbol)) {
        symbolMap.set(candle.symbol, {
          ticker: candle.symbol,
          exchange: 'BINANCE',
          market: 'USDT-M PERPETUAL',
          name: candle.symbol,
          shortName: candle.symbol,
          priceCurrency: 'USDT',
          type: 'PERPETUAL',
          pricePrecision: 8,
          volumePrecision: 8,
        })
      }
    }
    backup.data.symbols = [
      ...symbols.values(),
      ...[...symbolMap.values()]
        .filter((symbol) => !symbols.has(symbol.ticker))
        .map((symbol) => ({
          symbol: symbol.ticker,
          baseAsset: symbol.ticker.replace(/USDT$/, ''),
          quoteAsset: 'USDT' as const,
          contractType: 'PERPETUAL' as const,
          status: 'TRADING' as const,
          onboardDate: 0,
          pricePrecision: symbol.pricePrecision ?? 8,
          quantityPrecision: symbol.volumePrecision ?? 8,
        })),
    ]
    await this.backups.import(validateBackupEnvelope(backup), onProgress)
    return {
      files: remote.files.length,
      bytes,
      copiedConflicts: 0,
      skippedConflicts: 0,
    }
  }

  private entry(file: SyncFile): SyncManifestEntry {
    return {
      path: file.path,
      checksum: file.checksum,
      size: file.size,
      category: file.category,
      updatedAt: this.now(),
    }
  }

  private candleOrder(left: MarketCandle, right: MarketCandle): number {
    return (
      left.symbol.localeCompare(right.symbol) ||
      left.timeframe.localeCompare(right.timeframe) ||
      left.openTime - right.openTime
    )
  }
}
