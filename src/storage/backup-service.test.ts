import { describe, expect, it } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import {
  CHART_INDICATORS_PREFERENCE,
  type ChartIndicatorPreferences,
} from '../chart/indicator-preferences'
import type { MarketCandle, MarketSymbol } from '../market-data/models'
import type { ReplaySession } from '../replay/models'
import { SimulationEngine } from '../simulation/simulation-engine'
import { IndexedDbMarketDataStore } from './market-data-store'
import { IndexedDbReplaySessionStore } from './replay-session-store'
import { IndexedDbSimulationStateStore } from './simulation-state-store'
import {
  BACKUP_FILE_TYPE,
  WorkstationBackupService,
  validateBackupEnvelope,
} from './backup-service'

class MemoryPreferences implements Pick<Storage, 'getItem' | 'setItem'> {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

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

function candle(close = '100'): MarketCandle {
  return {
    symbol: 'BTCUSDT',
    timeframe: '1m',
    openTime: 0,
    closeTime: 59_999,
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

function session(): ReplaySession {
  return {
    schemaVersion: 2,
    id: 'backup-session',
    symbol: DEFAULT_SYMBOL,
    period: SUPPORTED_PERIODS[0],
    startTime: 0,
    endTime: 60_000,
    currentTime: 0,
    currentIndex: 0,
    candleCount: 2,
    speed: 1,
    status: 'paused',
    hasTrades: true,
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

async function seed(databaseName: string, preferences: MemoryPreferences) {
  preferences.setItem('marketData.binanceBaseUrl', 'https://example.test')
  preferences.setItem(
    'marketData.favoriteSymbols',
    JSON.stringify(['BTCUSDT']),
  )
  preferences.setItem(
    CHART_INDICATORS_PREFERENCE,
    JSON.stringify(indicatorPreferences()),
  )
  const market = new IndexedDbMarketDataStore(databaseName)
  await market.putSymbols([symbol()])
  await market.putCandles('trade', [candle()])
  await market.putCandles('mark', [candle('99')])
  const replay = new IndexedDbReplaySessionStore(databaseName)
  await replay.put(session())
  const simulation = new IndexedDbSimulationStateStore(databaseName)
  const engine = SimulationEngine.create(session())
  engine.open('long', { quantity: '1' }, candle())
  await simulation.save(engine.snapshot())
}

function indicatorPreferences(): ChartIndicatorPreferences {
  return {
    schemaVersion: 1,
    main: [
      {
        name: 'MA',
        calcParams: [7, 25, 99],
        visible: true,
        styles: { lines: [{ color: '#f00' }] },
      },
    ],
    sub: [
      {
        height: 160,
        indicators: [
          {
            name: 'RSI',
            calcParams: [6, 12, 24],
            visible: true,
            styles: null,
          },
        ],
      },
    ],
  }
}

describe('WorkstationBackupService', () => {
  it('round-trips all local data into a different browser database', async () => {
    const sourceName = `backup-source-${crypto.randomUUID()}`
    const targetName = `backup-target-${crypto.randomUUID()}`
    const sourcePreferences = new MemoryPreferences()
    const targetPreferences = new MemoryPreferences()
    await seed(sourceName, sourcePreferences)
    const source = new WorkstationBackupService(
      sourceName,
      sourcePreferences,
      () => 123,
    )
    const target = new WorkstationBackupService(
      targetName,
      targetPreferences,
      () => 456,
    )

    const exported = await source.exportAll()
    expect(exported).toMatchObject({
      fileType: BACKUP_FILE_TYPE,
      schemaVersion: 1,
      kind: 'all',
      exportedAt: 123,
    })
    await expect(target.import(exported)).resolves.toMatchObject({
      tradeCandles: 1,
      markCandles: 1,
      sessions: 1,
      simulations: 1,
      preferences: true,
    })
    const restored = await target.exportAll()
    expect(restored.data).toEqual(exported.data)
    expect(
      targetPreferences.getItem('marketData.binanceBaseUrl'),
    ).toBe('https://example.test')
    expect(
      JSON.parse(
        targetPreferences.getItem(CHART_INDICATORS_PREFERENCE) ?? 'null',
      ),
    ).toEqual(indicatorPreferences())
  })

  it('exports one market series and one complete session independently', async () => {
    const databaseName = `backup-scopes-${crypto.randomUUID()}`
    const preferences = new MemoryPreferences()
    await seed(databaseName, preferences)
    const service = new WorkstationBackupService(databaseName, preferences)

    await expect(
      service.exportMarketData('BTCUSDT', '1m'),
    ).resolves.toMatchObject({
      kind: 'market-data',
      data: { tradeCandles: [{ timeframe: '1m' }] },
    })
    await expect(service.exportSession('backup-session')).resolves.toMatchObject(
      {
        kind: 'session',
        data: {
          sessions: [{ id: 'backup-session' }],
          simulations: [{ sessionId: 'backup-session' }],
        },
      },
    )
  })

  it('rejects malformed and duplicate data before touching IndexedDB', async () => {
    const databaseName = `backup-invalid-${crypto.randomUUID()}`
    const preferences = new MemoryPreferences()
    const market = new IndexedDbMarketDataStore(databaseName)
    await market.putCandles('trade', [candle()])
    const service = new WorkstationBackupService(databaseName, preferences)
    const invalid = {
      fileType: BACKUP_FILE_TYPE,
      schemaVersion: 1,
      kind: 'market-data',
      exportedAt: 1,
      data: {
        symbols: [symbol()],
        tradeCandles: [
          { ...candle(), high: '80' },
          { ...candle(), high: '80' },
        ],
        markCandles: [],
      },
    }

    expect(() => validateBackupEnvelope(invalid)).toThrow()
    await expect(service.import(invalid)).rejects.toThrow()
    await expect(
      market.getCandles('trade', 'BTCUSDT', '1m', 0, 0),
    ).resolves.toEqual([candle()])
  })
})
