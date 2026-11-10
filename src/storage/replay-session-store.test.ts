import { describe, expect, it } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import type { ReplaySession } from '../replay/models'
import { SimulationEngine } from '../simulation/simulation-engine'
import { DATABASE_VERSION, IndexedDbMarketDataStore, openWorkstationDatabase } from './market-data-store'
import { IndexedDbReplaySessionStore } from './replay-session-store'
import { IndexedDbSimulationStateStore } from './simulation-state-store'

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
  it('deletes only the selected session and prevents late autosaves from restoring it', async () => {
    const name = `replay-delete-${crypto.randomUUID()}`
    const replay = new IndexedDbReplaySessionStore(name)
    const simulations = new IndexedDbSimulationStateStore(name)
    const database = await openWorkstationDatabase(name)
    const candle = {
      symbol: 'BTCUSDT', timeframe: '1m', openTime: 0, closeTime: 59_999,
      open: '100', high: '100', low: '100', close: '100', volume: '1',
      quoteVolume: '100', tradeCount: 1, isClosed: true, source: 'binance' as const,
    }
    const removed = session('removed', 1, false)
    const kept = session('kept', 2, false)
    for (const saved of [removed, kept]) {
      await replay.put(saved)
      const engine = SimulationEngine.create(saved)
      engine.open('long', { quantity: '1' }, candle)
      await simulations.save(engine.snapshot())
    }
    await database.put('tradeCandles', candle)
    const removedState = (await simulations.load(removed.id))!
    const keptState = await simulations.load(kept.id)

    const [concurrentState] = await Promise.all([
      simulations.load(removed.id),
      replay.delete(removed.id),
    ])
    expect(concurrentState).toEqual(removedState)
    await replay.delete(removed.id)
    await Promise.all([
      replay.update({ ...removed, active: true }),
      simulations.save(removedState),
    ])

    await expect(replay.list()).resolves.toEqual([kept])
    await expect(replay.getLatestActive()).resolves.toBeUndefined()
    await expect(simulations.load(removed.id)).resolves.toBeUndefined()
    await expect(simulations.load(kept.id)).resolves.toEqual(keptState)
    await expect(database.getAll('simulationTrades')).resolves.toEqual([
      expect.objectContaining({ sessionId: kept.id }),
    ])
    await expect(database.getAll('simulationLedger')).resolves.toEqual(
      keptState!.ledger.map(() => expect.objectContaining({ sessionId: kept.id })),
    )
    await expect(database.getAll('tradeCandles')).resolves.toEqual([candle])
  })

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
