import { describe, expect, it } from 'vitest'
import type { MarketCandle } from '../market-data/models'
import { GitHubConflictError, GitHubContentsClient, type GitHubSnapshot } from './github-client'
import { GitHubHistoryStore } from './history-store'
import { gunzip, gzip, sha256, type SyncManifest } from './sync-service'

const encoder = new TextEncoder()
const path = 'data/market-history/BTCUSDT/1m/2024/01.json.gz'
const start = Date.UTC(2024, 0, 1)
function candle(minute: number): MarketCandle {
  return { symbol: 'BTCUSDT', timeframe: '1m', openTime: start + minute * 60_000, closeTime: start + minute * 60_000 + 59_999, open: '100', high: '110', low: '90', close: '100', volume: '1', quoteVolume: '100', tradeCount: 1, isClosed: true, source: 'binance' }
}
class Remote {
  files = new Map<string, Uint8Array>()
  commits = 0
  race = false
  reads: { path: string; ref?: string }[] = []
  canWrite() { return true }
  async getSnapshot(): Promise<GitHubSnapshot> { return { commitSha: 'parent', treeSha: 'tree' } }
  async getFile(path: string, options?: { ref?: string; signal?: AbortSignal }) {
    options?.signal?.throwIfAborted()
    this.reads.push({ path, ref: options?.ref })
    const bytes = this.files.get(path)
    return bytes ? { path, sha: 'sha', bytes } : null
  }
  async commitFiles(files: { path: string; bytes: Uint8Array }[], _message: string, snapshot: GitHubSnapshot) {
    expect(snapshot.commitSha).toBe('parent')
    if (this.race) throw new GitHubConflictError('manifest.json')
    this.commits++
    for (const file of files) this.files.set(file.path, file.bytes)
  }
  client() { return this as unknown as GitHubContentsClient }
}
async function manifest(remote: Remote): Promise<SyncManifest> { return JSON.parse(new TextDecoder().decode(remote.files.get('manifest.json'))) }
async function seed(remote: Remote, legacy = false) {
  const name = legacy ? path.replace('data/market-history', 'market-data') : path
  const bytes = await gzip(encoder.encode(JSON.stringify({ fileType: 'crypto-contract-workstation-market-chunk', schemaVersion: 1, symbol: 'BTCUSDT', timeframe: '1m', year: 2024, month: 1, tradeCandles: [candle(0), candle(1)], markCandles: [candle(0)] })))
  remote.files.set(name, bytes)
  remote.files.set('manifest.json', encoder.encode(JSON.stringify({ fileType: 'crypto-contract-workstation-manifest', schemaVersion: 1, updatedAt: 1, files: [ { path: name, category: 'market-data', size: bytes.length, checksum: await sha256(bytes), updatedAt: 1 }, { path: 'config/favorites.json', category: 'config', size: 2, checksum: await sha256(encoder.encode('[]')), updatedAt: 1 } ] })))
}

describe('GitHubHistoryStore', () => {
  it('reads only the requested month from an immutable snapshot and supports legacy paths', async () => {
    const remote = new Remote()
    await seed(remote, true)
    const result = await new GitHubHistoryStore(remote.client()).loadMonth('BTCUSDT', 2024, 1)
    expect(result?.tradeCandles).toEqual([candle(0), candle(1)])
    expect(remote.reads).toEqual([{ path: 'manifest.json', ref: 'parent' }, { path: path.replace('data/market-history', 'market-data'), ref: 'parent' }])
  })
  it('merges partial dates and price kinds, preserves unrelated entries, and skips unchanged content', async () => {
    const remote = new Remote(); await seed(remote)
    const store = new GitHubHistoryStore(remote.client())
    await store.saveMonth('BTCUSDT', 2024, 1, [candle(2)], [])
    expect((await store.loadMonth('BTCUSDT', 2024, 1))?.tradeCandles).toEqual([candle(0), candle(1), candle(2)])
    expect((await store.loadMonth('BTCUSDT', 2024, 1))?.markCandles).toEqual([candle(0)])
    expect((await manifest(remote)).files.map(entry => entry.path)).toContain('config/favorites.json')
    await store.saveMonth('BTCUSDT', 2024, 1, [candle(2)], [])
    expect(remote.commits).toBe(1)
  })
  it('rejects checksum corruption, invalid candles, and cancellation without writes', async () => {
    const remote = new Remote(); await seed(remote)
    const store = new GitHubHistoryStore(remote.client())
    remote.files.set(path, new Uint8Array([1, 2]))
    await expect(store.loadMonth('BTCUSDT', 2024, 1)).rejects.toThrow(/校验/)
    await expect(store.saveMonth('BTCUSDT', 2024, 1, [{ ...candle(0), high: '1' }], [])).rejects.toThrow()
    const abort = new AbortController(); abort.abort()
    await expect(store.loadMonth('BTCUSDT', 2024, 1, { signal: abort.signal })).rejects.toThrow()
    expect(remote.commits).toBe(0)
  })
  it('rejects structurally valid chunks with bad minute semantics before returning', async () => {
    const remote = new Remote(); await seed(remote)
    const chunk = JSON.parse(new TextDecoder().decode(await gunzip(remote.files.get(path)!)))
    chunk.tradeCandles[0].openTime++
    const bytes = await gzip(encoder.encode(JSON.stringify(chunk)))
    const value = await manifest(remote); value.files[0].size = bytes.length; value.files[0].checksum = await sha256(bytes)
    remote.files.set(path, bytes); remote.files.set('manifest.json', encoder.encode(JSON.stringify(value)))
    await expect(new GitHubHistoryStore(remote.client()).loadMonth('BTCUSDT', 2024, 1)).rejects.toThrow()
  })
  it('does not change either month or manifest when another commit races', async () => {
    const remote = new Remote(); await seed(remote); remote.race = true
    const before = new Map(remote.files)
    await expect(new GitHubHistoryStore(remote.client()).saveMonth('BTCUSDT', 2024, 1, [candle(2)], [])).rejects.toBeInstanceOf(GitHubConflictError)
    expect(remote.files).toEqual(before)
  })
})
