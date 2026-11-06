import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import { DEFAULT_PINNED_PERIODS, PINNED_PERIODS_KEY } from '../chart/period-preferences'
import { PIVOTS_DEFAULT_PARAMS } from '../chart/pivots'
import {
  CHART_INDICATORS_PREFERENCE,
  type ChartIndicatorPreferences,
} from '../chart/indicator-preferences'
import type { MarketCandle, MarketSymbol } from '../market-data/models'
import { SELECTED_SYMBOL_STORAGE_KEY } from '../market-data/symbol-preferences'
import type { ReplaySession } from '../replay/models'
import { SimulationEngine } from '../simulation/simulation-engine'
import { IndexedDbMarketDataStore, openWorkstationDatabase } from './market-data-store'
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
      { name: 'PIVOTS', calcParams: [...PIVOTS_DEFAULT_PARAMS.slice(0, 30), '#112233', '#aa1111', '#11aa11', true, '#445566', '#aa7777', '#77aa77'], visible: false, styles: null },
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

  it('round-trips both positions and their independent risk orders in session and full archives', async () => {
    const sourceName = `hedged-source-${crypto.randomUUID()}`
    await seed(sourceName, new MemoryPreferences())
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle())
    engine.open('short', { quantity: '2' }, candle())
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
      expect(archive.data.simulations![0].positions).toMatchObject([
        { side: 'long', takeProfitPrice: '120', stopLossPrice: '95' },
        { side: 'short', takeProfitPrice: '80', stopLossPrice: '105' },
      ])
    }
  })

  it.each(['missing', 'null', 'duplicate', 'bad-side', 'zero-quantity', 'bad-risk', 'missing-activation'])('rejects invalid hedged positions (%s) before writing any data', async invalid => {
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
    const archive = await source.exportPreferences()
    await target.import(archive)
    expect((await target.exportPreferences()).data.preferences).toEqual(archive.data.preferences)
    delete archive.data.preferences!.chartIndicators
    await target.import(archive)
    expect(JSON.parse(targetStorage.getItem(CHART_INDICATORS_PREFERENCE)!)).toEqual(indicatorPreferences())
    archive.data.preferences!.chartIndicators = indicatorPreferences()
    archive.data.preferences!.chartIndicators.main.find(i => i.name === 'PIVOTS')!.calcParams = PIVOTS_DEFAULT_PARAMS.slice(0, 30)
    await target.import(archive)
    expect((await target.exportPreferences()).data.preferences!.chartIndicators!.main.find(i => i.name === 'PIVOTS')!.calcParams.slice(30))
      .toEqual(['#fb8c00', '#ef5350', '#26a69a', true, '#445566', '#aa7777', '#77aa77'])
    archive.data.preferences!.chartIndicators = { schemaVersion: 1, main: [], sub: [] }
    await target.import(archive)
    expect((await target.exportPreferences()).data.preferences!.chartIndicators).toEqual({ schemaVersion: 1, main: [], sub: [] })
  })

  it.each(['KC', 'TTM_SQUEEZE', 'TTM_WAVE_A', 'TTM_WAVE_B', 'TTM_WAVE_C', 'PIVOTS'])('rejects illegal %s configuration before writing any preferences or market data', async name => {
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
