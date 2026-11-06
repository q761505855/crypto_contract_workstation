import { SUPPORTED_TIMEFRAMES } from '../market-data/intervals'
import { PINNED_PERIODS_KEY, readPinnedPeriods, validatePinnedPeriods } from '../chart/period-preferences'
import { unwrap, type IDBPTransaction } from 'idb'
import {
  CHART_INDICATORS_PREFERENCE,
  loadChartIndicatorPreferences,
  validateChartIndicatorPreferences,
  type ChartIndicatorPreferences,
} from '../chart/indicator-preferences'
import {
  FAVORITE_SYMBOLS_STORAGE_KEY,
  readFavoriteSymbols,
} from '../market-data/favorites'
import {
  SELECTED_SYMBOL_STORAGE_KEY,
  readSelectedSymbol,
  validateSelectedSymbol,
} from '../market-data/symbol-preferences'
import type { SymbolInfo } from '@klinecharts/pro'
import type {
  MarketCandle,
  MarketSymbol,
} from '../market-data/models'
import type { ReplaySession } from '../replay/models'
import { validateSimulationConfig } from '../simulation/simulation-engine'
import type {
  SimulationLedgerEntry,
  SimulationState,
  SimulationTrade,
} from '../simulation/models'
import { normalizeSimulationStatePrices } from '../simulation/models'
import {
  openWorkstationDatabase,
  type WorkstationDatabase,
} from './market-data-store'
import { IndexedDbSimulationStateStore } from './simulation-state-store'

export const BACKUP_FILE_TYPE = 'crypto-contract-workstation-backup'
export const BACKUP_SCHEMA_VERSION = 1
export const BASE_URL_PREFERENCE = 'marketData.binanceBaseUrl'
export const FAVORITES_PREFERENCE = FAVORITE_SYMBOLS_STORAGE_KEY

export type BackupKind =
  | 'preferences'
  | 'market-data'
  | 'session'
  | 'all'

export interface BackupPreferences {
  binanceRestBaseUrl: string
  favoriteSymbols: string[]
  selectedSymbol?: SymbolInfo
  chartIndicators?: ChartIndicatorPreferences
  pinnedPeriods?: string[]
}

export interface BackupData {
  preferences?: BackupPreferences
  symbols?: MarketSymbol[]
  tradeCandles?: MarketCandle[]
  /** @deprecated Legacy input only: validated and ignored, never exported. */
  markCandles?: MarketCandle[]
  sessions?: ReplaySession[]
  simulations?: SimulationState[]
}

export interface BackupEnvelope {
  fileType: typeof BACKUP_FILE_TYPE
  schemaVersion: typeof BACKUP_SCHEMA_VERSION
  kind: BackupKind
  exportedAt: number
  data: BackupData
}

export interface BackupImportReport {
  kind: BackupKind
  symbols: number
  tradeCandles: number
  markCandles: number
  sessions: number
  simulations: number
  preferences: boolean
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
type BackupStoreName =
  | 'symbols'
  | 'tradeCandles'
  | 'replaySessions'
  | 'simulationStates'
  | 'simulationTrades'
  | 'simulationLedger'

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} 格式无效`)
  }
  return value as Record<string, unknown>
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} 必须是非空字符串`)
  }
  return value
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} 必须是有效数字`)
  }
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  const result = finiteNumber(value, field)
  if (!Number.isInteger(result) || result < 0) {
    throw new Error(`${field} 必须是非负整数`)
  }
  return result
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} 必须是布尔值`)
  }
  return value
}

function decimalValue(
  value: unknown,
  field: string,
  allowNegative = true,
): string {
  const text = stringValue(value, field)
  const parsed = Number(text)
  if (!Number.isFinite(parsed) || (!allowNegative && parsed < 0)) {
    throw new Error(`${field} 不是有效十进制数字`)
  }
  return text
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} 必须是数组`)
  }
  return value
}

function assertHttpUrl(value: string, field: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${field} 不是有效网址`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${field} 必须使用 HTTP 或 HTTPS`)
  }
}

function validatePreferences(value: unknown, currentIndicators?: ChartIndicatorPreferences | null): BackupPreferences {
  const item = record(value, 'preferences')
  const binanceRestBaseUrl = stringValue(
    item.binanceRestBaseUrl,
    'preferences.binanceRestBaseUrl',
  )
  assertHttpUrl(binanceRestBaseUrl, 'preferences.binanceRestBaseUrl')
  const favoriteSymbols = arrayValue(
    item.favoriteSymbols,
    'preferences.favoriteSymbols',
  ).map((symbol, index) => {
    const result = stringValue(
      symbol,
      `preferences.favoriteSymbols[${index}]`,
    ).toUpperCase()
    if (!result.endsWith('USDT')) {
      throw new Error(`收藏交易对 ${result} 不是 USDT 交易对`)
    }
    return result
  })
  if (new Set(favoriteSymbols).size !== favoriteSymbols.length) {
    throw new Error('收藏交易对包含重复项')
  }
  return {
    binanceRestBaseUrl,
    favoriteSymbols,
    ...(item.pinnedPeriods === undefined ? {} : { pinnedPeriods: validatePinnedPeriods(item.pinnedPeriods) }),
    ...(item.selectedSymbol === undefined ? {} : { selectedSymbol: validateSelectedSymbol(item.selectedSymbol) }),
    ...(item.chartIndicators === undefined
      ? {}
      : {
          chartIndicators: validateChartIndicatorPreferences(
            item.chartIndicators,
            currentIndicators,
          ),
        }),
  }
}

function validateSymbol(value: unknown, index: number): MarketSymbol {
  const item = record(value, `symbols[${index}]`)
  const symbol = stringValue(item.symbol, `symbols[${index}].symbol`)
    .toUpperCase()
  if (
    !symbol.endsWith('USDT') ||
    item.quoteAsset !== 'USDT' ||
    item.contractType !== 'PERPETUAL'
  ) {
    throw new Error(`symbols[${index}] 不是 USDT 永续合约`)
  }
  if (item.status !== 'TRADING') {
    throw new Error(`symbols[${index}] 状态无效`)
  }
  return {
    symbol,
    baseAsset: stringValue(
      item.baseAsset,
      `symbols[${index}].baseAsset`,
    ),
    quoteAsset: 'USDT',
    contractType: 'PERPETUAL',
    status: 'TRADING',
    onboardDate: nonNegativeInteger(
      item.onboardDate,
      `symbols[${index}].onboardDate`,
    ),
    pricePrecision: nonNegativeInteger(
      item.pricePrecision,
      `symbols[${index}].pricePrecision`,
    ),
    quantityPrecision: nonNegativeInteger(
      item.quantityPrecision,
      `symbols[${index}].quantityPrecision`,
    ),
  }
}

function validateCandle(
  value: unknown,
  field: string,
): MarketCandle {
  const item = record(value, field)
  const symbol = stringValue(item.symbol, `${field}.symbol`).toUpperCase()
  const timeframe = stringValue(item.timeframe, `${field}.timeframe`)
  if (!symbol.endsWith('USDT')) {
    throw new Error(`${field}.symbol 不是 USDT 交易对`)
  }
  if (!SUPPORTED_TIMEFRAMES.includes(timeframe)) {
    throw new Error(`${field}.timeframe 不受支持`)
  }
  const openTime = nonNegativeInteger(item.openTime, `${field}.openTime`)
  const closeTime = nonNegativeInteger(item.closeTime, `${field}.closeTime`)
  const open = decimalValue(item.open, `${field}.open`, false)
  const high = decimalValue(item.high, `${field}.high`, false)
  const low = decimalValue(item.low, `${field}.low`, false)
  const close = decimalValue(item.close, `${field}.close`, false)
  if (
    closeTime < openTime ||
    Number(high) < Math.max(Number(open), Number(close)) ||
    Number(low) > Math.min(Number(open), Number(close)) ||
    Number(high) < Number(low)
  ) {
    throw new Error(`${field} 的时间或 OHLC 关系无效`)
  }
  if (item.source !== 'binance') {
    throw new Error(`${field}.source 无效`)
  }
  return {
    symbol,
    timeframe,
    openTime,
    closeTime,
    open,
    high,
    low,
    close,
    volume: decimalValue(item.volume, `${field}.volume`, false),
    quoteVolume: decimalValue(
      item.quoteVolume,
      `${field}.quoteVolume`,
      false,
    ),
    tradeCount: nonNegativeInteger(item.tradeCount, `${field}.tradeCount`),
    isClosed: booleanValue(item.isClosed, `${field}.isClosed`),
    source: 'binance',
  }
}

function validateCandles(
  value: unknown,
  field: string,
): MarketCandle[] {
  const seen = new Set<string>()
  const lastBySeries = new Map<string, number>()
  return arrayValue(value, field).map((item, index) => {
    const candle = validateCandle(item, `${field}[${index}]`)
    const series = `${candle.symbol}:${candle.timeframe}`
    const key = `${series}:${candle.openTime}`
    if (seen.has(key)) {
      throw new Error(`${field} 包含重复 K 线：${key}`)
    }
    const last = lastBySeries.get(series)
    if (last !== undefined && candle.openTime <= last) {
      throw new Error(`${field} 的 ${series} 时间顺序无效`)
    }
    seen.add(key)
    lastBySeries.set(series, candle.openTime)
    return candle
  })
}

function validateSession(value: unknown, index: number): ReplaySession {
  const field = `sessions[${index}]`
  const item = record(value, field)
  if (item.schemaVersion !== 2) {
    throw new Error(`${field}.schemaVersion 不受支持`)
  }
  const symbol = record(item.symbol, `${field}.symbol`)
  const period = record(item.period, `${field}.period`)
  const ticker = stringValue(symbol.ticker, `${field}.symbol.ticker`)
    .toUpperCase()
  const timeframe = stringValue(period.text, `${field}.period.text`)
  if (!ticker.endsWith('USDT') || !SUPPORTED_TIMEFRAMES.includes(timeframe)) {
    throw new Error(`${field} 的交易对或周期无效`)
  }
  const startTime = finiteNumber(item.startTime, `${field}.startTime`)
  const endTime = finiteNumber(item.endTime, `${field}.endTime`)
  const currentTime = finiteNumber(item.currentTime, `${field}.currentTime`)
  const currentIndex = finiteNumber(item.currentIndex, `${field}.currentIndex`)
  const candleCount = finiteNumber(item.candleCount, `${field}.candleCount`)
  if (
    startTime > currentTime ||
    currentTime > endTime ||
    !Number.isInteger(currentIndex) ||
    !Number.isInteger(candleCount) ||
    currentIndex < 0 ||
    candleCount <= currentIndex
  ) {
    throw new Error(`${field} 的回放时间或索引无效`)
  }
  const tradingConfig = record(
    item.tradingConfig,
    `${field}.tradingConfig`,
  )
  const config = {
    initialBalance: decimalValue(
      tradingConfig.initialBalance,
      `${field}.tradingConfig.initialBalance`,
      false,
    ),
    leverage: finiteNumber(
      tradingConfig.leverage,
      `${field}.tradingConfig.leverage`,
    ),
    feeRate: decimalValue(
      tradingConfig.feeRate,
      `${field}.tradingConfig.feeRate`,
      false,
    ),
    slippageRate: decimalValue(
      tradingConfig.slippageRate,
      `${field}.tradingConfig.slippageRate`,
      false,
    ),
    maintenanceMarginRate: decimalValue(
      tradingConfig.maintenanceMarginRate,
      `${field}.tradingConfig.maintenanceMarginRate`,
      false,
    ),
    liquidationFeeRate: decimalValue(
      tradingConfig.liquidationFeeRate,
      `${field}.tradingConfig.liquidationFeeRate`,
      false,
    ),
  }
  validateSimulationConfig(config)
  if (
    ![1, 2, 5, 10].includes(Number(item.speed)) ||
    !['paused', 'completed'].includes(String(item.status))
  ) {
    throw new Error(`${field} 的速度或状态无效`)
  }
  return {
    ...(structuredClone(item) as unknown as ReplaySession),
    id: stringValue(item.id, `${field}.id`),
    schemaVersion: 2,
    symbol: {
      ...(symbol as unknown as ReplaySession['symbol']),
      ticker,
    },
    period: {
      ...(period as unknown as ReplaySession['period']),
      text: timeframe,
    },
    startTime,
    endTime,
    currentTime,
    currentIndex,
    candleCount,
    speed: Number(item.speed) as ReplaySession['speed'],
    status: String(item.status) as ReplaySession['status'],
    hasTrades: booleanValue(item.hasTrades, `${field}.hasTrades`),
    active: booleanValue(item.active, `${field}.active`),
    tradingConfig: config,
    createdAt: finiteNumber(item.createdAt, `${field}.createdAt`),
    updatedAt: finiteNumber(item.updatedAt, `${field}.updatedAt`),
  }
}

const ACCOUNT_DECIMALS = [
  'initialBalance',
  'walletBalance',
  'equity',
  'availableBalance',
  'usedMargin',
  'realizedPnl',
  'unrealizedPnl',
  'totalFees',
  'totalLiquidationFees',
] as const

function validateTrade(
  value: unknown,
  field: string,
  sessionId: string,
): SimulationTrade {
  const item = record(value, field)
  if (item.sessionId !== sessionId) {
    throw new Error(`${field}.sessionId 不匹配`)
  }
  const action = stringValue(item.action, `${field}.action`)
  if (
    ![
      'open',
      'add',
      'reduce',
      'close',
      'take_profit',
      'stop_loss',
      'liquidation',
    ].includes(action)
  ) {
    throw new Error(`${field}.action 无效`)
  }
  for (const name of [
    'quantity',
    'price',
    'notional',
    'fee',
    'liquidationFee',
    'slippage',
    'realizedPnl',
  ]) {
    decimalValue(item[name], `${field}.${name}`)
  }
  finiteNumber(item.timestamp, `${field}.timestamp`)
  stringValue(item.tradeId, `${field}.tradeId`)
  stringValue(item.symbol, `${field}.symbol`)
  if (!['buy', 'sell'].includes(String(item.side))) {
    throw new Error(`${field}.side 无效`)
  }
  if (!['long', 'short'].includes(String(item.positionSide))) {
    throw new Error(`${field}.positionSide 无效`)
  }
  if (
    !['manual', 'take_profit', 'stop_loss', 'liquidation'].includes(
      String(item.reason),
    )
  ) {
    throw new Error(`${field}.reason 无效`)
  }
  return structuredClone(item) as unknown as SimulationTrade
}

function validateLedger(
  value: unknown,
  field: string,
  sessionId: string,
): SimulationLedgerEntry {
  const item = record(value, field)
  if (item.sessionId !== sessionId) {
    throw new Error(`${field}.sessionId 不匹配`)
  }
  stringValue(item.entryId, `${field}.entryId`)
  finiteNumber(item.timestamp, `${field}.timestamp`)
  decimalValue(item.amount, `${field}.amount`)
  decimalValue(item.balanceAfter, `${field}.balanceAfter`)
  if (
    ![
      'initial_balance',
      'trading_fee',
      'realized_pnl',
      'liquidation_fee',
    ].includes(String(item.type))
  ) {
    throw new Error(`${field}.type 无效`)
  }
  if (item.tradeId !== null && typeof item.tradeId !== 'string') {
    throw new Error(`${field}.tradeId 无效`)
  }
  return structuredClone(item) as unknown as SimulationLedgerEntry
}

function validateSimulation(
  value: unknown,
  index: number,
): SimulationState {
  const field = `simulations[${index}]`
  const item = record(value, field)
  if (item.schemaVersion !== 1) {
    throw new Error(`${field}.schemaVersion 不受支持`)
  }
  const sessionId = stringValue(item.sessionId, `${field}.sessionId`)
  stringValue(item.symbol, `${field}.symbol`)
  const account = record(item.account, `${field}.account`)
  ACCOUNT_DECIMALS.forEach((name) =>
    decimalValue(account[name], `${field}.account.${name}`),
  )
  const config = record(item.config, `${field}.config`)
  validateSimulationConfig({
    initialBalance: decimalValue(
      config.initialBalance,
      `${field}.config.initialBalance`,
      false,
    ),
    leverage: finiteNumber(config.leverage, `${field}.config.leverage`),
    feeRate: decimalValue(
      config.feeRate,
      `${field}.config.feeRate`,
      false,
    ),
    slippageRate: decimalValue(
      config.slippageRate,
      `${field}.config.slippageRate`,
      false,
    ),
    maintenanceMarginRate: decimalValue(
      config.maintenanceMarginRate,
      `${field}.config.maintenanceMarginRate`,
      false,
    ),
    liquidationFeeRate: decimalValue(
      config.liquidationFeeRate,
      `${field}.config.liquidationFeeRate`,
      false,
    ),
  })
  const trades = arrayValue(item.trades, `${field}.trades`).map(
    (trade, tradeIndex) =>
      validateTrade(trade, `${field}.trades[${tradeIndex}]`, sessionId),
  )
  const ledger = arrayValue(item.ledger, `${field}.ledger`).map(
    (entry, entryIndex) =>
      validateLedger(entry, `${field}.ledger[${entryIndex}]`, sessionId),
  )
  if (
    new Set(trades.map((trade) => trade.tradeId)).size !== trades.length ||
    new Set(ledger.map((entry) => entry.entryId)).size !== ledger.length
  ) {
    throw new Error(`${field} 包含重复成交或流水`)
  }
  const stats = record(item.stats, `${field}.stats`)
  for (const name of [
    'totalReturn',
    'totalReturnRate',
    'winRate',
    'largestWin',
    'largestLoss',
  ]) {
    decimalValue(stats[name], `${field}.stats.${name}`)
  }
  for (const name of [
    'totalTrades',
    'completedPositions',
    'wins',
    'losses',
    'liquidations',
  ]) {
    nonNegativeInteger(stats[name], `${field}.stats.${name}`)
  }
  if (item.position !== null) {
    const position = record(item.position, `${field}.position`)
    if (position.symbol !== item.symbol) {
      throw new Error(`${field}.position.symbol 不匹配`)
    }
    for (const name of [
      'quantity',
      'entryPrice',
      'notional',
      'isolatedMargin',
      'maintenanceMarginRate',
      'liquidationPrice',
    ]) {
      decimalValue(position[name], `${field}.position.${name}`, false)
    }
    if (position.lastPrice !== undefined) {
      decimalValue(
        position.lastPrice,
        `${field}.position.lastPrice`,
        false,
      )
    }
    if (position.markPrice !== undefined) {
      decimalValue(position.markPrice, `${field}.position.markPrice`, false)
    }
    if (position.lastPrice === undefined && position.markPrice === undefined) {
      throw new Error(`${field}.position.lastPrice 缺失`)
    }
    decimalValue(
      position.unrealizedPnl,
      `${field}.position.unrealizedPnl`,
    )
    for (const name of ['takeProfitPrice', 'stopLossPrice']) {
      if (position[name] !== null) {
        decimalValue(position[name], `${field}.position.${name}`, false)
      }
    }
    const leverage = nonNegativeInteger(
      position.leverage,
      `${field}.position.leverage`,
    )
    if (leverage === 0) {
      throw new Error(`${field}.position.leverage 必须大于 0`)
    }
    for (const name of [
      'openedAt',
      'updatedAt',
      'riskActiveAfterTime',
    ]) {
      nonNegativeInteger(position[name], `${field}.position.${name}`)
    }
    for (const name of [
      'takeProfitActiveAfterTime',
      'stopLossActiveAfterTime',
    ]) {
      if (position[name] !== null) {
        nonNegativeInteger(position[name], `${field}.position.${name}`)
      }
    }
    if (!['long', 'short'].includes(String(position.side))) {
      throw new Error(`${field}.position.side 无效`)
    }
  }
  if (item.warning !== null && typeof item.warning !== 'string') {
    throw new Error(`${field}.warning 必须是字符串或 null`)
  }
  nonNegativeInteger(item.updatedAt, `${field}.updatedAt`)
  return normalizeSimulationStatePrices({
    ...(structuredClone(item) as unknown as SimulationState),
    trades,
    ledger,
  })
}

export function validateBackupEnvelope(value: unknown, currentIndicators?: ChartIndicatorPreferences | null): BackupEnvelope {
  const root = record(value, '备份文件')
  if (root.fileType !== BACKUP_FILE_TYPE) {
    throw new Error('文件类型不是本应用备份')
  }
  if (root.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`不支持的备份 Schema：${String(root.schemaVersion)}`)
  }
  if (
    !['preferences', 'market-data', 'session', 'all'].includes(
      String(root.kind),
    )
  ) {
    throw new Error('备份类型无效')
  }
  const kind = root.kind as BackupKind
  const source = record(root.data, 'data')
  const data: BackupData = {}
  if (source.preferences !== undefined) {
    data.preferences = validatePreferences(source.preferences, currentIndicators)
  }
  if (source.symbols !== undefined) {
    const symbols = arrayValue(source.symbols, 'symbols').map(validateSymbol)
    if (new Set(symbols.map((item) => item.symbol)).size !== symbols.length) {
      throw new Error('symbols 包含重复交易对')
    }
    data.symbols = symbols
  }
  if (source.tradeCandles !== undefined) {
    data.tradeCandles = validateCandles(
      source.tradeCandles,
      'tradeCandles',
    )
  }
  if (source.markCandles !== undefined) {
    validateCandles(
      source.markCandles,
      'markCandles',
    )
  }
  if (source.sessions !== undefined) {
    const sessions = arrayValue(source.sessions, 'sessions').map(
      validateSession,
    )
    if (new Set(sessions.map((item) => item.id)).size !== sessions.length) {
      throw new Error('sessions 包含重复会话')
    }
    data.sessions = sessions
  }
  if (source.simulations !== undefined) {
    const simulations = arrayValue(
      source.simulations,
      'simulations',
    ).map(validateSimulation)
    if (
      new Set(simulations.map((item) => item.sessionId)).size !==
      simulations.length
    ) {
      throw new Error('simulations 包含重复会话')
    }
    data.simulations = simulations
  }
  const required: Record<BackupKind, Array<keyof BackupData>> = {
    preferences: ['preferences'],
    'market-data': ['symbols', 'tradeCandles'],
    session: ['sessions'],
    all: [
      'preferences',
      'symbols',
      'tradeCandles',
      'sessions',
      'simulations',
    ],
  }
  for (const field of required[kind]) {
    if (data[field] === undefined) {
      throw new Error(`${kind} 备份缺少 ${field}`)
    }
  }
  const sessionIds = new Set((data.sessions ?? []).map((item) => item.id))
  for (const simulation of data.simulations ?? []) {
    if (!sessionIds.has(simulation.sessionId)) {
      throw new Error(
        `模拟状态 ${simulation.sessionId} 缺少对应回放会话`,
      )
    }
  }
  return {
    fileType: BACKUP_FILE_TYPE,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    kind,
    exportedAt: finiteNumber(root.exportedAt, 'exportedAt'),
    data,
  }
}

function defaultPreferences(storage: StorageLike): BackupPreferences {
  const favoriteSymbols = readFavoriteSymbols(storage)
  const chartIndicators = loadChartIndicatorPreferences(storage)
  const selectedSymbol = readSelectedSymbol(storage)
  return {
    binanceRestBaseUrl:
      storage.getItem(BASE_URL_PREFERENCE) ?? 'https://fapi.binance.com',
    favoriteSymbols,
    pinnedPeriods: readPinnedPeriods(storage),
    ...(selectedSymbol === null ? {} : { selectedSymbol }),
    ...(chartIndicators === null ? {} : { chartIndicators }),
  }
}

export class WorkstationBackupService {
  private readonly simulations: IndexedDbSimulationStateStore

  constructor(
    private readonly databaseName?: string,
    private readonly storage: StorageLike = localStorage,
    private readonly now: () => number = Date.now,
  ) {
    this.simulations = new IndexedDbSimulationStateStore(databaseName)
  }

  async exportPreferences(): Promise<BackupEnvelope> {
    return this.envelope('preferences', {
      preferences: defaultPreferences(this.storage),
    })
  }

  async exportMarketData(
    symbol?: string,
    timeframe?: string,
  ): Promise<BackupEnvelope> {
    const database = await openWorkstationDatabase(this.databaseName)
    const symbols = await database.getAll('symbols')
    let tradeCandles = await database.getAll('tradeCandles')
    if (symbol !== undefined && timeframe !== undefined) {
      const normalized = symbol.toUpperCase()
      tradeCandles = tradeCandles.filter(
        (item) =>
          item.symbol === normalized && item.timeframe === timeframe,
      )
    }
    return this.envelope('market-data', {
      symbols,
      tradeCandles: this.sortCandles(tradeCandles),
    })
  }

  async exportSession(sessionId: string): Promise<BackupEnvelope> {
    const database = await openWorkstationDatabase(this.databaseName)
    const session = await database.get('replaySessions', sessionId)
    if (session === undefined) {
      throw new Error('找不到要导出的回放会话')
    }
    const simulation = await this.simulations.load(sessionId)
    return this.envelope('session', {
      sessions: [session],
      simulations: simulation === undefined ? [] : [normalizeSimulationStatePrices(simulation)],
    })
  }

  async exportAll(): Promise<BackupEnvelope> {
    const database = await openWorkstationDatabase(this.databaseName)
    const [
      symbols,
      tradeCandles,
      sessions,
      stateRows,
    ] = await Promise.all([
      database.getAll('symbols'),
      database.getAll('tradeCandles'),
      database.getAll('replaySessions'),
      database.getAll('simulationStates'),
    ])
    const simulations = (
      await Promise.all(
        stateRows.map((state) => this.simulations.load(state.sessionId)),
      )
    ).filter((state): state is SimulationState => state !== undefined)
    return this.envelope('all', {
      preferences: defaultPreferences(this.storage),
      symbols,
      tradeCandles: this.sortCandles(tradeCandles),
      sessions: sessions.sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      simulations: simulations.map(normalizeSimulationStatePrices).sort((left, right) =>
        left.sessionId.localeCompare(right.sessionId),
      ),
    })
  }

  async import(value: unknown, onProgress?: (message: string) => void): Promise<BackupImportReport> {
    onProgress?.('正在校验备份数据…')
    const envelope = validateBackupEnvelope(value, loadChartIndicatorPreferences(this.storage))
    const candleCount = envelope.data.tradeCandles?.length ?? 0
    onProgress?.(`正在恢复行情：${candleCount.toLocaleString()} 根…`)
    const database = await openWorkstationDatabase(this.databaseName)
    const transaction = database.transaction(
      [
        'symbols',
        'tradeCandles',
        'replaySessions',
        'simulationStates',
        'simulationTrades',
        'simulationLedger',
      ],
      'readwrite',
    )
    // Native requests share one atomic transaction without allocating a promise
    // and JS completion handlers for every minute in a multi-month restore.
    try {
      const candleKey = (row: MarketCandle) => `${row.symbol}:${row.timeframe}:${row.openTime}`
      const readExisting = async (name: 'tradeCandles', rows: readonly MarketCandle[]) => {
        const ranges = new Map<string, {symbol:string;timeframe:string;from:number;to:number}>()
        for (const row of rows) {
          const key = `${row.symbol}:${row.timeframe}`
          const range = ranges.get(key)
          if (range) { range.from = Math.min(range.from,row.openTime); range.to = Math.max(range.to,row.openTime) }
          else ranges.set(key,{symbol:row.symbol,timeframe:row.timeframe,from:row.openTime,to:row.openTime})
        }
        const existing = new Map<string,MarketCandle>()
        const groups = await Promise.all([...ranges.values()].map(range =>
          transaction.objectStore(name).index('by-series-time').getAll(IDBKeyRange.bound(
            [range.symbol,range.timeframe,range.from], [range.symbol,range.timeframe,range.to],
          )),
        ))
        for (const group of groups) for (const row of group) existing.set(candleKey(row),row)
        return existing
      }
      // Read in this same transaction, so a concurrent write cannot invalidate
      // the comparison. Imported ranges do not scan unrelated market series.
      const tradeExisting = await readExisting('tradeCandles',envelope.data.tradeCandles ?? [])
      const changed = (row: MarketCandle, existing: Map<string,MarketCandle>) => {
        const prior = existing.get(candleKey(row))
        return prior === undefined || (Object.keys(row) as Array<keyof MarketCandle>).some(field => prior[field] !== row[field])
      }
      const native = unwrap(transaction)
      for (const symbol of envelope.data.symbols ?? []) {
        native.objectStore('symbols').put(symbol)
      }
      for (const candle of envelope.data.tradeCandles ?? []) {
        if (changed(candle,tradeExisting)) native.objectStore('tradeCandles').put(candle)
      }
      for (const session of envelope.data.sessions ?? []) {
        native.objectStore('replaySessions').put(session)
      }
      for (const state of envelope.data.simulations ?? []) {
        onProgress?.('正在恢复会话与交易…')
        await this.replaceSimulation(transaction, state)
      }
      await transaction.done
    } catch (error) {
      try { transaction.abort() } catch { /* An asynchronous failure may already have aborted. */ }
      await transaction.done.catch(() => undefined)
      throw error
    }
    if (envelope.data.preferences !== undefined) {
      onProgress?.('正在应用恢复的配置…')
      this.storage.setItem(
        BASE_URL_PREFERENCE,
        envelope.data.preferences.binanceRestBaseUrl,
      )
      this.storage.setItem(
        FAVORITES_PREFERENCE,
        JSON.stringify(envelope.data.preferences.favoriteSymbols),
      )
      if (envelope.data.preferences.chartIndicators !== undefined) {
        this.storage.setItem(
          CHART_INDICATORS_PREFERENCE,
          JSON.stringify(envelope.data.preferences.chartIndicators),
        )
      }
      if (envelope.data.preferences.selectedSymbol !== undefined) {
        this.storage.setItem(SELECTED_SYMBOL_STORAGE_KEY, JSON.stringify(envelope.data.preferences.selectedSymbol))
      }
      if (envelope.data.preferences.pinnedPeriods !== undefined) {
        this.storage.setItem(PINNED_PERIODS_KEY, JSON.stringify(envelope.data.preferences.pinnedPeriods))
      }
    }
    return {
      kind: envelope.kind,
      symbols: envelope.data.symbols?.length ?? 0,
      tradeCandles: envelope.data.tradeCandles?.length ?? 0,
      markCandles: 0,
      sessions: envelope.data.sessions?.length ?? 0,
      simulations: envelope.data.simulations?.length ?? 0,
      preferences: envelope.data.preferences !== undefined,
    }
  }

  private envelope(kind: BackupKind, data: BackupData): BackupEnvelope {
    return {
      fileType: BACKUP_FILE_TYPE,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind,
      exportedAt: this.now(),
      data,
    }
  }

  private sortCandles(candles: MarketCandle[]): MarketCandle[] {
    return candles.sort(
      (left, right) =>
        left.symbol.localeCompare(right.symbol) ||
        left.timeframe.localeCompare(right.timeframe) ||
        left.openTime - right.openTime,
    )
  }

  private async replaceSimulation(
    transaction: IDBPTransaction<
      WorkstationDatabase,
      BackupStoreName[],
      'readwrite'
    >,
    state: SimulationState,
  ): Promise<void> {
    const min = Number.MIN_SAFE_INTEGER
    const max = Number.MAX_SAFE_INTEGER
    const range = IDBKeyRange.bound(
      [state.sessionId, min],
      [state.sessionId, max],
    )
    const trades = transaction.objectStore('simulationTrades')
    const ledger = transaction.objectStore('simulationLedger')
    let tradeCursor = await trades.index('by-session-time').openCursor(range)
    while (tradeCursor !== null) {
      await tradeCursor.delete()
      tradeCursor = await tradeCursor.continue()
    }
    let ledgerCursor = await ledger.index('by-session-time').openCursor(range)
    while (ledgerCursor !== null) {
      await ledgerCursor.delete()
      ledgerCursor = await ledgerCursor.continue()
    }
    await transaction.objectStore('simulationStates').put({
      ...state,
      trades: [],
      ledger: [],
    })
    for (const [index, trade] of state.trades.entries()) {
      await trades.put({ ...trade, _sequence: index })
    }
    for (const [index, entry] of state.ledger.entries()) {
      await ledger.put({ ...entry, _sequence: index })
    }
  }
}
