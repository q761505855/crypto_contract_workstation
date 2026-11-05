import { describe, expect, it, vi } from 'vitest'
import { PINNED_PERIODS_KEY } from '../chart/period-preferences'
import type { MarketCandle, MarketSymbol } from '../market-data/models'
import {
  BACKUP_FILE_TYPE,
  BACKUP_SCHEMA_VERSION,
  type BackupEnvelope,
  type BackupPreferences,
  WorkstationBackupService,
} from '../storage/backup-service'
import {
  GitHubConflictError,
  type GitHubFile,
  GitHubContentsClient,
} from './github-client'
import {
  ALL_SYNC_SELECTION,
  GitHubSyncService,
  gunzip,
  gzip,
  sha256,
} from './sync-service'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function symbol(): MarketSymbol {
  return {
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    contractType: 'PERPETUAL',
    status: 'TRADING',
    onboardDate: 0,
    pricePrecision: 2,
    quantityPrecision: 3,
  }
}

function candle(openTime: number, close = '100'): MarketCandle {
  return {
    symbol: 'BTCUSDT',
    timeframe: '1m',
    openTime,
    closeTime: openTime + 59_999,
    open: '100',
    high: '110',
    low: '90',
    close,
    volume: '1',
    quoteVolume: '100',
    tradeCount: 1,
    isClosed: true,
    source: 'binance',
  }
}

function backup(): BackupEnvelope {
  // Required ensures newly introduced configuration fields need archive coverage.
  const preferences: Required<BackupPreferences> = {
    binanceRestBaseUrl: 'https://fapi.binance.com',
    favoriteSymbols: ['BTCUSDT'],
    pinnedPeriods: ['1m', '1d'],
    selectedSymbol: { ticker: 'ETHUSDT', pricePrecision: 2, volumePrecision: 3 },
    chartIndicators: {
      schemaVersion: 1,
      main: [{ name: 'MA', calcParams: [7, 25, 99], visible: true, styles: null }],
      sub: [],
    },
  }
  return {
    fileType: BACKUP_FILE_TYPE,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    kind: 'all',
    exportedAt: 1,
    data: {
      preferences,
      symbols: [symbol()],
      tradeCandles: [
        candle(Date.UTC(2024, 0, 1)),
        candle(Date.UTC(2024, 0, 1, 0, 1), '101'),
      ],
      markCandles: [candle(Date.UTC(2024, 0, 1), '99')],
      sessions: [],
      simulations: [],
    },
  }
}

class MemoryBackupService {
  readonly imports: BackupEnvelope[] = []

  constructor(private readonly value = backup()) {}

  async exportAll(): Promise<BackupEnvelope> {
    return structuredClone(this.value)
  }

  async import(value: unknown): Promise<Record<string, unknown>> {
    this.imports.push(structuredClone(value) as BackupEnvelope)
    return {}
  }
}

interface StoredFile {
  sha: string
  bytes: Uint8Array
}

class MemoryGitHubClient {
  readonly files = new Map<string, StoredFile>()
  readonly putOrder: string[] = []
  conflictOnceFor: string | null = null
  private sequence = 0

  async getFile(path: string): Promise<GitHubFile | null> {
    const file = this.files.get(path)
    return file === undefined
      ? null
      : { path, sha: file.sha, bytes: new Uint8Array(file.bytes) }
  }

  async putFile(
    path: string,
    bytes: Uint8Array,
    _message: string,
    expectedSha?: string,
  ): Promise<string> {
    this.putOrder.push(path)
    const current = this.files.get(path)
    if (this.conflictOnceFor === path) {
      this.conflictOnceFor = null
      this.files.set(path, {
        sha: `raced-${++this.sequence}`,
        bytes: encoder.encode('remote-race'),
      })
      throw new GitHubConflictError(path)
    }
    if (
      (current !== undefined && expectedSha !== current.sha) ||
      (current === undefined && expectedSha !== undefined)
    ) {
      throw new GitHubConflictError(path)
    }
    const sha = `sha-${++this.sequence}`
    this.files.set(path, { sha, bytes: new Uint8Array(bytes) })
    return sha
  }
}

function service(
  backups: MemoryBackupService,
  now: () => number = () => 1_700_000_000_000,
): GitHubSyncService {
  return new GitHubSyncService(
    backups as unknown as WorkstationBackupService,
    now,
  )
}

function client(value: MemoryGitHubClient): GitHubContentsClient {
  return value as unknown as GitHubContentsClient
}

describe('GitHubSyncService', () => {
  it('compares and restores configuration without exporting or rewriting cached market history', async () => {
    const source = new MemoryBackupService()
    const target = new MemoryBackupService()
    const minimal = async (): Promise<BackupEnvelope> => ({...backup(),kind:'preferences',data:{preferences:backup().data.preferences}})
    Object.assign(source,{exportPreferences:vi.fn(minimal)})
    Object.assign(target,{exportPreferences:vi.fn(minimal)})
    const sourceAll = vi.spyOn(source,'exportAll')
    const targetAll = vi.spyOn(target,'exportAll')
    const remote = new MemoryGitHubClient()
    await service(source).upload(client(remote),'stop',{config:true,sessions:false,marketData:false})
    await service(target).pull(client(remote))
    expect(sourceAll).not.toHaveBeenCalled()
    expect(targetAll).not.toHaveBeenCalled()
    expect(target.imports[0].kind).toBe('preferences')
    expect(target.imports[0].data.tradeCandles ?? []).toHaveLength(0)
  })
  it('restores pinned periods through real backup storage and detects config-only changes', async () => {
    const storage = () => {
      const values = new Map<string, string>()
      return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    }
    const sourceStorage = storage()
    const targetStorage = storage()
    sourceStorage.setItem(PINNED_PERIODS_KEY, '["1m","1d"]')
    targetStorage.setItem(PINNED_PERIODS_KEY, '["4h"]')
    const source = new GitHubSyncService(new WorkstationBackupService(`cloud-source-${crypto.randomUUID()}`, sourceStorage))
    const targetBackups = new WorkstationBackupService(`cloud-target-${crypto.randomUUID()}`, targetStorage)
    const target = new GitHubSyncService(targetBackups)
    const remote = new MemoryGitHubClient()
    const selection = { config: true, sessions: false, marketData: false }
    await source.upload(client(remote), 'stop', selection)
    await target.pull(client(remote))
    expect(targetStorage.getItem(PINNED_PERIODS_KEY)).toBe('["1m","1d"]')
    sourceStorage.setItem(PINNED_PERIODS_KEY, '[]')
    await expect(source.compare(client(remote), selection)).resolves.toMatchObject({ changedFiles: 1 })
    await source.upload(client(remote), 'stop', selection)
    await target.pull(client(remote))
    expect(targetStorage.getItem(PINNED_PERIODS_KEY)).toBe('[]')

    // Old cloud configurations omit the new field and must retain this browser's value.
    const rewriteRemotePreferences = async (value: Record<string, unknown>) => {
      const file = remote.files.get('config/preferences.json')!
      file.bytes = encoder.encode(JSON.stringify(value))
      const manifestFile = remote.files.get('manifest.json')!
      const manifest = JSON.parse(decoder.decode(manifestFile.bytes))
      const entry = manifest.files.find((item: { path: string }) => item.path === 'config/preferences.json')
      entry.checksum = await sha256(file.bytes)
      entry.size = file.bytes.byteLength
      manifestFile.bytes = encoder.encode(JSON.stringify(manifest))
    }
    const preferences = JSON.parse(decoder.decode(remote.files.get('config/preferences.json')!.bytes))
    delete preferences.pinnedPeriods
    await rewriteRemotePreferences(preferences)
    targetStorage.setItem(PINNED_PERIODS_KEY, '["1h"]')
    await target.pull(client(remote))
    expect(targetStorage.getItem(PINNED_PERIODS_KEY)).toBe('["1h"]')

    // A correct checksum is insufficient: validate configuration before applying any of it.
    const before = await targetBackups.exportAll()
    await rewriteRemotePreferences({ ...preferences, binanceRestBaseUrl: 'https://changed.test', pinnedPeriods: ['bogus'] })
    await expect(target.pull(client(remote))).rejects.toThrow(/pinnedPeriods/)
    expect((await targetBackups.exportAll()).data).toEqual(before.data)
  })

  it('prepares config files and gzip-compressed monthly market chunks', async () => {
    const files = await service(new MemoryBackupService()).prepare()

    expect(files.map((file) => file.path)).toEqual([
      'config/favorites.json',
      'config/preferences.json',
      'data/market-history/BTCUSDT/1m/2024/01.json.gz',
    ])
    const market = files.find((file) => file.category === 'market-data')!
    expect(market.size).toBe(market.bytes.byteLength)
    await expect(sha256(market.bytes)).resolves.toBe(market.checksum)
    const chunk = JSON.parse(decoder.decode(await gunzip(market.bytes)))
    expect(chunk).toMatchObject({
      symbol: 'BTCUSDT',
      timeframe: '1m',
      year: 2024,
      month: 1,
      symbolInfo: { pricePrecision: 2, quantityPrecision: 3 },
    })
    expect(chunk.tradeCandles).toHaveLength(2)
    expect(chunk.markCandles).toHaveLength(1)
    const preferences = files.find(
      (file) => file.path === 'config/preferences.json',
    )!
    expect(JSON.parse(decoder.decode(preferences.bytes))).toMatchObject({
      chartIndicators: backup().data.preferences?.chartIndicators,
      selectedSymbol: backup().data.preferences?.selectedSymbol,
      pinnedPeriods: backup().data.preferences?.pinnedPeriods,
    })
  })

  it('uploads files serially, writes the manifest last, and compares selections', async () => {
    const remote = new MemoryGitHubClient()
    const sync = service(new MemoryBackupService())

    await expect(
      sync.upload(client(remote), 'stop', ALL_SYNC_SELECTION),
    ).resolves.toMatchObject({ files: 3, copiedConflicts: 0 })
    expect(remote.putOrder.at(-1)).toBe('manifest.json')
    const manifest = JSON.parse(
      decoder.decode(remote.files.get('manifest.json')!.bytes),
    )
    expect(manifest.files).toHaveLength(3)
    await expect(sync.compare(client(remote))).resolves.toMatchObject({
      localFiles: 3,
      remoteFiles: 3,
      changedFiles: 0,
      remoteExists: true,
    })
    await expect(
      sync.compare(client(remote), {
        config: true,
        sessions: false,
        marketData: false,
      }),
    ).resolves.toMatchObject({
      localFiles: 2,
      remoteFiles: 2,
      changedFiles: 0,
    })
  })

  it('preserves remote months and unrelated entries when uploading a local subset', async () => {
    const remote = new MemoryGitHubClient()
    const first = backup()
    first.data.tradeCandles!.push(candle(Date.UTC(2024, 1, 1)))
    await service(new MemoryBackupService(first)).upload(client(remote), 'stop')
    await service(new MemoryBackupService()).upload(client(remote), 'stop')
    const value = JSON.parse(decoder.decode(remote.files.get('manifest.json')!.bytes))
    expect(value.files.map((entry: { path: string }) => entry.path)).toContain('data/market-history/BTCUSDT/1m/2024/02.json.gz')
    const target = new MemoryBackupService()
    await service(target).pull(client(remote))
    expect(target.imports[0].data.tradeCandles).toHaveLength(3)
  })

  it('keeps more complete remote dates and the other price kind during manual partial uploads', async () => {
    const remote = new MemoryGitHubClient()
    const full = backup()
    full.data.tradeCandles!.push(candle(Date.UTC(2024, 0, 1, 0, 2)))
    full.data.markCandles!.push(candle(Date.UTC(2024, 0, 1, 0, 1), '99'))
    await service(new MemoryBackupService(full)).upload(client(remote), 'stop')
    await service(new MemoryBackupService()).upload(client(remote), 'stop')
    const target = new MemoryBackupService()
    await service(target).pull(client(remote))
    expect(target.imports[0].data.tradeCandles).toEqual(full.data.tradeCandles)
    expect(target.imports[0].data.markCandles).toEqual(full.data.markCandles)
  })

  it('can restore legacy unscoped market paths alongside the new path format', async () => {
    const remote = new MemoryGitHubClient()
    await service(new MemoryBackupService()).upload(client(remote), 'stop')
    const name = 'data/market-history/BTCUSDT/1m/2024/01.json.gz'
    const old = name.replace('data/market-history', 'market-data')
    remote.files.set(old, remote.files.get(name)!); remote.files.delete(name)
    const value = JSON.parse(decoder.decode(remote.files.get('manifest.json')!.bytes))
    value.files.find((entry: { path: string }) => entry.path === name).path = old
    remote.files.get('manifest.json')!.bytes = encoder.encode(JSON.stringify(value))
    const target = new MemoryBackupService()
    await service(target).pull(client(remote))
    expect(target.imports[0].data.preferences).toEqual(backup().data.preferences)
    expect(target.imports[0].data.tradeCandles).toEqual(backup().data.tradeCandles)
  })

  it('stops rather than silently replacing a concurrently changed manifest', async () => {
    const remote = new MemoryGitHubClient()
    await service(new MemoryBackupService()).upload(client(remote), 'stop')
    const originalPut = remote.putFile.bind(remote)
    remote.putFile = async (...args) => {
      if (args[0] === 'config/preferences.json') {
        const file = remote.files.get('manifest.json')!
        remote.files.set('manifest.json', { ...file, sha: 'concurrent-manifest' })
      }
      return originalPut(...args)
    }
    await expect(service(new MemoryBackupService()).upload(client(remote), 'keep-local')).rejects.toBeInstanceOf(GitHubConflictError)
    expect(remote.files.get('manifest.json')!.sha).toBe('concurrent-manifest')
  })

  it('restores history chunks without symbol metadata and deduplicates migrated legacy minutes', async () => {
    const remote = new MemoryGitHubClient()
    await service(new MemoryBackupService()).upload(client(remote), 'stop')
    const name = 'data/market-history/BTCUSDT/1m/2024/01.json.gz'
    const old = name.replace('data/market-history', 'market-data')
    remote.files.set(old, remote.files.get(name)!)
    const chunk = JSON.parse(decoder.decode(await gunzip(remote.files.get(name)!.bytes)))
    delete chunk.symbolInfo
    const bytes = await gzip(encoder.encode(JSON.stringify(chunk)))
    remote.files.set(name, { sha: 'new-chunk', bytes })
    const value = JSON.parse(decoder.decode(remote.files.get('manifest.json')!.bytes))
    const entry = value.files.find((item: { path: string }) => item.path === name)
    value.files.push({ ...entry, path: old })
    entry.size = bytes.length; entry.checksum = await sha256(bytes)
    remote.files.get('manifest.json')!.bytes = encoder.encode(JSON.stringify(value))
    const target = new MemoryBackupService()
    await service(target).pull(client(remote))
    expect(target.imports[0].data.tradeCandles).toEqual(backup().data.tradeCandles)
    expect(target.imports[0].data.markCandles).toEqual(backup().data.markCandles)
    expect(target.imports[0].data.symbols?.[0].symbol).toBe('BTCUSDT')
  })

  it('preserves the remote winner and saves a timestamped local copy on conflict', async () => {
    const remote = new MemoryGitHubClient()
    const timestamps = [1_700_000_000_000, 1_700_000_000_001]
    const sync = service(
      new MemoryBackupService(),
      () => timestamps.shift() ?? 1_700_000_000_002,
    )
    remote.files.set('config/preferences.json', {
      sha: 'initial',
      bytes: encoder.encode('remote-before-race'),
    })
    remote.conflictOnceFor = 'config/preferences.json'

    await expect(
      sync.upload(
        client(remote),
        'save-copy',
        { config: true, sessions: false, marketData: false },
      ),
    ).resolves.toMatchObject({ copiedConflicts: 1 })
    expect(
      [...remote.files.keys()].some((path) =>
        path.startsWith('config/preferences.local-'),
      ),
    ).toBe(true)
    expect(decoder.decode(remote.files.get('config/preferences.json')!.bytes))
      .toBe('remote-race')
  })

  it('validates every remote checksum before importing any data', async () => {
    const sourceBackups = new MemoryBackupService()
    const targetBackups = new MemoryBackupService()
    const remote = new MemoryGitHubClient()
    await service(sourceBackups).upload(
      client(remote),
      'stop',
      ALL_SYNC_SELECTION,
    )
    const target = service(targetBackups)

    await expect(target.pull(client(remote))).resolves.toMatchObject({
      files: 3,
    })
    expect(targetBackups.imports).toHaveLength(1)
    expect(targetBackups.imports[0].data).toMatchObject({
      preferences: backup().data.preferences,
      symbols: [symbol()],
    })

    targetBackups.imports.length = 0
    remote.files.set('config/preferences.json', {
      sha: 'corrupt',
      bytes: encoder.encode('{}'),
    })
    await expect(target.pull(client(remote))).rejects.toThrow()
    expect(targetBackups.imports).toHaveLength(0)
  })
})
