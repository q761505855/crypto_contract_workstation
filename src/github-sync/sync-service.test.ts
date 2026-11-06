import { describe, expect, it, vi } from 'vitest'
import { PINNED_PERIODS_KEY } from '../chart/period-preferences'
import { CHART_INDICATORS_PREFERENCE } from '../chart/indicator-preferences'
import { PIVOTS_DEFAULT_PARAMS } from '../chart/pivots'
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
  type GitHubSnapshot,
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
      main: [
        { name: 'MA', calcParams: [7, 25, 99], visible: true, styles: null },
        { name: 'KC', calcParams: [14, 2.5, 10], visible: false, styles: { lines: [{ color: '#123456', size: 0 }] } },
        { name: 'PIVOTS', calcParams: [...PIVOTS_DEFAULT_PARAMS.slice(0, 30), '#112233', '#aa1111', '#11aa11', true, '#445566', '#aa7777', '#77aa77'], visible: false, styles: null },
      ],
      sub: [{ height: 210, indicators: [
        { name: 'TTM_SQUEEZE', calcParams: [14, 2.5, 1.25], visible: true, styles: { bars: [{ noChangeColor: '#abcdef', borderSize: 0 }] } },
      ] },
      { height: 180, indicators: [{ name: 'TTM_WAVE_A', calcParams: [5, 21, 34], visible: false, styles: { bars: [{ noChangeColor: '#123456', positiveColor: '#12ab34', negativeColor: '#ed1234', borderSize: 0 }, { positiveColor: '#34ab56', negativeColor: '#ed5678' }] } }] },
      { height: 190, indicators: [{ name: 'TTM_WAVE_B', calcParams: [5, 55, 89], visible: true, styles: null }] },
      { height: 200, indicators: [{ name: 'TTM_WAVE_C', calcParams: [5, 144, 233], visible: true, styles: null }] }],
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
  failAtomicPhase: 'blob' | 'ref' | null = null
  raceOnce: (() => Promise<void>) | null = null
  readonly atomicBatches: string[][] = []
  private head = 0
  private readonly snapshots = new Map<string, Map<string, StoredFile>>()
  private sequence = 0

  async getSnapshot(): Promise<GitHubSnapshot> {
    const commitSha = `commit-${this.head}`
    this.snapshots.set(commitSha, structuredClone(this.files))
    return { commitSha, treeSha: `tree-${this.head}` }
  }

  async getFile(path: string, options: { ref?: string } = {}): Promise<GitHubFile | null> {
    const file = (options.ref ? this.snapshots.get(options.ref)! : this.files).get(path)
    return file === undefined
      ? null
      : { path, sha: file.sha, bytes: new Uint8Array(file.bytes) }
  }

  async commitFiles(files: readonly { path: string; bytes: Uint8Array }[], _message: string, snapshot: GitHubSnapshot): Promise<void> {
    this.atomicBatches.push(files.map(file => file.path))
    if (this.failAtomicPhase === 'blob') throw new Error('Injected blob upload failure')
    if (this.conflictOnceFor) {
      const path = this.conflictOnceFor
      this.conflictOnceFor = null
      this.files.set(path, { sha: `raced-${++this.sequence}`, bytes: encoder.encode('remote-race') })
      this.head++
      throw new GitHubConflictError(path)
    }
    if (this.raceOnce) {
      const race = this.raceOnce
      this.raceOnce = null
      await race()
      this.head++
    }
    if (this.failAtomicPhase === 'ref' || snapshot.commitSha !== `commit-${this.head}`) throw new GitHubConflictError('manifest.json')
    for (const file of files) {
      this.putOrder.push(file.path)
      this.files.set(file.path, { sha: `sha-${++this.sequence}`, bytes: new Uint8Array(file.bytes) })
    }
    this.head++
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

async function seedLegacyMonth(remote: MemoryGitHubClient): Promise<void> {
  await service(new MemoryBackupService()).upload(client(remote), 'stop')
  const path = 'data/market-history/BTCUSDT/1m/2024/01.json.gz'
  const oldPath = path.replace('data/market-history', 'market-data')
  const chunk = JSON.parse(decoder.decode(await gunzip(remote.files.get(path)!.bytes)))
  chunk.markCandles = backup().data.markCandles
  const bytes = await gzip(encoder.encode(JSON.stringify(chunk)))
  remote.files.delete(path)
  remote.files.set(oldPath, { sha: 'legacy-chunk', bytes })
  const value = JSON.parse(decoder.decode(remote.files.get('manifest.json')!.bytes))
  const entry = value.files.find((item: { path: string }) => item.path === path)
  entry.path = oldPath
  entry.size = bytes.length
  entry.checksum = await sha256(bytes)
  remote.files.get('manifest.json')!.bytes = encoder.encode(JSON.stringify(value))
}

describe('GitHubSyncService', () => {
  it.each(['blob', 'ref'] as const)('leaves legacy migration and manifest readable after an atomic %s failure', async (phase) => {
    const remote = new MemoryGitHubClient()
    await seedLegacyMonth(remote)
    const before = new Map([...remote.files].map(([path, file]) => [path, { sha: file.sha, bytes: new Uint8Array(file.bytes) }]))
    remote.failAtomicPhase = phase
    await expect(service(new MemoryBackupService()).upload(client(remote), 'stop')).rejects.toThrow()
    expect([...remote.files.keys()]).toEqual([...before.keys()])
    for (const [path, file] of before) {
      expect(remote.files.get(path)?.sha).toBe(file.sha)
      expect(Array.from(remote.files.get(path)!.bytes)).toEqual(Array.from(file.bytes))
    }
    const target = new MemoryBackupService()
    await service(target).pull(client(remote))
    expect(target.imports[0].data.tradeCandles).toEqual(backup().data.tradeCandles)
    remote.failAtomicPhase = null
    await service(new MemoryBackupService()).upload(client(remote), 'stop')
    await service(target).pull(client(remote))
    expect(target.imports[1].data.tradeCandles).toEqual(backup().data.tradeCandles)
  })

  it.each(['keep-local', 'keep-remote', 'save-copy'] as const)('atomically resolves a race with %s while retaining newly added remote months', async (resolution) => {
    const remote = new MemoryGitHubClient()
    await service(new MemoryBackupService()).upload(client(remote), 'stop')
    remote.files.set('storage.json', { sha: 'registry', bytes: encoder.encode('other-project-registry') })
    remote.files.set('projects/other/data.json', { sha: 'other', bytes: encoder.encode('other-project-data') })
    const local = backup()
    local.data.preferences!.favoriteSymbols = ['ETHUSDT']
    const remoteBackup = backup()
    remoteBackup.data.tradeCandles = [candle(Date.UTC(2024, 1, 1))]
    const [extraMonth] = await service(new MemoryBackupService(remoteBackup)).prepare({ config: false, sessions: false, marketData: true })
    remote.raceOnce = async () => {
      const bytes = encoder.encode(JSON.stringify({ schemaVersion: 1, favoriteSymbols: ['SOLUSDT'] }))
      remote.files.set('config/favorites.json', { sha: 'concurrent-favorites', bytes })
      remote.files.set(extraMonth.path, { sha: 'concurrent-month', bytes: extraMonth.bytes })
      const value = JSON.parse(decoder.decode(remote.files.get('manifest.json')!.bytes))
      const entry = value.files.find((item: { path: string }) => item.path === 'config/favorites.json')
      entry.size = bytes.length
      entry.checksum = await sha256(bytes)
      value.files.push({ ...extraMonth, bytes: undefined, updatedAt: 2 })
      remote.files.set('manifest.json', { sha: 'concurrent-manifest', bytes: encoder.encode(JSON.stringify(value)) })
    }
    const result = await service(new MemoryBackupService(local)).upload(client(remote), resolution)
    const target = new MemoryBackupService()
    await service(target).pull(client(remote))
    expect(target.imports[0].data.preferences?.favoriteSymbols).toEqual(resolution === 'keep-local' ? ['ETHUSDT'] : ['SOLUSDT'])
    expect(target.imports[0].data.tradeCandles).toHaveLength(3)
    expect(result.skippedConflicts).toBe(resolution === 'keep-remote' ? 1 : 0)
    expect(result.copiedConflicts).toBe(resolution === 'save-copy' ? 1 : 0)
    const value = JSON.parse(decoder.decode(remote.files.get('manifest.json')!.bytes))
    if (resolution === 'save-copy') {
      const copy = [...remote.files.keys()].find(path => path.startsWith('config/favorites.local-'))!
      expect(JSON.parse(decoder.decode(remote.files.get(copy)!.bytes)).favoriteSymbols).toEqual(['ETHUSDT'])
      expect(value.files.some((entry: { path: string }) => entry.path === copy)).toBe(false)
    }
    expect(decoder.decode(remote.files.get('storage.json')!.bytes)).toBe('other-project-registry')
    expect(decoder.decode(remote.files.get('projects/other/data.json')!.bytes)).toBe('other-project-data')
  })

  it('stops after a second ref conflict without partially migrating legacy files', async () => {
    const remote = new MemoryGitHubClient()
    await seedLegacyMonth(remote)
    const before = [...remote.files].map(([path, file]) => ({ path, sha: file.sha, bytes: Array.from(file.bytes) }))
    remote.failAtomicPhase = 'ref'
    const batches = remote.atomicBatches.length
    await expect(service(new MemoryBackupService()).upload(client(remote), 'keep-local')).rejects.toBeInstanceOf(GitHubConflictError)
    expect(remote.atomicBatches.length - batches).toBe(2)
    expect([...remote.files].map(([path, file]) => ({ path, sha: file.sha, bytes: Array.from(file.bytes) }))).toEqual(before)
    await service(new MemoryBackupService()).pull(client(remote))
  })

  it('does not overwrite an existing timestamped conflict copy', async () => {
    const remote = new MemoryGitHubClient()
    await service(new MemoryBackupService()).upload(client(remote), 'stop')
    const path = 'config/favorites.local-123.json'
    remote.files.set(path, { sha: 'existing-copy', bytes: encoder.encode('keep-this-copy') })
    remote.conflictOnceFor = 'config/favorites.json'
    await expect(service(new MemoryBackupService(), () => 123).upload(client(remote), 'save-copy')).rejects.toBeInstanceOf(GitHubConflictError)
    expect(decoder.decode(remote.files.get(path)!.bytes)).toBe('keep-this-copy')
  })

  it('keeps fresh remote-only candle corrections while overlaying only actual local rows on retry', async () => {
    const remote = new MemoryGitHubClient()
    await service(new MemoryBackupService()).upload(client(remote), 'stop')
    const path = 'data/market-history/BTCUSDT/1m/2024/01.json.gz'
    const local = backup()
    local.data.tradeCandles = [candle(Date.UTC(2024, 0, 1), '105')]
    remote.raceOnce = async () => {
      const chunk = JSON.parse(decoder.decode(await gunzip(remote.files.get(path)!.bytes)))
      chunk.tradeCandles = [candle(Date.UTC(2024, 0, 1), '103'), candle(Date.UTC(2024, 0, 1, 0, 1), '102'), candle(Date.UTC(2024, 0, 1, 0, 2), '104')]
      const bytes = await gzip(encoder.encode(JSON.stringify(chunk)))
      remote.files.set(path, { sha: 'corrected-remote-month', bytes })
      const value = JSON.parse(decoder.decode(remote.files.get('manifest.json')!.bytes))
      const entry = value.files.find((entry: { path: string }) => entry.path === path)
      entry.size = bytes.length
      entry.checksum = await sha256(bytes)
      remote.files.set('manifest.json', { sha: 'corrected-remote-manifest', bytes: encoder.encode(JSON.stringify(value)) })
    }
    await service(new MemoryBackupService(local)).upload(client(remote), 'keep-local')
    const target = new MemoryBackupService()
    await service(target).pull(client(remote))
    expect(target.imports[0].data.tradeCandles?.map(candle => candle.close)).toEqual(['105', '102', '104'])
  })

  it.each([false, true])('keeps canonical values ahead of legacy values while overlaying local rows (retry=%s)', async (retry) => {
    const remote = new MemoryGitHubClient()
    await service(new MemoryBackupService()).upload(client(remote), 'stop')
    const path = 'data/market-history/BTCUSDT/1m/2024/01.json.gz'
    const oldPath = path.replace('data/market-history', 'market-data')
    const previous = remote.files.get(path)!
    remote.files.set(oldPath, previous)
    const value = JSON.parse(decoder.decode(remote.files.get('manifest.json')!.bytes))
    const entry = value.files.find((entry: { path: string }) => entry.path === path)
    value.files.push({ ...entry, path: oldPath })
    const chunk = JSON.parse(decoder.decode(await gunzip(previous.bytes)))
    chunk.tradeCandles[1].close = '102'
    const bytes = await gzip(encoder.encode(JSON.stringify(chunk)))
    remote.files.set(path, { sha: 'canonical-correction', bytes })
    entry.size = bytes.length
    entry.checksum = await sha256(bytes)
    remote.files.set('manifest.json', { sha: 'coexisting-manifest', bytes: encoder.encode(JSON.stringify(value)) })
    if (retry) remote.raceOnce = async () => {
      value.updatedAt++
      remote.files.set('manifest.json', { sha: 'raced-manifest', bytes: encoder.encode(JSON.stringify(value)) })
    }
    const local = backup()
    local.data.tradeCandles = [candle(Date.UTC(2024, 0, 1), '105')]
    await service(new MemoryBackupService(local)).upload(client(remote), retry ? 'keep-local' : 'stop')
    const target = new MemoryBackupService()
    await service(target).pull(client(remote))
    expect(target.imports[0].data.tradeCandles?.map(candle => candle.close)).toEqual(['105', '102'])
  })
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

  it('round-trips KC, TTM Squeeze and Wave ABC through config-only cloud sync, including empty, missing and invalid settings', async () => {
    const storage = () => {
      const values = new Map<string, string>()
      return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    }
    const sourceStorage = storage()
    const targetStorage = storage()
    const indicators = backup().data.preferences!.chartIndicators!
    sourceStorage.setItem(CHART_INDICATORS_PREFERENCE, JSON.stringify(indicators))
    const sourceBackups = new WorkstationBackupService(`kc-cloud-source-${crypto.randomUUID()}`, sourceStorage)
    const targetBackups = new WorkstationBackupService(`kc-cloud-target-${crypto.randomUUID()}`, targetStorage)
    const source = new GitHubSyncService(sourceBackups)
    const target = new GitHubSyncService(targetBackups)
    const remote = new MemoryGitHubClient()
    const selection = { config: true, sessions: false, marketData: false }
    await source.upload(client(remote), 'stop', selection)
    await target.pull(client(remote))
    expect((await targetBackups.exportPreferences()).data.preferences).toEqual((await sourceBackups.exportPreferences()).data.preferences)

    const pivotChanged = structuredClone(indicators)
    const pivotParams = pivotChanged.main.find(i => i.name === 'PIVOTS')!.calcParams
    pivotParams[33] = false
    pivotParams[35] = '#aabbcc'
    sourceStorage.setItem(CHART_INDICATORS_PREFERENCE, JSON.stringify(pivotChanged))
    await expect(source.compare(client(remote), selection)).resolves.toMatchObject({ changedFiles: 1 })
    await source.upload(client(remote), 'stop', selection)
    await target.pull(client(remote))
    expect(JSON.parse(targetStorage.getItem(CHART_INDICATORS_PREFERENCE)!)).toEqual(pivotChanged)

    const changed = structuredClone(indicators)
    changed.sub[1].indicators[0].calcParams = [3, 5, 8]
    changed.sub[1].indicators[0].styles = { bars: [{ positiveColor: '#123456', negativeColor: '#654321' }] }
    sourceStorage.setItem(CHART_INDICATORS_PREFERENCE, JSON.stringify(changed))
    await expect(source.compare(client(remote), selection)).resolves.toMatchObject({ changedFiles: 1 })
    await source.upload(client(remote), 'stop', selection)
    await target.pull(client(remote))
    expect(JSON.parse(targetStorage.getItem(CHART_INDICATORS_PREFERENCE)!)).toEqual(changed)

    const empty = { schemaVersion: 1, main: [], sub: [] }
    sourceStorage.setItem(CHART_INDICATORS_PREFERENCE, JSON.stringify(empty))
    await source.upload(client(remote), 'stop', selection)
    await target.pull(client(remote))
    expect(JSON.parse(targetStorage.getItem(CHART_INDICATORS_PREFERENCE)!)).toEqual(empty)

    const remotePreferences = JSON.parse(decoder.decode(remote.files.get('config/preferences.json')!.bytes))
    const rewrite = async (value: unknown) => {
      const file = remote.files.get('config/preferences.json')!
      file.bytes = encoder.encode(JSON.stringify(value))
      const manifestFile = remote.files.get('manifest.json')!
      const manifest = JSON.parse(decoder.decode(manifestFile.bytes))
      const entry = manifest.files.find((entry: { path: string }) => entry.path === 'config/preferences.json')
      entry.size = file.bytes.length
      entry.checksum = await sha256(file.bytes)
      manifestFile.bytes = encoder.encode(JSON.stringify(manifest))
    }
    delete remotePreferences.chartIndicators
    await rewrite(remotePreferences)
    targetStorage.setItem(CHART_INDICATORS_PREFERENCE, JSON.stringify(indicators))
    await target.pull(client(remote))
    expect(JSON.parse(targetStorage.getItem(CHART_INDICATORS_PREFERENCE)!)).toEqual(indicators)
    const legacyDefaults = structuredClone(indicators)
    legacyDefaults.main.find(i => i.name === 'PIVOTS')!.calcParams = PIVOTS_DEFAULT_PARAMS.slice(0, 30)
    legacyDefaults.sub[1].indicators[0].styles = { bars: [{ positiveColor: '#26a69a', negativeColor: '#ef5350', borderSize: 0 }] }
    await rewrite({ ...remotePreferences, chartIndicators: legacyDefaults })
    await target.pull(client(remote))
    expect(JSON.parse(targetStorage.getItem(CHART_INDICATORS_PREFERENCE)!).sub[1].indicators[0].styles)
      .toEqual({ bars: [{ positiveColor: '#168c72', negativeColor: '#d93654', borderSize: 0 }] })
    expect(JSON.parse(targetStorage.getItem(CHART_INDICATORS_PREFERENCE)!).main.find((i: { name: string }) => i.name === 'PIVOTS').calcParams.slice(30))
      .toEqual(['#fb8c00', '#ef5350', '#26a69a', true, '#445566', '#aa7777', '#77aa77'])
    const before = (await targetBackups.exportAll()).data
    for (const [index, value] of [[33, 'true'], [35, null]] as const) {
      const invalidPivot = structuredClone(indicators)
      invalidPivot.main.find(i => i.name === 'PIVOTS')!.calcParams[index] = value
      await rewrite({ ...remotePreferences, binanceRestBaseUrl: 'https://changed.test', chartIndicators: invalidPivot })
      await expect(target.pull(client(remote))).rejects.toThrow(/PIVOTS/)
      expect((await targetBackups.exportAll()).data).toEqual(before)
    }
    const invalid = structuredClone(indicators)
    invalid.sub[0].indicators[0].calcParams = [20, 0, 1.5]
    await rewrite({ ...remotePreferences, binanceRestBaseUrl: 'https://changed.test', chartIndicators: invalid })
    await expect(target.pull(client(remote))).rejects.toThrow(/calcParams/)
    expect((await targetBackups.exportAll()).data).toEqual(before)
    for (const name of ['TTM_WAVE_A', 'TTM_WAVE_B', 'TTM_WAVE_C']) {
      const invalidWave = structuredClone(indicators)
      invalidWave.sub.find(pane => pane.indicators[0].name === name)!.indicators[0].calcParams = [8, 55, 34]
      await rewrite({ ...remotePreferences, binanceRestBaseUrl: 'https://changed.test', chartIndicators: invalidWave })
      await expect(target.pull(client(remote))).rejects.toThrow(/calcParams/)
      expect((await targetBackups.exportAll()).data).toEqual(before)
      invalidWave.sub.find(pane => pane.indicators[0].name === name)!.indicators[0] = {
        name, calcParams: [8, 34, 55], visible: true, styles: { bars: [{ negativeColor: false }] },
      }
      await rewrite({ ...remotePreferences, binanceRestBaseUrl: 'https://changed.test', chartIndicators: invalidWave })
      await expect(target.pull(client(remote))).rejects.toThrow(/negativeColor/)
      expect((await targetBackups.exportAll()).data).toEqual(before)
    }
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
    expect(chunk).not.toHaveProperty('markCandles')
    const preferences = files.find(
      (file) => file.path === 'config/preferences.json',
    )!
    expect(JSON.parse(decoder.decode(preferences.bytes))).toMatchObject({
      chartIndicators: backup().data.preferences?.chartIndicators,
      selectedSymbol: backup().data.preferences?.selectedSymbol,
      pinnedPeriods: backup().data.preferences?.pinnedPeriods,
    })
  })

  it('uploads business files with the manifest in one atomic commit and compares selections', async () => {
    const remote = new MemoryGitHubClient()
    const sync = service(new MemoryBackupService())

    await expect(
      sync.upload(client(remote), 'stop', ALL_SYNC_SELECTION),
    ).resolves.toMatchObject({ files: 3, copiedConflicts: 0 })
    expect(remote.putOrder.at(-1)).toBe('manifest.json')
    expect(remote.atomicBatches).toHaveLength(1)
    expect(remote.atomicBatches[0]).toEqual(expect.arrayContaining(['config/preferences.json', 'manifest.json', 'data/market-history/BTCUSDT/1m/2024/01.json.gz']))
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

  it('keeps more complete remote dates and omits mark prices during manual partial uploads', async () => {
    const remote = new MemoryGitHubClient()
    const full = backup()
    full.data.tradeCandles!.push(candle(Date.UTC(2024, 0, 1, 0, 2)))
    full.data.markCandles!.push(candle(Date.UTC(2024, 0, 1, 0, 1), '99'))
    await service(new MemoryBackupService(full)).upload(client(remote), 'stop')
    await service(new MemoryBackupService()).upload(client(remote), 'stop')
    const target = new MemoryBackupService()
    await service(target).pull(client(remote))
    expect(target.imports[0].data.tradeCandles).toEqual(full.data.tradeCandles)
    expect(target.imports[0].data).not.toHaveProperty('markCandles')
    const stored = JSON.parse(decoder.decode(await gunzip(remote.files.get('data/market-history/BTCUSDT/1m/2024/01.json.gz')!.bytes)))
    expect(stored).not.toHaveProperty('markCandles')
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

  it('validates old mark data on pull but rewrites touched legacy cloud files without it on upload', async () => {
    const remote = new MemoryGitHubClient()
    const sync = service(new MemoryBackupService())
    await sync.upload(client(remote), 'stop')
    const name = 'data/market-history/BTCUSDT/1m/2024/01.json.gz'
    const old = name.replace('data/market-history', 'market-data')
    const chunk = JSON.parse(decoder.decode(await gunzip(remote.files.get(name)!.bytes)))
    chunk.markCandles = backup().data.markCandles
    const bytes = await gzip(encoder.encode(JSON.stringify(chunk)))
    remote.files.delete(name)
    remote.files.set(old, { sha: 'legacy-chunk', bytes })
    const value = JSON.parse(decoder.decode(remote.files.get('manifest.json')!.bytes))
    const entry = value.files.find((item: { path: string }) => item.path === name)
    entry.path = old; entry.size = bytes.length; entry.checksum = await sha256(bytes)
    remote.files.get('manifest.json')!.bytes = encoder.encode(JSON.stringify(value))
    const target = new MemoryBackupService()
    await service(target).pull(client(remote))
    expect(target.imports[0].data).not.toHaveProperty('markCandles')
    chunk.markCandles[0].high = '1'
    const invalid = await gzip(encoder.encode(JSON.stringify(chunk)))
    remote.files.set(old, { sha: 'bad-legacy-chunk', bytes: invalid })
    entry.size = invalid.length; entry.checksum = await sha256(invalid)
    remote.files.get('manifest.json')!.bytes = encoder.encode(JSON.stringify(value))
    const rejected = new MemoryBackupService()
    await expect(service(rejected).pull(client(remote))).rejects.toThrow()
    expect(rejected.imports).toHaveLength(0)
    remote.files.set(old, { sha: 'legacy-chunk', bytes })
    entry.size = bytes.length; entry.checksum = await sha256(bytes)
    remote.files.get('manifest.json')!.bytes = encoder.encode(JSON.stringify(value))
    await sync.upload(client(remote), 'stop')
    expect(JSON.parse(decoder.decode(await gunzip(remote.files.get(old)!.bytes)))).not.toHaveProperty('markCandles')
    expect(JSON.parse(decoder.decode(await gunzip(remote.files.get(name)!.bytes)))).not.toHaveProperty('markCandles')
  })

  it('stops rather than silently replacing a concurrently changed manifest', async () => {
    const remote = new MemoryGitHubClient()
    await service(new MemoryBackupService()).upload(client(remote), 'stop')
    remote.raceOnce = async () => {
      const file = remote.files.get('manifest.json')!
      const value = JSON.parse(decoder.decode(file.bytes))
      value.updatedAt++
      remote.files.set('manifest.json', { bytes: encoder.encode(JSON.stringify(value)), sha: 'concurrent-manifest' })
    }
    await expect(service(new MemoryBackupService()).upload(client(remote), 'stop')).rejects.toBeInstanceOf(GitHubConflictError)
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
    expect(target.imports[0].data).not.toHaveProperty('markCandles')
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
