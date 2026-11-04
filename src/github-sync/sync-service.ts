import type { MarketCandle, MarketSymbol } from '../market-data/models'
import type { ReplaySession } from '../replay/models'
import type { SimulationState } from '../simulation/models'
import {
  BACKUP_FILE_TYPE,
  BACKUP_SCHEMA_VERSION,
  type BackupEnvelope,
  type BackupPreferences,
  WorkstationBackupService,
} from '../storage/backup-service'
import {
  GitHubConflictError,
  GitHubContentsClient,
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
  markCandles: MarketCandle[]
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

function manifest(value: unknown): SyncManifest {
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
  return `market-data/${chunk.symbol}/${chunk.timeframe}/${chunk.year}/${String(
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
    /^market-data\/([^/]+)\/([^/]+)\/(\d{4})\/(\d{2})\.json\.gz$/.exec(
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

export class GitHubSyncService {
  constructor(
    private readonly backups: WorkstationBackupService,
    private readonly now: () => number = Date.now,
  ) {}

  async prepare(
    selection: SyncSelection = ALL_SYNC_SELECTION,
  ): Promise<SyncFile[]> {
    const backup = await this.backups.exportAll()
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
          bytes: jsonBytes(simulation),
          category: 'trade',
        })
      }
    }
    const chunks = new Map<string, MarketChunk>()
    const symbols = new Map(
      (data.symbols ?? []).map((symbol) => [symbol.symbol, symbol]),
    )
    const append = (kind: 'trade' | 'mark', candle: MarketCandle) => {
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
          markCandles: [],
        }
        chunks.set(key, chunk)
      }
      if (kind === 'trade') chunk.tradeCandles.push(candle)
      else chunk.markCandles.push(candle)
    }
    if (selection.marketData) {
      data.tradeCandles?.forEach((candle) => append('trade', candle))
      data.markCandles?.forEach((candle) => append('mark', candle))
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
    const existingManifestFile = await client.getFile('manifest.json')
    const existingManifest =
      existingManifestFile === null
        ? null
        : manifest(parseJson(existingManifestFile.bytes, 'manifest.json'))
    const selectedCategories = new Set<SyncFile['category']>()
    if (selection.config) selectedCategories.add('config')
    if (selection.sessions) {
      selectedCategories.add('session')
      selectedCategories.add('trade')
    }
    if (selection.marketData) selectedCategories.add('market-data')
    const effectiveEntries: SyncManifestEntry[] =
      existingManifest?.files.filter(
        (entry) => !selectedCategories.has(entry.category),
      ) ?? []
    let copiedConflicts = 0
    let skippedConflicts = 0
    for (const [index, file] of localFiles.entries()) {
      onProgress?.(`上传 ${index + 1}/${localFiles.length}：${file.path}`)
      const current = await client.getFile(file.path)
      try {
        await client.putFile(
          file.path,
          file.bytes,
          `Sync ${file.path}`,
          current?.sha,
        )
        effectiveEntries.push(this.entry(file))
      } catch (error) {
        if (!(error instanceof GitHubConflictError) || resolution === 'stop') {
          throw error
        }
        const latest = await client.getFile(file.path)
        if (resolution === 'keep-local') {
          await client.putFile(
            file.path,
            file.bytes,
            `Resolve conflict with local ${file.path}`,
            latest?.sha,
          )
          effectiveEntries.push(this.entry(file))
        } else if (resolution === 'keep-remote') {
          if (latest === null) throw error
          effectiveEntries.push({
            path: file.path,
            checksum: await sha256(latest.bytes),
            size: latest.bytes.byteLength,
            category: file.category,
            updatedAt: this.now(),
          })
          skippedConflicts += 1
        } else {
          if (latest === null) {
            await client.putFile(
              file.path,
              file.bytes,
              `Resolve deleted remote file with local ${file.path}`,
            )
            effectiveEntries.push(this.entry(file))
          } else {
            effectiveEntries.push({
              path: file.path,
              checksum: await sha256(latest.bytes),
              size: latest.bytes.byteLength,
              category: file.category,
              updatedAt: this.now(),
            })
            const path = copyPath(file.path, this.now())
            await client.putFile(
              path,
              file.bytes,
              `Save local conflict copy ${path}`,
            )
            copiedConflicts += 1
          }
        }
      }
    }
    const nextManifest: SyncManifest = {
      fileType: MANIFEST_TYPE,
      schemaVersion: MANIFEST_VERSION,
      updatedAt: this.now(),
      files: effectiveEntries.sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    }
    const manifestBytes = jsonBytes(nextManifest)
    const currentManifest = await client.getFile('manifest.json')
    try {
      await client.putFile(
        'manifest.json',
        manifestBytes,
        'Update workstation sync manifest',
        currentManifest?.sha,
      )
    } catch (error) {
      if (
        !(error instanceof GitHubConflictError) ||
        resolution === 'stop'
      ) {
        throw error
      }
      const latest = await client.getFile('manifest.json')
      await client.putFile(
        'manifest.json',
        manifestBytes,
        'Resolve workstation manifest conflict',
        latest?.sha,
      )
    }
    return {
      files: localFiles.length,
      bytes: localFiles.reduce((sum, file) => sum + file.size, 0),
      copiedConflicts,
      skippedConflicts,
    }
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
    const current = await this.backups.exportAll()
    const hasConfig = remote.files.some((entry) => entry.category === 'config')
    const hasSessions = remote.files.some(
      (entry) => entry.category === 'session' || entry.category === 'trade',
    )
    const hasMarketData = remote.files.some(
      (entry) => entry.category === 'market-data',
    )
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
    const markCandles: MarketCandle[] = hasMarketData
      ? []
      : [...(current.data.markCandles ?? [])]
    const symbols = new Map<string, MarketSymbol>(
      hasMarketData
        ? []
        : (current.data.symbols ?? []).map((symbol) => [
            symbol.symbol,
            symbol,
          ]),
    )
    let bytes = 0
    for (const [index, entry] of remote.files.entries()) {
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
        const pathParts = parseMarketChunkPath(entry.path)!
        const chunk = parseJson(
          await gunzip(file.bytes),
          entry.path,
        ) as Partial<MarketChunk>
        if (
          chunk.fileType !== 'crypto-contract-workstation-market-chunk' ||
          chunk.schemaVersion !== 1 ||
          chunk.symbol !== pathParts.symbol ||
          chunk.timeframe !== pathParts.timeframe ||
          chunk.year !== pathParts.year ||
          chunk.month !== pathParts.month ||
          pathParts.month < 1 ||
          pathParts.month > 12 ||
          !Array.isArray(chunk.tradeCandles) ||
          !Array.isArray(chunk.markCandles) ||
          chunk.symbolInfo === undefined ||
          chunk.symbolInfo.symbol !== pathParts.symbol ||
          [...chunk.tradeCandles, ...chunk.markCandles].some((candle) => {
            const date = new Date(candle.openTime)
            return (
              candle.symbol !== pathParts.symbol ||
              candle.timeframe !== pathParts.timeframe ||
              date.getUTCFullYear() !== pathParts.year ||
              date.getUTCMonth() + 1 !== pathParts.month
            )
          })
        ) {
          throw new Error(`${entry.path} 行情分片格式无效`)
        }
        tradeCandles.push(...chunk.tradeCandles)
        markCandles.push(...chunk.markCandles)
        symbols.set(chunk.symbolInfo.symbol, chunk.symbolInfo)
      } else {
        throw new Error(`远端清单包含不支持的路径：${entry.path}`)
      }
    }
    const backup: BackupEnvelope = {
      fileType: BACKUP_FILE_TYPE,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind: 'all',
      exportedAt: remote.updatedAt,
      data: {
        preferences: preferences as BackupPreferences,
        symbols: [],
        tradeCandles: tradeCandles.sort(this.candleOrder),
        markCandles: markCandles.sort(this.candleOrder),
        sessions,
        simulations,
      },
    }
    const symbolMap = new Map<string, ReplaySession['symbol']>()
    for (const session of sessions) {
      symbolMap.set(session.symbol.ticker, session.symbol)
    }
    for (const candle of [...tradeCandles, ...markCandles]) {
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
    await this.backups.import(backup)
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
