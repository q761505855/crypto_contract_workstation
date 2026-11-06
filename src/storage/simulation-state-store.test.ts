import { describe, expect, it } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import type { MarketCandle } from '../market-data/models'
import type { ReplaySession } from '../replay/models'
import { SimulationEngine } from '../simulation/simulation-engine'
import { IndexedDbSimulationStateStore } from './simulation-state-store'
import { openWorkstationDatabase } from './market-data-store'

function replaySession(): ReplaySession {
  return {
    schemaVersion: 2,
    id: 'simulation-session',
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
    active: true,
    tradingConfig: {
      initialBalance: '10000',
      leverage: 10,
      feeRate: '0',
      slippageRate: '0',
      maintenanceMarginRate: '0.004',
      liquidationFeeRate: '0.005',
    },
    createdAt: 0,
    updatedAt: 0,
  }
}

function candle(): MarketCandle {
  return {
    symbol: 'BTCUSDT',
    timeframe: '1m',
    openTime: 0,
    closeTime: 59_999,
    open: '100',
    high: '100',
    low: '100',
    close: '100',
    volume: '1',
    quoteVolume: '100',
    tradeCount: 1,
    isClosed: true,
    source: 'binance',
  }
}

describe('IndexedDbSimulationStateStore', () => {
  it('restores old single-position rows and keeps explicit empty hedged rows empty', async () => {
    const name = `legacy-position-${crypto.randomUUID()}`
    const store = new IndexedDbSimulationStateStore(name)
    const engine = SimulationEngine.create(replaySession())
    engine.open('short', { quantity: '1' }, candle())
    engine.setStopLoss('short', '110', 0)
    const { positions, ...fields } = engine.snapshot()
    const database = await openWorkstationDatabase(name)
    await database.put('simulationStates', { ...fields, schemaVersion: 1, position: positions[0] })
    const restored = await store.load(fields.sessionId)
    expect(restored).toMatchObject({ schemaVersion: 2, positions: [{ side: 'short', stopLossPrice: '110' }] })
    expect(restored).not.toHaveProperty('position')
    await store.save({ ...engine.snapshot(), positions: [] })
    expect((await store.load(fields.sessionId))?.positions).toEqual([])
  })

  it('persists account state, position, trades, and ledger separately', async () => {
    const store = new IndexedDbSimulationStateStore(
      `simulation-test-${crypto.randomUUID()}`,
    )
    const engine = SimulationEngine.create(replaySession())
    engine.open('long', { quantity: '1' }, candle())
    const state = engine.snapshot()

    await store.save(state)
    await expect(store.load(state.sessionId)).resolves.toEqual(state)
  })

  it('replaces stale trades and ledger entries during autosave', async () => {
    const store = new IndexedDbSimulationStateStore(
      `simulation-test-${crypto.randomUUID()}`,
    )
    const engine = SimulationEngine.create(replaySession())
    engine.open('long', { quantity: '1' }, candle())
    const original = engine.snapshot()
    await store.save(original)

    const replacement = {
      ...original,
      trades: [],
      ledger: original.ledger.slice(0, 1),
    }
    await store.save(replacement)
    await expect(store.load(original.sessionId)).resolves.toEqual(
      replacement,
    )
  })
})
