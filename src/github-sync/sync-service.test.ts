import { describe, expect, it, vi } from 'vitest'
import type { MarketCandle, MarketSymbol } from '../market-data/models'
import {
  BACKUP_FILE_TYPE,
  BACKUP_SCHEMA_VERSION,
  type BackupEnvelope,
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
  return {
    fileType: BACKUP_FILE_TYPE,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    kind: 'all',
    exportedAt: 1,
    data: {
      preferences: {
        binanceRestBaseUrl: 'https://fapi.binance.com',
        favoriteSymbols: ['BTCUSDT'],
        selectedSymbol: { ticker: 'ETHUSDT', pricePrecision: 2, volumePrecision: 3 },
        chartIndicators: {
          schemaVersion: 1,
          main: [
            {
              name: 'MA',
              calcParams: [7, 25, 99],
              visible: true,
              styles: null,
            },
          ],
          sub: [],
        },
      },
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
  it('prepares config files and gzip-compressed monthly market chunks', async () => {
    const files = await service(new MemoryBackupService()).prepare()

    expect(files.map((file) => file.path)).toEqual([
      'config/favorites.json',
      'config/preferences.json',
      'market-data/BTCUSDT/1m/2024/01.json.gz',
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
