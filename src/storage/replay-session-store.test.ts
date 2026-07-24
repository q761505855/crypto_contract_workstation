import { describe, expect, it } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import type { ReplaySession } from '../replay/models'
import { DATABASE_VERSION } from './market-data-store'
import { IndexedDbMarketDataStore } from './market-data-store'
import { IndexedDbReplaySessionStore } from './replay-session-store'

function session(
  id: string,
  updatedAt: number,
  active: boolean,
): ReplaySession {
  return {
    schemaVersion: 2,
    id,
    symbol: DEFAULT_SYMBOL,
    period: SUPPORTED_PERIODS[0],
    startTime: 0,
    endTime: 60_000,
    currentTime: 0,
    currentIndex: 0,
    candleCount: 2,
    speed: 1,
    status: 'paused',
    hasTrades: false,
    active,
    tradingConfig: {
      initialBalance: '10000',
      leverage: 10,
      feeRate: '0.0005',
      slippageRate: '0.0002',
      maintenanceMarginRate: '0.004',
      liquidationFeeRate: '0.005',
    },
    createdAt: 0,
    updatedAt,
  }
}

describe('IndexedDbReplaySessionStore', () => {
  it('uses schema version 3 and returns newest sessions first', async () => {
    expect(DATABASE_VERSION).toBe(3)
    const store = new IndexedDbReplaySessionStore(
      `replay-test-${crypto.randomUUID()}`,
    )
    await store.put(session('older', 1, true))
    await store.put(session('newer', 2, false))

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ id: 'newer' }),
      expect.objectContaining({ id: 'older' }),
    ])
    await expect(store.getLatestActive()).resolves.toEqual(
      expect.objectContaining({ id: 'older' }),
    )
  })

  it('migrates a Phase 2 database without deleting cached candles', async () => {
    const databaseName = `migration-test-${crypto.randomUUID()}`
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => {
        const database = request.result
        database.createObjectStore('symbols', { keyPath: 'symbol' })
        const trade = database.createObjectStore('tradeCandles', {
          keyPath: ['symbol', 'timeframe', 'openTime'],
        })
        trade.createIndex('by-series-time', [
          'symbol',
          'timeframe',
          'openTime',
        ])
        const mark = database.createObjectStore('markCandles', {
          keyPath: ['symbol', 'timeframe', 'openTime'],
        })
        mark.createIndex('by-series-time', [
          'symbol',
          'timeframe',
          'openTime',
        ])
        trade.put({
          symbol: 'BTCUSDT',
          timeframe: '1m',
          openTime: 0,
          closeTime: 59_999,
          open: '1',
          high: '2',
          low: '0.5',
          close: '1.5',
          volume: '10',
          quoteVolume: '15',
          tradeCount: 2,
          isClosed: true,
          source: 'binance',
        })
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
    })

    const replayStore = new IndexedDbReplaySessionStore(databaseName)
    await replayStore.put(session('migrated', 1, true))
    const marketStore = new IndexedDbMarketDataStore(databaseName)

    await expect(replayStore.get('migrated')).resolves.toBeDefined()
    await expect(
      marketStore.getCandles('trade', 'BTCUSDT', '1m', 0, 0),
    ).resolves.toHaveLength(1)
  })
})
