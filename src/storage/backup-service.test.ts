import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_OKX_SYMBOL, DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import { DrawingStore } from '../chart/drawings'
import { CHART_WINDOW_SIZE_KEY, DEFAULT_CHART_WINDOW_SIZE, saveChartWindowSize } from '../chart/chart-window-preferences'
import { DEFAULT_PINNED_PERIODS, PINNED_PERIODS_KEY } from '../chart/period-preferences'
import { PIVOTS_DEFAULT_PARAMS } from '../chart/pivots'
import {
  CHART_INDICATORS_PREFERENCE,
  type ChartIndicatorPreferences,
  type JsonValue,
} from '../chart/indicator-preferences'
import type { MarketCandle, MarketSymbol } from '../market-data/models'
import { OKX_SYMBOL_STORAGE_KEY, SELECTED_SYMBOL_STORAGE_KEY } from '../market-data/symbol-preferences'
import { PRICE_SOURCE_KEY, readPriceSource } from '../market-data/price-source-preferences'
import type { ReplaySession } from '../replay/models'
import { SimulationEngine } from '../simulation/simulation-engine'
import { OKX_SIMULATION_TAKER_FEE, type OkxTradingTerms } from '../simulation/okx-trading'
import { IndexedDbMarketDataStore, openWorkstationDatabase } from './market-data-store'
import { IndexedDbReplaySessionStore } from './replay-session-store'
import { IndexedDbSimulationStateStore } from './simulation-state-store'
import { CTRADER_DATABASE_NAME } from './ctrader-storage'
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

it('restores drawings from a complete backup and preserves them when an old backup omits the field', async () => {
  const drawing = { id: 'drawing-line', scope: 'live:BTCUSDT', name: 'horizontalStraightLine',
    points: [{ timestamp: 120_000, value: 123 }], locked: true, styles: { line: { color: '#ffee33', size: 3 } } }
  const sourceStorage = new MemoryPreferences()
  const sourceDrawings = new DrawingStore(sourceStorage)
  await sourceDrawings.save(drawing)
  const source = new WorkstationBackupService(`drawings-source-${crypto.randomUUID()}`, sourceStorage, Date.now, sourceDrawings)
  const backup = await source.exportAll()
  expect(backup.data.drawings).toEqual([drawing])
  expect((await source.exportPreferences()).data.drawings).toBeUndefined()

  const targetStorage = new MemoryPreferences()
  const targetDrawings = new DrawingStore(targetStorage)
  const target = new WorkstationBackupService(`drawings-target-${crypto.randomUUID()}`, targetStorage, Date.now, targetDrawings)
  await target.import(backup)
  expect(targetDrawings.forScope(drawing.scope)).toEqual([drawing])
  delete backup.data.drawings
  await target.import(backup)
  expect(targetDrawings.forScope(drawing.scope)).toEqual([drawing])
  const invalid = { ...backup, data: { ...backup.data, drawings: null } }
  await expect(target.import(invalid)).rejects.toThrow('绘图存档格式无效')
  await expect(target.import({ ...backup, data: { ...backup.data, drawings: [{ ...drawing, locked: null }] } }))
    .rejects.toThrow('绘图存档格式无效')
  expect(targetDrawings.forScope(drawing.scope)).toEqual([drawing])
  await target.import({ ...backup, data: { ...backup.data, drawings: [] } })
  expect(targetDrawings.forScope(drawing.scope)).toEqual([])
})

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

it('round-trips OKX preferences and a simulated perpetual session, including funding and mark-price liquidation', async () => {
  const terms: OkxTradingTerms = {
    accountCurrency: 'USDT', contractValue: '0.01', contractStep: '0.1', minContracts: '0.1',
    tickSize: '0.5', maxOrderContracts: '100', maxLeverage: 50,
    tiers: [{ maxContracts: '100', maxLeverage: 50, maintenanceMarginRate: '0.004' },
      { maxContracts: '1000', maxLeverage: 25.5, maintenanceMarginRate: '0.005' }],
  }
  const saved: ReplaySession = {
    ...session(), symbol: DEFAULT_OKX_SYMBOL, marketSource: 'okx', cursorTimeframe: '1m',
    visibleUntil: 60_000, endTime: 179_999,
    tradingConfig: { ...session().tradingConfig, okx: terms, feeRate: OKX_SIMULATION_TAKER_FEE, liquidationFeeRate: OKX_SIMULATION_TAKER_FEE },
  }
  const engine = SimulationEngine.create(saved)
  const first: MarketCandle = { ...candle('101'), symbol: DEFAULT_OKX_SYMBOL.ticker, source: 'okx' }
  const tiered = SimulationEngine.create(saved)
  tiered.open('short', { lots: '70' }, first)
  tiered.open('short', { lots: '70' }, first)
  expect(tiered.snapshot().positions[0].maintenanceMarginRate).toBe('0.005')
  expect(() => tiered.setLeverage(26)).toThrow(/持仓档位/)
  expect(() => engine.open('long', { lots: '1.05' }, first)).toThrow(/步长/)
  expect(engine.open('long', { lots: '1' }, first)).toMatchObject({ quantity: '0.01', fee: '0.000505' })
  const second = { ...first, openTime: 60_000, closeTime: 119_999 }
  const risk = { mark: { ...second, low: '99' }, funding: [{ timestamp: 60_000, rate: '0.001', price: '100' }] }
  expect(engine.processCandle(second, false, risk).exitAction).toBeNull()
  engine.processCandle(second, false, risk)
  expect(engine.snapshot().ledger.filter(row => row.type === 'funding')).toMatchObject([{ timestamp: 60_000, amount: '-0.001' }])
  const beforeLiquidation = engine.snapshot()
  const restored = SimulationEngine.restore(beforeLiquidation, saved)
  const third = { ...second, openTime: 120_000, closeTime: 179_999, low: '100' }
  expect(restored.processCandle(third, false, { mark: { ...third, low: '80' }, funding: [] }).exitAction).toBe('liquidation')

  const storage = new MemoryPreferences()
  expect(readPriceSource(storage)).toBe('ctrader')
  storage.setItem(PRICE_SOURCE_KEY, '"invalid"')
  expect(readPriceSource(storage)).toBe('ctrader')
  storage.setItem(PRICE_SOURCE_KEY, '"okx"')
  storage.setItem(OKX_SYMBOL_STORAGE_KEY, JSON.stringify(DEFAULT_OKX_SYMBOL))
  const sourceName = `okx-source-${crypto.randomUUID()}`
  await new IndexedDbReplaySessionStore(sourceName).put({ ...saved, currentTime: 60_000, visibleUntil: 120_000, currentIndex: 1 })
  await new IndexedDbSimulationStateStore(sourceName).save(beforeLiquidation)
  const source = new WorkstationBackupService(sourceName, storage)
  const targetStorage = new MemoryPreferences()
  const target = new WorkstationBackupService(`okx-target-${crypto.randomUUID()}`, targetStorage)
  const full = await source.exportAll()
  for (const archive of [await source.exportPreferences(), full]) {
    await target.import(archive)
    expect((await target.exportPreferences()).data.preferences).toEqual(full.data.preferences)
  }
  expect((await target.exportAll()).data).toEqual(full.data)
  const legacy = await source.exportPreferences()
  delete legacy.data.preferences!.priceSource
  delete legacy.data.preferences!.okxSelectedSymbol
  await target.import(legacy)
  expect((await target.exportAll()).data).toEqual(full.data)
  for (const patch of [{ priceSource: null }, { priceSource: '' }, { priceSource: false },
    { okxSelectedSymbol: null }, { okxSelectedSymbol: {} }, { okxSelectedSymbol: { ...DEFAULT_OKX_SYMBOL, priceCurrency: 'BTC' } }]) {
    const invalid = { ...legacy, data: { preferences: { ...legacy.data.preferences, ...patch, favoriteSymbols: ['changed'] } } }
    await expect(target.import(invalid)).rejects.toThrow(/priceSource|OKX|交易品种|交易对/)
    expect((await target.exportAll()).data).toEqual(full.data)
  }
  const invalid = structuredClone(full)
  invalid.data.sessions![0].tradingConfig.okx!.contractStep = '0'
  await expect(target.import(invalid)).rejects.toThrow(/OKX 回放交易规格/)
  expect((await target.exportAll()).data).toEqual(full.data)
})

it('validates a legacy full backup and imports only configuration and sessions in the cTrader experiment', async () => {
  const legacy = new WorkstationBackupService(`legacy-source-${crypto.randomUUID()}`, new MemoryPreferences())
  const archive = await legacy.exportAll()
  archive.data.symbols = [symbol()]
  archive.data.tradeCandles = [candle()]
  archive.data.sessions = [session()]
  const databaseName = `ctrader-target-${crypto.randomUUID()}`
  const target = new WorkstationBackupService(databaseName, new MemoryPreferences(), Date.now, undefined, { includeMarketHistory: false })
  expect(await target.import(archive)).toMatchObject({ symbols: 0, tradeCandles: 0, sessions: 1 })
  expect(await new IndexedDbReplaySessionStore(databaseName).get(session().id)).toEqual(session())
  expect((await target.exportAll()).data).toMatchObject({ tradeCandles: [], symbols: [] })
  await expect(target.exportMarketData()).rejects.toThrow('行情')
  archive.data.tradeCandles = [{ ...candle(), close: 'invalid' }]
  archive.data.preferences!.favoriteSymbols = ['EURUSD']
  await expect(target.import(archive)).rejects.toThrow('tradeCandles')
  expect((await target.exportPreferences()).data.preferences?.favoriteSymbols).toEqual([])
})

it('writes imported replay and simulated trades to the experimental database only', async () => {
  const legacySessions = new IndexedDbReplaySessionStore()
  const experimentalSessions = new IndexedDbReplaySessionStore(CTRADER_DATABASE_NAME)
  const original = { ...session(), id: 'database-isolation', updatedAt: 0 }
  await legacySessions.put(original)
  const restored = { ...original, updatedAt: 1 }
  const simulation = SimulationEngine.create(restored)
  simulation.open('long', { quantity: '1' }, candle())
  const archive = { fileType: BACKUP_FILE_TYPE, schemaVersion: 1, kind: 'session', exportedAt: 1,
    data: { sessions: [restored], simulations: [simulation.snapshot()] } }
  const target = new WorkstationBackupService(CTRADER_DATABASE_NAME, new MemoryPreferences(), Date.now, undefined, { includeMarketHistory: false })
  await target.import(archive)
  expect(await legacySessions.get(restored.id)).toEqual(original)
  expect(await new IndexedDbSimulationStateStore().load(restored.id)).toBeUndefined()
  expect(await experimentalSessions.get(restored.id)).toEqual(restored)
  expect((await new IndexedDbSimulationStateStore(CTRADER_DATABASE_NAME).load(restored.id))?.trades).toHaveLength(1)
})

it('validates native periods, cTrader settings and the archived cursor without rewriting legacy selections', async () => {
  const target = new WorkstationBackupService(`ctrader-prefs-${crypto.randomUUID()}`, new MemoryPreferences())
  const archive = await target.exportAll()
  archive.data.preferences = {
    ...archive.data.preferences!, favoriteSymbols: ['EURUSD'], pinnedPeriods: ['2m', '6h'],
    replayStepPeriod: '10m', selectedSymbol: { exchange: 'CTRADER', ticker: 'XAUUSD' },
  }
  const native = { ...session(), id: 'ctrader-replay', symbol: { exchange: 'CTRADER', ticker: 'EURUSD' },
    endTime: 119_999, visibleUntil: 120_000, marketSource: 'ctrader', cursorTimeframe: '2m' } as const
  archive.data.sessions = [native]
  await target.import(archive)
  expect((await target.exportAll()).data).toMatchObject({ preferences: archive.data.preferences, sessions: [native] })
  const invalid = { ...archive, data: { ...archive.data, sessions: [{ ...native, cursorTimeframe: '6h' }],
    preferences: { ...archive.data.preferences!, favoriteSymbols: [] } } }
  await expect(target.import(invalid)).rejects.toThrow('cursorTimeframe')
  const malformedBoundary = { ...archive, data: { ...archive.data,
    sessions: [{ ...native, visibleUntil: native.visibleUntil - 1 }],
    preferences: { ...archive.data.preferences!, favoriteSymbols: [] } } }
  await expect(target.import(malformedBoundary)).rejects.toThrow('visibleUntil')
  expect((await target.exportAll()).data.sessions).toEqual([native])
  expect((await target.exportPreferences()).data.preferences?.favoriteSymbols).toEqual(['EURUSD'])
})

it('rejects explicit invalid IC Markets specifications before modifying preferences or sessions', async () => {
  const target = new WorkstationBackupService(`invalid-ic-markets-${crypto.randomUUID()}`, new MemoryPreferences())
  const archive = await target.exportAll()
  const native = { ...session(), symbol: { exchange: 'CTRADER', ticker: 'EURUSD' },
    marketSource: 'ctrader', cursorTimeframe: '1m', visibleUntil: 60_000 }
  const invalid = { ...archive, data: { ...archive.data,
    preferences: { ...archive.data.preferences!, favoriteSymbols: ['XAUUSD'] },
    sessions: [{ ...native, tradingConfig: { ...native.tradingConfig, ctrader: null } }],
  } }
  await expect(target.import(invalid)).rejects.toThrow('IC Markets 回放交易规格无效')
  expect((await target.exportAll()).data).toEqual(archive.data)
})

it('round-trips fine replay settings and Tick cursors while validating them before import', async () => {
  const target = new WorkstationBackupService(`ctrader-ticks-${crypto.randomUUID()}`, new MemoryPreferences())
  const archive = await target.exportAll()
  const tick = {
    ...session(), symbol: { exchange: 'CTRADER', ticker: 'EURUSD' }, marketSource: 'ctrader' as const,
    cursorTimeframe: 'tick' as const, cursorTickIndex: 0, currentTime: 60_123, currentIndex: 1, visibleUntil: 60_124, endTime: 120_000,
  }
  for (const replayStepPeriod of ['1s', '5s', '15s', 'tick'] as const) {
    const data = { ...archive.data, preferences: { ...archive.data.preferences!, replayStepPeriod }, sessions: [tick] }
    await target.import({ ...archive, data })
    expect((await target.exportPreferences()).data.preferences).toEqual(data.preferences)
    expect((await target.exportAll()).data).toMatchObject({ preferences: data.preferences, sessions: [tick] })
  }
  const restored = (await target.exportAll()).data
  const legacyPreferences = { ...restored.preferences }
  delete legacyPreferences.replayStepPeriod
  await target.import({ ...archive, kind: 'preferences', data: { preferences: legacyPreferences } })
  expect((await target.exportPreferences()).data.preferences?.replayStepPeriod).toBe('tick')
  for (const replayStepPeriod of [null, '', false, 0, '10s']) {
    await expect(target.import({ ...archive, data: { ...restored, preferences: { ...restored.preferences!, replayStepPeriod } } }))
      .rejects.toThrow('replayStepPeriod')
  }
  for (const cursorTickIndex of [undefined, -1, null, 1.5]) {
    await expect(target.import({ ...archive, data: { ...restored, sessions: [{ ...tick, cursorTickIndex }] } }))
      .rejects.toThrow('cursorTickIndex')
  }
  const seconds = { ...tick, cursorTimeframe: '5s', cursorTickIndex: undefined, currentTime: 65_000, visibleUntil: 70_000 }
  await expect(target.import({ ...archive, data: { ...restored, sessions: [{ ...seconds, currentTime: 65_001 }] } }))
    .rejects.toThrow('visibleUntil')
  expect((await target.exportAll()).data).toEqual(restored)
  await target.import({ ...archive, data: { ...restored, sessions: [seconds] } })
  const { cursorTickIndex: _, ...archivedSeconds } = seconds
  expect((await target.exportAll()).data.sessions).toEqual([archivedSeconds])
})

it('round-trips the cTrader account preference and rejects invalid values before writes', async () => {
  const target = new WorkstationBackupService(`ctrader-account-${crypto.randomUUID()}`, new MemoryPreferences())
  const archive = await target.exportPreferences()
  expect(archive.data.preferences).not.toHaveProperty('ctraderAccount')
  await target.import({ ...archive, data: { preferences: { ...archive.data.preferences!, ctraderAccount: 'live:19' } } })
  expect((await target.exportPreferences()).data.preferences).toMatchObject({ ctraderAccount: 'live:19' })
  await target.import(archive)
  const full = (await target.exportAll()).data
  expect(full.preferences).toMatchObject({ ctraderAccount: 'live:19' })
  for (const ctraderAccount of [null, '', false, 0, [], {}, 'live:0', 'demo:-1', 'real:19', 'live:9007199254740992']) {
    await expect(target.import({ ...archive, data: { preferences: { ...archive.data.preferences!, favoriteSymbols: ['EURUSD'], ctraderAccount } } })).rejects.toThrow('ctraderAccount')
    expect((await target.exportAll()).data).toEqual(full)
  }
})

async function seed(databaseName: string, preferences: MemoryPreferences) {
  preferences.setItem(PINNED_PERIODS_KEY, JSON.stringify(['1m', '1d']))
  preferences.setItem(SELECTED_SYMBOL_STORAGE_KEY, JSON.stringify(DEFAULT_SYMBOL))
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
  const database = await openWorkstationDatabase(databaseName)
  await database.put('markCandles', candle('99'))
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
      { name: 'KC', calcParams: [14, 2.5, 10], visible: false, styles: { lines: [{ color: '#123456', size: 0 }] } },
      { name: 'BIG_TRADES', calcParams: [0], visible: false, styles: {
        bubbleMode: 'aggregate',
        bubbleColors: [{ color: '#12345600' }, { color: '#23456780' }, { color: '#345678' }, { color: '#456789' }],
      } },
      { name: 'PIVOTS', calcParams: [...PIVOTS_DEFAULT_PARAMS.slice(0, 30), '#112233', '#aa1111', '#11aa11', true, '#445566', '#aa7777', '#77aa77'], visible: false, styles: null },
      { name: 'MARKET_SESSIONS', calcParams: [], visible: false, styles: {
        sessionVisibility: [true, false, true],
        sessionFills: [{ color: '#12345600' }, { color: '#57b5fc38' }, { color: '#ce83ef80' }],
        sessionLines: [{ style: 'solid', size: 0 }],
      } },
    ],
    sub: [
      {
        height: 160,
        indicators: [
          {
            name: 'RSI',
            calcParams: [6, 12, 24],
            visible: true,
            styles: { rsiLevels: { oversold: 0, overbought: 100 }, rsiLines: [{ color: '#12345600', size: 0 }, { color: '#76808f80' }] },
          },
          { name: 'TTM_SQUEEZE', calcParams: [14, 2.5, 1.25], visible: true, styles: { bars: [{ noChangeColor: '#abcdef', borderSize: 0 }] } },
          { name: 'TTM_WAVE_A', calcParams: [5, 21, 34], visible: false, styles: { bars: [{ noChangeColor: '#123456', positiveColor: '#12ab34', negativeColor: '#ed1234', borderSize: 0 }, { positiveColor: '#34ab56', negativeColor: '#ed5678' }] } },
          { name: 'TTM_WAVE_B', calcParams: [5, 55, 89], visible: true, styles: null },
          { name: 'TTM_WAVE_C', calcParams: [5, 144, 233], visible: true, styles: null },
        ],
      },
    ],
  }
}

describe('WorkstationBackupService', () => {
  it.each([{ oversold: 50, overbought: 70 }, { oversold: 30, overbought: 101 }, null])('rejects invalid RSI levels before importing business data (%j)', async levels => {
    const storage = new MemoryPreferences()
    const service = new WorkstationBackupService(`rsi-invalid-${crypto.randomUUID()}`, storage)
    const prefs = indicatorPreferences()
    prefs.sub[0].indicators[0].styles = { rsiLevels: levels }
    await expect(service.import({ fileType: BACKUP_FILE_TYPE, schemaVersion: 1, kind: 'all', exportedAt: 0, data: {
      preferences: { binanceRestBaseUrl: 'https://changed.test', favoriteSymbols: [], chartIndicators: prefs },
      symbols: [symbol()], tradeCandles: [candle()],
    } })).rejects.toThrow(/RSI/)
    expect(storage.getItem('marketData.binanceBaseUrl')).toBeNull()
    expect((await service.exportAll()).data.tradeCandles).toEqual([])
  })
  it('round-trips hidden trade overlays in both archive types and preserves them when old archives omit the setting', async () => {
    const storage = new MemoryPreferences()
    const source = new WorkstationBackupService(`overlays-${crypto.randomUUID()}`, storage)
    expect((await source.exportPreferences()).data.preferences).toHaveProperty('showTradeOverlays', true)
    storage.setItem('chart.showTradeOverlays.v1', 'false')
    for (const archive of [await source.exportPreferences(), await source.exportAll()]) {
      expect(archive.data.preferences).toHaveProperty('showTradeOverlays', false)
      const targetStorage = new MemoryPreferences()
      const target = new WorkstationBackupService(`overlays-target-${crypto.randomUUID()}`, targetStorage)
      await target.import(archive)
      expect((await target.exportPreferences()).data.preferences).toEqual(archive.data.preferences)
      const legacy = structuredClone(archive)
      delete legacy.data.preferences!.showTradeOverlays
      await target.import(legacy)
      expect(targetStorage.getItem('chart.showTradeOverlays.v1')).toBe('false')
    }
  })

  it.each([null, '', 0, 'false', [], {}].map(value => [value]))('rejects invalid trade overlay settings before writing (%j)', async showTradeOverlays => {
    const storage = new MemoryPreferences()
    const name = `invalid-overlays-${crypto.randomUUID()}`
    const service = new WorkstationBackupService(name, storage)
    const archive = await service.exportAll()
    archive.data.symbols = [symbol()]
    Object.assign(archive.data.preferences!, { showTradeOverlays })
    await expect(service.import(archive)).rejects.toThrow(/showTradeOverlays/)
    expect(storage.getItem('chart.showTradeOverlays.v1')).toBeNull()
    expect(await new IndexedDbMarketDataStore(name).getSymbols()).toEqual([])
  })

  it('round-trips replay step periods in config and full archives, preserving legacy absence', async () => {
    const sourceStorage = new MemoryPreferences()
    const source = new WorkstationBackupService(`replay-step-source-${crypto.randomUUID()}`, sourceStorage)
    expect((await source.exportPreferences()).data.preferences).toHaveProperty('replayStepPeriod', '1m')
    sourceStorage.setItem('replay.stepPeriod.v1', '"invalid"')
    expect((await source.exportPreferences()).data.preferences).toHaveProperty('replayStepPeriod', '1m')
    sourceStorage.setItem('replay.stepPeriod.v1', '"1M"')
    for (const archive of [await source.exportPreferences(), await source.exportAll()]) {
      expect(archive.data.preferences).toHaveProperty('replayStepPeriod', '1M')
      const targetStorage = new MemoryPreferences()
      const target = new WorkstationBackupService(`replay-step-target-${crypto.randomUUID()}`, targetStorage)
      await target.import(archive)
      expect((await target.exportPreferences()).data.preferences).toEqual(archive.data.preferences)
      const legacy = structuredClone(archive)
      delete legacy.data.preferences!.replayStepPeriod
      await target.import(legacy)
      expect(targetStorage.getItem('replay.stepPeriod.v1')).toBe('"1M"')
    }
  })

  it.each([null, '', 0, false, [], {}, '1H'].map(value => [value]))('rejects invalid replay step periods before any writes (%j)', async replayStepPeriod => {
    const storage = new MemoryPreferences()
    const name = `replay-step-invalid-${crypto.randomUUID()}`
    const service = new WorkstationBackupService(name, storage)
    const archive = await service.exportAll()
    archive.data.symbols = [symbol()]
    Object.assign(archive.data.preferences!, { replayStepPeriod })
    await expect(service.import(archive)).rejects.toThrow(/replayStepPeriod/)
    expect(storage.getItem('replay.stepPeriod.v1')).toBeNull()
    expect(await new IndexedDbMarketDataStore(name).getSymbols()).toEqual([])
  })

  it('round-trips candle types in config and full archives, preserving legacy absence', async () => {
    const sourceStorage = new MemoryPreferences()
    sourceStorage.setItem('chart.candleType.v1', JSON.stringify('heikin_ashi'))
    const source = new WorkstationBackupService(`ha-source-${crypto.randomUUID()}`, sourceStorage)
    for (const archive of [await source.exportPreferences(), await source.exportAll()]) {
      expect(archive.data.preferences).toHaveProperty('candleType', 'heikin_ashi')
      const targetStorage = new MemoryPreferences()
      const target = new WorkstationBackupService(`ha-target-${crypto.randomUUID()}`, targetStorage)
      await target.import(archive)
      expect((await target.exportPreferences()).data.preferences).toEqual(archive.data.preferences)
      const legacy = structuredClone(archive)
      delete (legacy.data.preferences as unknown as Record<string, unknown>).candleType
      await target.import(legacy)
      expect(targetStorage.getItem('chart.candleType.v1')).toBe('"heikin_ashi"')
      Object.assign(archive.data.preferences!, { candleType: 'candle_solid' })
      await target.import(archive)
      expect(targetStorage.getItem('chart.candleType.v1')).toBe('"candle_solid"')
    }
  })

  it.each([null, '', false, 0, [], {}, 'unknown'])('rejects invalid candle types before any writes (%j)', async candleType => {
    const storage = new MemoryPreferences()
    storage.setItem('marketData.binanceBaseUrl', 'https://original.test')
    const databaseName = `ha-invalid-${crypto.randomUUID()}`
    const service = new WorkstationBackupService(databaseName, storage)
    const archive = await service.exportAll()
    archive.data.symbols = [symbol()]
    archive.data.preferences!.binanceRestBaseUrl = 'https://changed.test'
    Object.assign(archive.data.preferences!, { candleType })
    await expect(service.import(archive)).rejects.toThrow(/candleType/)
    expect(storage.getItem('marketData.binanceBaseUrl')).toBe('https://original.test')
    expect(storage.getItem('chart.candleType.v1')).toBeNull()
    expect(await new IndexedDbMarketDataStore(databaseName).getSymbols()).toEqual([])
  })
  it('round-trips chart window size in config and full archives and preserves it for legacy archives', async () => {
    const sourceStorage = new MemoryPreferences()
    const source = new WorkstationBackupService(`chart-window-source-${crypto.randomUUID()}`, sourceStorage)
    expect((await source.exportPreferences()).data.preferences?.chartWindowSize).toEqual(DEFAULT_CHART_WINDOW_SIZE)
    const size = { width: 807, height: 564 }
    saveChartWindowSize(size, sourceStorage)
    for (const archive of [await source.exportPreferences(), await source.exportAll()]) {
      expect(archive.data.preferences?.chartWindowSize).toEqual(size)
      const targetStorage = new MemoryPreferences()
      const target = new WorkstationBackupService(`chart-window-target-${crypto.randomUUID()}`, targetStorage)
      await target.import(archive)
      expect((await target.exportPreferences()).data.preferences).toEqual(archive.data.preferences)
      delete archive.data.preferences!.chartWindowSize
      await target.import(archive)
      expect(targetStorage.getItem(CHART_WINDOW_SIZE_KEY)).toBe(JSON.stringify(size))
    }
  })

  it.each([null, '', [], {}, { width: 800 }, { width: 0, height: 600 }, { width: 800, height: 600.5 }].map(value => [value]))(
    'rejects malformed window dimensions before writing (%j)', async chartWindowSize => {
      const storage = new MemoryPreferences()
      const name = `chart-window-invalid-${crypto.randomUUID()}`
      const service = new WorkstationBackupService(name, storage)
      const archive = await service.exportAll()
      archive.data.symbols = [symbol()]
      Object.assign(archive.data.preferences!, { chartWindowSize })
      await expect(service.import(archive)).rejects.toThrow(/chartWindowSize/)
      expect(storage.getItem('marketData.binanceBaseUrl')).toBeNull()
      expect(storage.getItem(CHART_WINDOW_SIZE_KEY)).toBeNull()
      expect(await new IndexedDbMarketDataStore(name).getSymbols()).toEqual([])
    },
  )

  it('round-trips workspace layout in config and full archives without replacing missing legacy layouts', async () => {
    const workspace = {
      schemaVersion: 1,
      panels: { account: false, order: false, dock: true, replay: false, status: false },
      chartHeight: 760, mobileChartHeight: null, dockHeight: 280,
    }
    const sourceStorage = new MemoryPreferences()
    sourceStorage.setItem('workspace.layout.v1', JSON.stringify(workspace))
    const source = new WorkstationBackupService(`workspace-source-${crypto.randomUUID()}`, sourceStorage)
    for (const archive of [await source.exportPreferences(), await source.exportAll()]) {
      expect(archive.data.preferences).toHaveProperty('workspace', workspace)
      const targetStorage = new MemoryPreferences()
      const target = new WorkstationBackupService(`workspace-target-${crypto.randomUUID()}`, targetStorage)
      await target.import(archive)
      expect((await target.exportPreferences()).data.preferences).toEqual(archive.data.preferences)
      expect(JSON.parse(targetStorage.getItem('workspace.layout.v1')!)).toEqual(workspace)
      const legacy = structuredClone(archive)
      delete (legacy.data.preferences as unknown as Record<string, unknown>).workspace
      await target.import(legacy)
      expect(JSON.parse(targetStorage.getItem('workspace.layout.v1')!)).toEqual(workspace)
    }
  })

  it.each([null, {}, { schemaVersion: 1, panels: { account: false }, chartHeight: null, mobileChartHeight: null, dockHeight: 220 }])('rejects an invalid workspace before any data or preferences are written (%j)', async workspace => {
    const storage = new MemoryPreferences()
    storage.setItem('marketData.binanceBaseUrl', 'https://original.test')
    const databaseName = `workspace-invalid-${crypto.randomUUID()}`
    const service = new WorkstationBackupService(databaseName, storage)
    const archive = await service.exportAll()
    archive.data.symbols = [symbol()]
    archive.data.preferences!.binanceRestBaseUrl = 'https://changed.test'
    Object.assign(archive.data.preferences!, { workspace })
    await expect(service.import(archive)).rejects.toThrow(/workspace/)
    expect(storage.getItem('marketData.binanceBaseUrl')).toBe('https://original.test')
    expect(storage.getItem('workspace.layout.v1')).toBeNull()
    expect(await new IndexedDbMarketDataStore(databaseName).getSymbols()).toEqual([])
  })

  it('round-trips shared leverage and independent risk orders in session and full archives', async () => {
    const sourceName = `hedged-source-${crypto.randomUUID()}`
    await seed(sourceName, new MemoryPreferences())
    const replay = { ...session(), period: SUPPORTED_PERIODS[2], endTime: 300_000, visibleUntil: 360_000 }
    await new IndexedDbReplaySessionStore(sourceName).put(replay)
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle())
    engine.open('short', { quantity: '2' }, candle())
    engine.setLeverage(20)
    engine.setTakeProfit('long', '120', 0)
    engine.setStopLoss('long', '95', 0)
    engine.setTakeProfit('short', '80', 0)
    engine.setStopLoss('short', '105', 0)
    await new IndexedDbSimulationStateStore(sourceName).save(engine.snapshot())
    const source = new WorkstationBackupService(sourceName, new MemoryPreferences())
    for (const archive of [await source.exportAll(), await source.exportSession(session().id)]) {
      const target = new WorkstationBackupService(`hedged-target-${crypto.randomUUID()}`, new MemoryPreferences())
      await target.import(archive)
      expect((await target.exportAll()).data.simulations).toEqual(archive.data.simulations)
      expect((await target.exportAll()).data.sessions).toEqual([replay])
      expect(archive.data.simulations![0].config.leverage).toBe(20)
      expect(archive.data.simulations![0].positions).toMatchObject([
        { side: 'long', leverage: 20, takeProfitPrice: '120', stopLossPrice: '95' },
        { side: 'short', leverage: 20, takeProfitPrice: '80', stopLossPrice: '105' },
      ])
    }
  })

  it.each([null, 0, 360_001, 600_000])('rejects an invalid replay visibility boundary (%s) before writing', async visibleUntil => {
    const sourceName = `invalid-replay-${crypto.randomUUID()}`
    await seed(sourceName, new MemoryPreferences())
    const archive = await new WorkstationBackupService(sourceName, new MemoryPreferences()).exportAll()
    Object.assign(archive.data.sessions![0], { period: SUPPORTED_PERIODS[2], endTime: 300_000, visibleUntil })
    const target = new WorkstationBackupService(`invalid-replay-target-${crypto.randomUUID()}`, new MemoryPreferences())
    await expect(target.import(archive)).rejects.toThrow(/visibleUntil/)
    expect((await target.exportAll()).data.sessions).toEqual([])
  })

  it.each(['missing', 'null', 'duplicate', 'bad-side', 'zero-quantity', 'bad-risk', 'missing-activation', 'missing-leverage', 'null-leverage', 'zero-leverage', 'fractional-leverage'])('rejects invalid hedged positions (%s) before writing any data', async invalid => {
    const sourceName = `invalid-hedged-source-${crypto.randomUUID()}`
    await seed(sourceName, new MemoryPreferences())
    const archive = await new WorkstationBackupService(sourceName, new MemoryPreferences()).exportAll()
    const state = archive.data.simulations![0] as unknown as Record<string, unknown>
    const positions = state.positions as Record<string, unknown>[]
    if (invalid === 'missing') delete state.positions
    if (invalid === 'null') state.positions = null
    if (invalid === 'duplicate') positions.push(structuredClone(positions[0]))
    if (invalid === 'bad-side') positions[0].side = 'both'
    if (invalid === 'zero-quantity') positions[0].quantity = '0'
    if (invalid === 'bad-risk') positions.push({ ...positions[0], side: 'short', stopLossPrice: 'invalid' })
    if (invalid === 'missing-activation') positions[0].stopLossPrice = '95'
    if (invalid === 'missing-leverage') delete positions[0].leverage
    if (invalid === 'null-leverage') positions[0].leverage = null
    if (invalid === 'zero-leverage') positions[0].leverage = 0
    if (invalid === 'fractional-leverage') positions[0].leverage = 2.5
    const storage = new MemoryPreferences()
    const target = new WorkstationBackupService(`invalid-hedged-target-${crypto.randomUUID()}`, storage)
    await expect(target.import(archive)).rejects.toThrow(/positions/)
    expect((await target.exportAll()).data.simulations).toEqual([])
    expect((await target.exportAll()).data.symbols).toEqual([])
    expect(storage.getItem('marketData.binanceBaseUrl')).toBeNull()
  })

  it('round-trips indicator configuration-only archives and preserves legacy missing versus explicit empty', async () => {
    const sourceStorage = new MemoryPreferences()
    sourceStorage.setItem(CHART_INDICATORS_PREFERENCE, JSON.stringify(indicatorPreferences()))
    const source = new WorkstationBackupService(`indicator-source-${crypto.randomUUID()}`, sourceStorage)
    const targetStorage = new MemoryPreferences()
    const target = new WorkstationBackupService(`indicator-target-${crypto.randomUUID()}`, targetStorage)
    const full = await source.exportAll()
    expect(full.data.preferences!.chartIndicators).toEqual(indicatorPreferences())
    await target.import(full)
    expect((await target.exportAll()).data.preferences).toEqual(full.data.preferences)
    const archive = await source.exportPreferences()
    await target.import(archive)
    expect((await target.exportPreferences()).data.preferences).toEqual(archive.data.preferences)
    delete archive.data.preferences!.chartIndicators
    await target.import(archive)
    expect(JSON.parse(targetStorage.getItem(CHART_INDICATORS_PREFERENCE)!)).toEqual(indicatorPreferences())
    archive.data.preferences!.chartIndicators = indicatorPreferences()
    archive.data.preferences!.chartIndicators.main.find(i => i.name === 'PIVOTS')!.calcParams = PIVOTS_DEFAULT_PARAMS.slice(0, 30)
    const legacySessions = archive.data.preferences!.chartIndicators.main.find(i => i.name === 'MARKET_SESSIONS')!
    legacySessions.calcParams = [0, 95]
    legacySessions.styles = null
    archive.data.preferences!.chartIndicators.main.find(i => i.name === 'BIG_TRADES')!.styles = null
    await target.import(archive)
    expect((await target.exportPreferences()).data.preferences!.chartIndicators!.main.find(i => i.name === 'PIVOTS')!.calcParams.slice(30))
      .toEqual(['#fb8c00', '#ef5350', '#26a69a', true, '#445566', '#aa7777', '#77aa77'])
    expect((await target.exportPreferences()).data.preferences!.chartIndicators!.main.find(i => i.name === 'MARKET_SESSIONS'))
      .toEqual(indicatorPreferences().main.find(i => i.name === 'MARKET_SESSIONS'))
    expect((await target.exportPreferences()).data.preferences!.chartIndicators!.main.find(i => i.name === 'BIG_TRADES'))
      .toEqual(indicatorPreferences().main.find(i => i.name === 'BIG_TRADES'))
    archive.data.preferences!.chartIndicators = { schemaVersion: 1, main: [], sub: [] }
    await target.import(archive)
    expect((await target.exportPreferences()).data.preferences!.chartIndicators).toEqual({ schemaVersion: 1, main: [], sub: [] })
    const invalid = indicatorPreferences()
    const invalidStyles: JsonValue[] = [
      { sessionLines: [] }, { sessionVisibility: null }, { sessionVisibility: [] }, { sessionVisibility: [false, 0, true] },
    ]
    const before = (await target.exportAll()).data
    archive.data.preferences!.binanceRestBaseUrl = 'https://changed.test'
    for (const styles of invalidStyles) {
      invalid.main.find(i => i.name === 'MARKET_SESSIONS')!.styles = styles
      archive.data.preferences!.chartIndicators = invalid
      await expect(target.import(archive)).rejects.toThrow(/MARKET_SESSIONS/)
      expect((await target.exportAll()).data).toEqual(before)
    }
    const invalidBubbles = indicatorPreferences()
    invalidBubbles.main.find(i => i.name === 'BIG_TRADES')!.styles = { bubbleColors: null }
    archive.data.preferences!.chartIndicators = invalidBubbles
    await expect(target.import(archive)).rejects.toThrow(/BIG_TRADES.*bubbleColors/)
    expect((await target.exportAll()).data).toEqual(before)
    for (const bubbleMode of [null, '', 'unknown']) {
      invalidBubbles.main.find(i => i.name === 'BIG_TRADES')!.styles = { bubbleMode }
      await expect(target.import(archive)).rejects.toThrow(/BIG_TRADES.*bubbleMode/)
      expect((await target.exportAll()).data).toEqual(before)
    }
  })

  it.each(['KC', 'TTM_SQUEEZE', 'TTM_WAVE_A', 'TTM_WAVE_B', 'TTM_WAVE_C', 'PIVOTS', 'MARKET_SESSIONS', 'BIG_TRADES'])('rejects illegal %s configuration before writing any preferences or market data', async name => {
    const storage = new MemoryPreferences()
    storage.setItem('marketData.binanceBaseUrl', 'https://original.test')
    const databaseName = `bad-indicator-${crypto.randomUUID()}`
    const service = new WorkstationBackupService(databaseName, storage)
    const archive = await service.exportAll()
    archive.data.symbols = [symbol()]
    archive.data.preferences!.binanceRestBaseUrl = 'https://changed.test'
    archive.data.preferences!.chartIndicators = {
      schemaVersion: 1, main: [{ name, calcParams: [0, 2, 14], visible: true, styles: null }], sub: [],
    }
    await expect(service.import(archive)).rejects.toThrow(/calcParams/)
    expect(storage.getItem('marketData.binanceBaseUrl')).toBe('https://original.test')
    expect(storage.getItem(CHART_INDICATORS_PREFERENCE)).toBeNull()
    expect(await new IndexedDbMarketDataStore(databaseName).getSymbols()).toEqual([])
  })

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
      markCandles: 0,
      sessions: 1,
      simulations: 1,
      preferences: true,
    })
    const restored = await target.exportAll()
    expect(exported.data).not.toHaveProperty('markCandles')
    expect((await source.exportMarketData()).data).not.toHaveProperty('markCandles')
    expect(restored.data).toEqual(exported.data)
    expect(
      targetPreferences.getItem('marketData.binanceBaseUrl'),
    ).toBe('https://example.test')
    expect(
      JSON.parse(
        targetPreferences.getItem(CHART_INDICATORS_PREFERENCE) ?? 'null',
      ),
    ).toEqual(indicatorPreferences())
    expect(JSON.parse(targetPreferences.getItem(SELECTED_SYMBOL_STORAGE_KEY) ?? 'null')).toEqual(DEFAULT_SYMBOL)
    expect(JSON.parse(targetPreferences.getItem(PINNED_PERIODS_KEY) ?? 'null')).toEqual(['1m', '1d'])
  })

  it('validates legacy mark candles but ignores them without deleting existing local legacy rows', async () => {
    const databaseName = `legacy-mark-${crypto.randomUUID()}`
    const database = await openWorkstationDatabase(databaseName)
    await database.put('markCandles', candle('98'))
    const service = new WorkstationBackupService(databaseName, new MemoryPreferences())
    const archive = await service.exportMarketData()
    archive.data.symbols = [symbol()]
    archive.data.tradeCandles = [candle()]
    archive.data.markCandles = [candle('99')]
    expect(validateBackupEnvelope(archive).data).not.toHaveProperty('markCandles')
    await service.import(archive)
    expect(await database.getAll('markCandles')).toEqual([candle('98')])
    expect((await service.exportAll()).data).not.toHaveProperty('markCandles')
    archive.data.markCandles = [{ ...candle(), high: '1' }]
    archive.data.tradeCandles = [{ ...candle(), openTime: 60_000, closeTime: 119_999 }]
    await expect(service.import(archive)).rejects.toThrow()
    expect(await database.getAll('tradeCandles')).toEqual([candle()])
  })

  it('normalizes legacy position markPrice into lastPrice and exports only the current field', async () => {
    const databaseName = `legacy-price-${crypto.randomUUID()}`
    const preferences = new MemoryPreferences()
    await seed(databaseName, preferences)
    const service = new WorkstationBackupService(databaseName, preferences)
    const archive = await service.exportAll()
    const state = archive.data.simulations![0] as unknown as Record<string, unknown>
    const position = archive.data.simulations![0].positions[0] as unknown as Record<string, unknown>
    state.schemaVersion = 1
    state.position = position
    delete state.positions
    position.markPrice = '102'
    delete position.lastPrice
    const validated = validateBackupEnvelope(archive)
    expect(validated.data.simulations![0].positions[0]).toMatchObject({ lastPrice: '102' })
    expect(validated.data.simulations![0].positions[0]).not.toHaveProperty('markPrice')
    await service.import(archive)
    const output = await service.exportAll()
    expect(output.data.simulations![0].positions[0]).not.toHaveProperty('markPrice')
    expect(output.data.simulations![0].positions[0]?.lastPrice).toBe('102')
    position.markPrice = 'bad'
    await expect(service.import(archive)).rejects.toThrow(/markPrice/)
  })

  it('exports default and explicitly empty shortcuts in configuration-only archives', async () => {
    const preferences = new MemoryPreferences()
    const service = new WorkstationBackupService(`periods-${crypto.randomUUID()}`, preferences)
    expect((await service.exportPreferences()).data.preferences?.pinnedPeriods).toEqual(DEFAULT_PINNED_PERIODS)
    preferences.setItem(PINNED_PERIODS_KEY, '[]')
    const archive = await service.exportPreferences()
    expect(archive.data.preferences?.pinnedPeriods).toEqual([])
    const targetPreferences = new MemoryPreferences()
    targetPreferences.setItem(PINNED_PERIODS_KEY, '["1h"]')
    await new WorkstationBackupService(`periods-target-${crypto.randomUUID()}`, targetPreferences).import(archive)
    expect(targetPreferences.getItem(PINNED_PERIODS_KEY)).toBe('[]')
  })

  it('keeps local shortcuts when importing older archives without pinnedPeriods', async () => {
    const preferences = new MemoryPreferences()
    preferences.setItem(PINNED_PERIODS_KEY, '["1h"]')
    const service = new WorkstationBackupService(`legacy-periods-${crypto.randomUUID()}`, preferences)
    const archive = await service.exportPreferences()
    delete archive.data.preferences!.pinnedPeriods
    await service.import(archive)
    expect(preferences.getItem(PINNED_PERIODS_KEY)).toBe('["1h"]')
  })

  it.each([null, '1h', [15], ['unsupported'], ['1h', '1h']].map((value) => ({ value })))('rejects invalid pinned periods $value before importing any data', async ({ value: invalid }) => {
    const preferences = new MemoryPreferences()
    preferences.setItem(PINNED_PERIODS_KEY, '["1h"]')
    preferences.setItem('marketData.binanceBaseUrl', 'https://example.test')
    const databaseName = `invalid-periods-${crypto.randomUUID()}`
    const service = new WorkstationBackupService(databaseName, preferences)
    const archive = await service.exportAll()
    archive.data.symbols = [symbol()]
    archive.data.preferences!.binanceRestBaseUrl = 'https://changed.test'
    const payload: unknown = { ...archive, data: { ...archive.data, preferences: { ...archive.data.preferences, pinnedPeriods: invalid } } }
    await expect(service.import(payload)).rejects.toThrow(/pinnedPeriods/)
    expect(preferences.getItem(PINNED_PERIODS_KEY)).toBe('["1h"]')
    expect(preferences.getItem('marketData.binanceBaseUrl')).toBe('https://example.test')
    const symbols = await new IndexedDbMarketDataStore(databaseName).getSymbols()
    expect(symbols).toEqual([])
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

  it('skips unchanged market rows while restoring changed and new candles', async () => {
    const databaseName = `backup-unchanged-${crypto.randomUUID()}`
    const market = new IndexedDbMarketDataStore(databaseName)
    const second = {...candle(),openTime:60_000,closeTime:119_999}
    const third = {...candle(),openTime:120_000,closeTime:179_999}
    await market.putCandles('trade',[candle(),second])
    const service = new WorkstationBackupService(databaseName,new MemoryPreferences())
    const archive = await service.exportMarketData('BTCUSDT','1m')
    archive.data.tradeCandles = [candle(),{...second,close:'105'},third]
    const writes = vi.spyOn(IDBObjectStore.prototype,'put')
    try {
      await service.import(archive)
      const candleWrites = writes.mock.calls.map(([value])=>value as MarketCandle).filter(value=>value.timeframe==='1m')
      expect(candleWrites.map(row=>row.openTime)).toEqual([60_000,120_000])
      expect((await market.getCandles('trade','BTCUSDT','1m',0,120_000)).map(row=>row.close)).toEqual(['100','105','100'])
    } finally {
      writes.mockRestore()
    }
  })

  it('rolls back all imported stores and preferences when a native batch write fails', async () => {
    const databaseName = `backup-write-failure-${crypto.randomUUID()}`
    const preferences = new MemoryPreferences()
    preferences.setItem('marketData.binanceBaseUrl', 'https://original.test')
    const service = new WorkstationBackupService(databaseName, preferences)
    const archive = await service.exportAll()
    archive.data.preferences!.binanceRestBaseUrl = 'https://changed.test'
    archive.data.symbols = [symbol()]
    archive.data.tradeCandles = [candle(), {...candle(),openTime:60_000,closeTime:119_999}]
    const original = IDBObjectStore.prototype.put
    const write = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'tradeCandles' && (value as MarketCandle).openTime === 60_000) {
        throw new DOMException('Injected batch failure', 'DataCloneError')
      }
      return original.call(this, value, key)
    })
    try {
      await expect(service.import(archive)).rejects.toThrow('Injected batch failure')
    } finally {
      write.mockRestore()
    }
    const market = new IndexedDbMarketDataStore(databaseName)
    expect(await market.getSymbols()).toEqual([])
    expect(await market.getCandles('trade','BTCUSDT','1m',0,60_000)).toEqual([])
    expect(preferences.getItem('marketData.binanceBaseUrl')).toBe('https://original.test')
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
