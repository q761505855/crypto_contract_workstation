import Decimal from 'decimal.js'
import { validateDrawings, type ChartDrawing, type DrawingStore } from '../chart/drawings'
import {
  CANDLE_TRANSPARENCY_KEY, readCandleTransparency, validateCandleTransparency,
  CANDLE_TYPE_KEY, readCandleType, validateCandleType, type ChartCandleType,
} from '../chart/candle-preferences'
import { SHOW_CANDLE_HOVER_DETAILS_KEY, readShowCandleHoverDetails, validateShowCandleHoverDetails } from '../chart/candle-hover-preferences'
import { readShowTradeOverlays, SHOW_TRADE_OVERLAYS_KEY, validateShowTradeOverlays } from '../chart/trade-overlay-preferences'
import { CHART_WINDOW_SIZE_KEY, readChartWindowSize, validateChartWindowSize, type ChartWindowSize } from '../chart/chart-window-preferences'
import { CONFIG_PENDING_KEY, preferencesRestored } from './preference-events'
import { CTRADER_TIMEFRAMES, klineCloseBoundary, nextOpenTime, SUPPORTED_TIMEFRAMES } from '../market-data/intervals'
import { PINNED_PERIODS_KEY, readPinnedPeriods, validatePinnedPeriods } from '../chart/period-preferences'
import {
  loadWorkspacePreferences,
  WORKSPACE_PREFERENCES_KEY,
  validateWorkspacePreferences,
  type WorkspacePreferences,
} from '../workspace/preferences'
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
  validateFavoriteSymbols,
} from '../market-data/favorites'
import {
  SELECTED_SYMBOL_STORAGE_KEY,
  OKX_SYMBOL_STORAGE_KEY,
  DATABENTO_SYMBOL_STORAGE_KEY,
  readSelectedSymbol,
  readSelectedOkxSymbol,
  readSelectedDatabentoSymbol,
  validateSelectedSymbol,
  validateSelectedOkxSymbol,
  validateSelectedDatabentoSymbol,
  validateDatabentoReplaySymbol,
} from '../market-data/symbol-preferences'
import type { SymbolInfo } from '@klinecharts/pro'
import type {
  MarketCandle,
  MarketSymbol,
} from '../market-data/models'
import { isTickSpeed, replaySourceTimeframe, validateReplayDetails, type ReplaySession } from '../replay/models'
import { bybitDayStart } from '../market-data/bybit/trades'
import { REPLAY_STEP_PERIOD_KEY, readReplayStepPeriod, validateReplayStepPeriod } from '../replay/step-preferences'
import { isCTraderReplayStepPeriod, isFineStepPeriod, SECOND_STEP_MS, type ReplayStepPeriod } from '../replay/step-periods'
import { validateSimulationConfig } from '../simulation/simulation-engine'
import { sameCTraderTradingTerms, validateCTraderTradingTerms } from '../simulation/ctrader-trading'
import { sameOkxTradingTerms, validateOkxTradingTerms } from '../simulation/okx-trading'
import { validateCmeFeePerContractSide } from '../simulation/cme-fees'
import type {
  SimulationLedgerEntry,
  SimulationState,
  StoredSimulationState,
  SimulationTrade,
} from '../simulation/models'
import { normalizeSimulationStatePrices } from '../simulation/models'
import {
  openWorkstationDatabase,
  type WorkstationDatabase,
} from './market-data-store'
import { IndexedDbSimulationStateStore } from './simulation-state-store'
import { ctraderStorage } from './ctrader-storage'
import { CTRADER_ACCOUNT_KEY, readCTraderAccount, validateCTraderAccount } from '../market-data/ctrader-account-preferences'
import { CTRADER_PERIODS } from '../chart/chart-config'
import { isLocalPriceSource, isOkxPriceSource, isPriceSource, PRICE_SOURCE_KEY, readPriceSource, validatePriceSource, type PriceSource } from '../market-data/price-source-preferences'

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
  candleType?: ChartCandleType
  candleTransparency?: number
  showCandleHoverDetails?: boolean
  binanceRestBaseUrl: string
  favoriteSymbols: string[]
  selectedSymbol?: SymbolInfo
  okxSelectedSymbol?: SymbolInfo
  databentoSelectedSymbol?: string
  ctraderAccount?: string
  priceSource?: PriceSource
  chartIndicators?: ChartIndicatorPreferences
  pinnedPeriods?: string[]
  replayStepPeriod?: ReplayStepPeriod
  showTradeOverlays?: boolean
  chartWindowSize?: ChartWindowSize
  workspace?: WorkspacePreferences
}

export interface BackupData {
  drawings?: ChartDrawing[]
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
  const favoriteSymbols = validateFavoriteSymbols(item.favoriteSymbols)
  return {
    binanceRestBaseUrl,
    favoriteSymbols,
    ...(item.candleType === undefined ? {} : { candleType: validateCandleType(item.candleType) }),
    ...(item.candleTransparency === undefined ? {} : { candleTransparency: validateCandleTransparency(item.candleTransparency) }),
    ...(item.showCandleHoverDetails === undefined ? {} : { showCandleHoverDetails: validateShowCandleHoverDetails(item.showCandleHoverDetails) }),
    ...(item.pinnedPeriods === undefined ? {} : { pinnedPeriods: validatePinnedPeriods(item.pinnedPeriods) }),
    ...(item.replayStepPeriod === undefined ? {} : { replayStepPeriod: validateReplayStepPeriod(item.replayStepPeriod) }),
    ...(item.showTradeOverlays === undefined ? {} : { showTradeOverlays: validateShowTradeOverlays(item.showTradeOverlays) }),
    ...(item.chartWindowSize === undefined ? {} : { chartWindowSize: validateChartWindowSize(item.chartWindowSize) }),
    ...(item.workspace === undefined ? {} : { workspace: validateWorkspacePreferences(item.workspace) }),
    ...(item.selectedSymbol === undefined ? {} : { selectedSymbol: validateSelectedSymbol(item.selectedSymbol) }),
    ...(item.ctraderAccount === undefined ? {} : { ctraderAccount: validateCTraderAccount(item.ctraderAccount) }),
    ...(item.priceSource === undefined ? {} : { priceSource: validatePriceSource(item.priceSource) }),
    ...(item.okxSelectedSymbol === undefined ? {} : { okxSelectedSymbol: validateSelectedOkxSymbol(item.okxSelectedSymbol) }),
    ...(item.databentoSelectedSymbol === undefined ? {} : { databentoSelectedSymbol: validateSelectedDatabentoSymbol(item.databentoSelectedSymbol) }),
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
  const marketSource = item.marketSource
  const okxSource = isOkxPriceSource(marketSource)
  if (marketSource !== undefined && marketSource !== 'binance' && !isPriceSource(marketSource)) {
    throw new Error(`${field}.marketSource 无效`)
  }
  const native = isPriceSource(marketSource)
  const details = validateReplayDetails(item.name, item.notes)
  const archiveDays = item.archiveDays
  if (archiveDays !== undefined) {
    if (!isLocalPriceSource(marketSource) || !Array.isArray(archiveDays) || !archiveDays.length ||
        new Set(archiveDays).size !== archiveDays.length || archiveDays.some(day => {
          if (typeof day !== 'string') return true
          try { bybitDayStart(day); return false } catch { return true }
        })) throw new Error(`${field}.archiveDays 必须包含不重复的有效本地日档日期`)
  }
  const cmeSource = marketSource === 'databento-cme'
  const nativeSymbol = cmeSource
    ? validateDatabentoReplaySymbol(symbol)
    : okxSource ? validateSelectedOkxSymbol(symbol) : native ? validateSelectedSymbol(symbol) : undefined
  if (native ? nativeSymbol?.exchange !== (cmeSource ? 'CME' : okxSource ? 'OKX' : 'CTRADER') || !CTRADER_TIMEFRAMES.some(period => period === timeframe)
    : !ticker.endsWith('USDT') || !SUPPORTED_TIMEFRAMES.includes(timeframe)) {
    throw new Error(`${field} 的交易对或周期无效`)
  }
  const cursorPeriod = typeof item.cursorTimeframe === 'string' && isCTraderReplayStepPeriod(item.cursorTimeframe)
    ? item.cursorTimeframe : undefined
  if ((native && cursorPeriod === undefined) || (!native && item.cursorTimeframe !== undefined)) {
    throw new Error(`${field}.cursorTimeframe 无效`)
  }
  const playbackMode = item.playbackMode
  if (playbackMode !== undefined && (!native || (playbackMode !== 'kline' && playbackMode !== 'tick'))) {
    throw new Error(`${field}.playbackMode 无效`)
  }
  const tickSpeed = item.tickSpeed
  if (tickSpeed !== undefined && (!native || !isTickSpeed(tickSpeed))) {
    throw new Error(`${field}.tickSpeed 无效`)
  }
  const cursorTickIndex = item.cursorTickIndex === undefined ? undefined : nonNegativeInteger(item.cursorTickIndex, `${field}.cursorTickIndex`)
  if ((cursorPeriod === 'tick') !== (cursorTickIndex !== undefined) ||
    (cursorTickIndex !== undefined && !Number.isSafeInteger(cursorTickIndex))) {
    throw new Error(`${field}.cursorTickIndex 无效`)
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
  const visibleUntil = item.visibleUntil === undefined ? undefined : finiteNumber(item.visibleUntil, `${field}.visibleUntil`)
  if (cursorPeriod !== undefined) {
    const configuredPeriod = CTRADER_PERIODS.find(candidate => candidate.text === timeframe)
    if (configuredPeriod?.multiplier !== period.multiplier || configuredPeriod?.timespan !== period.timespan) {
      throw new Error(`${field}.period 的周期规格无效`)
    }
    const fine = isFineStepPeriod(cursorPeriod)
    const width = cursorPeriod === 'tick' ? 1 : fine ? SECOND_STEP_MS[cursorPeriod] : 60_000
    if (![startTime, currentTime, endTime].every(time => Number.isSafeInteger(time) && time >= 0) ||
      startTime % 60_000 !== 0 || currentTime % width !== 0 ||
      (fine && currentTime < nextOpenTime(startTime, timeframe)) ||
      visibleUntil !== (fine ? currentTime + width : nextOpenTime(currentTime, cursorPeriod)) ||
      visibleUntil === undefined || visibleUntil <= currentTime || visibleUntil > endTime + 1) {
      throw new Error(`${field}.visibleUntil 的回放进度无效`)
    }
  } else if (visibleUntil !== undefined) {
    const source = replaySourceTimeframe({ period: { ...period, text: timeframe } as ReplaySession['period'], startTime })
    const sourceClose = klineCloseBoundary(currentTime, source)
    const nextClose = klineCloseBoundary(nextOpenTime(currentTime, source), source)
    if (visibleUntil % 60_000 !== 0 || visibleUntil < sourceClose || visibleUntil >= nextClose ||
      visibleUntil > klineCloseBoundary(endTime, source)) {
      throw new Error(`${field}.visibleUntil 的回放进度无效`)
    }
  }
  const tradingConfig = record(
    item.tradingConfig,
    `${field}.tradingConfig`,
  )
  const ctrader = tradingConfig.ctrader
  const okx = tradingConfig.okx
  const cmeFeePerContractSide = tradingConfig.cmeFeePerContractSide
  validateCmeFeePerContractSide(cmeFeePerContractSide)
  if (cmeFeePerContractSide !== undefined && !cmeSource) throw new Error('CME 手续费要求 Databento-CME 会话')
  if (okxSource) validateOkxTradingTerms(okx)
  else if (okx !== undefined) throw new Error(`${field}.tradingConfig.okx 要求 OKX 会话`)
  if (ctrader !== undefined) {
    if (marketSource !== 'ctrader') throw new Error(`${field}.tradingConfig.ctrader 要求 cTrader 会话`)
    validateCTraderTradingTerms(ctrader)
  }
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
    ...(ctrader === undefined ? {} : { ctrader }),
    ...(okx === undefined ? {} : { okx }),
    ...(cmeFeePerContractSide === undefined ? {} : { cmeFeePerContractSide }),
  }
  validateSimulationConfig(config)
  if (
    ![1, 2, 5, 10].includes(Number(item.speed)) ||
    !['paused', 'completed'].includes(String(item.status))
  ) {
    throw new Error(`${field} 的速度或状态无效`)
  }
  return {
    id: stringValue(item.id, `${field}.id`),
    schemaVersion: 2,
    ...details,
    ...(archiveDays === undefined ? {} : { archiveDays: [...archiveDays].sort() }),
    ...(marketSource === undefined ? {} : { marketSource }),
    ...(cursorPeriod === undefined ? {} : { cursorTimeframe: cursorPeriod }),
    ...(cursorTickIndex === undefined ? {} : { cursorTickIndex }),
    ...(playbackMode === undefined ? {} : { playbackMode }),
    ...(tickSpeed === undefined ? {} : { tickSpeed }),
    ...(visibleUntil === undefined ? {} : { visibleUntil }),
    symbol: nativeSymbol ?? {
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
  const amount = decimalValue(item.amount, `${field}.amount`)
  const balance = decimalValue(item.balanceAfter, `${field}.balanceAfter`)
  if (
    ![
      'initial_balance',
      'trading_fee',
      'realized_pnl',
      'liquidation_fee',
      'swap',
      'funding',
      'balance_adjustment',
    ].includes(String(item.type))
  ) {
    throw new Error(`${field}.type 无效`)
  }
  if (item.tradeId !== null && typeof item.tradeId !== 'string') {
    throw new Error(`${field}.tradeId 无效`)
  }
  if (item.type === 'balance_adjustment' &&
      (new Decimal(amount).isZero() || new Decimal(balance).lt(0) || item.tradeId !== null)) {
    throw new Error(`${field} 的余额调整无效`)
  }
  return structuredClone(item) as unknown as SimulationLedgerEntry
}

function validateSimulation(
  value: unknown,
  index: number,
): SimulationState {
  const field = `simulations[${index}]`
  const item = record(value, field)
  if (item.schemaVersion !== 1 && item.schemaVersion !== 2) {
    throw new Error(`${field}.schemaVersion 不受支持`)
  }
  const sessionId = stringValue(item.sessionId, `${field}.sessionId`)
  stringValue(item.symbol, `${field}.symbol`)
  const account = record(item.account, `${field}.account`)
  ACCOUNT_DECIMALS.forEach((name) =>
    decimalValue(account[name], `${field}.account.${name}`),
  )
  const config = record(item.config, `${field}.config`)
  const ctrader = config.ctrader
  const okx = config.okx
  const cmeFeePerContractSide = config.cmeFeePerContractSide
  validateCmeFeePerContractSide(cmeFeePerContractSide)
  if (ctrader !== undefined) validateCTraderTradingTerms(ctrader)
  if (okx !== undefined) validateOkxTradingTerms(okx)
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
    ...(ctrader === undefined ? {} : { ctrader }),
    ...(okx === undefined ? {} : { okx }),
    ...(cmeFeePerContractSide === undefined ? {} : { cmeFeePerContractSide }),
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
  const rawPositions = item.schemaVersion === 1
    ? item.position === null ? [] : [item.position]
    : arrayValue(item.positions, `${field}.positions`)
  if ((item.schemaVersion === 1 && item.positions !== undefined) ||
      (item.schemaVersion === 2 && item.position !== undefined)) {
    throw new Error(`${field}.positions 包含混合版本字段`)
  }
  if (rawPositions.length > 2) throw new Error(`${field}.positions 最多包含两个仓位`)
  const sides = new Set<string>()
  for (const [positionIndex, rawPosition] of rawPositions.entries()) {
    const positionField = item.schemaVersion === 1 ? `${field}.position` : `${field}.positions[${positionIndex}]`
    const position = record(rawPosition, positionField)
    if (position.symbol !== item.symbol) {
      throw new Error(`${positionField}.symbol 不匹配`)
    }
    for (const name of [
      'quantity',
      'entryPrice',
      'notional',
      'isolatedMargin',
      'maintenanceMarginRate',
      'liquidationPrice',
    ]) {
      decimalValue(position[name], `${positionField}.${name}`, false)
    }
    if (position.lastPrice !== undefined) {
      decimalValue(
        position.lastPrice,
        `${positionField}.lastPrice`,
        false,
      )
    }
    if (position.markPrice !== undefined) {
      decimalValue(position.markPrice, `${positionField}.markPrice`, false)
    }
    if (position.lastPrice === undefined && position.markPrice === undefined) {
      throw new Error(`${positionField}.lastPrice 缺失`)
    }
    decimalValue(
      position.unrealizedPnl,
      `${positionField}.unrealizedPnl`,
    )
    for (const name of ['takeProfitPrice', 'stopLossPrice']) {
      if (position[name] !== null) {
        decimalValue(position[name], `${positionField}.${name}`, false)
      }
    }
    const leverage = nonNegativeInteger(
      position.leverage,
      `${positionField}.leverage`,
    )
    if (leverage === 0) {
      throw new Error(`${positionField}.leverage 必须大于 0`)
    }
    for (const name of [
      'openedAt',
      'updatedAt',
      'riskActiveAfterTime',
    ]) {
      nonNegativeInteger(position[name], `${positionField}.${name}`)
    }
    if (ctrader?.swap) {
      nonNegativeInteger(position.swapPeriods, `${positionField}.swapPeriods`)
      const checked = nonNegativeInteger(position.swapCheckedThrough, `${positionField}.swapCheckedThrough`)
      if (checked < Number(position.openedAt)) throw new Error(`${positionField}.swapCheckedThrough 早于开仓时间`)
    }
    if (position.fundingCheckedThrough !== undefined) {
      const checked = nonNegativeInteger(position.fundingCheckedThrough, `${positionField}.fundingCheckedThrough`)
      if (!okx || !Number.isSafeInteger(checked) || checked < Number(position.openedAt)) {
        throw new Error(`${positionField}.fundingCheckedThrough 无效`)
      }
    }
    for (const name of [
      'takeProfitActiveAfterTime',
      'stopLossActiveAfterTime',
    ]) {
      if (position[name] !== null) {
        nonNegativeInteger(position[name], `${positionField}.${name}`)
      }
    }
    if (!['long', 'short'].includes(String(position.side))) {
      throw new Error(`${positionField}.side 无效`)
    }
    if (sides.has(String(position.side))) throw new Error(`${field}.positions 方向重复`)
    sides.add(String(position.side))
    for (const name of ['quantity', 'entryPrice']) {
      if (new Decimal(position[name] as string).lessThanOrEqualTo(0)) throw new Error(`${positionField}.${name} 必须大于 0`)
    }
    if (new Decimal((position.lastPrice ?? position.markPrice) as string).lessThanOrEqualTo(0)) {
      throw new Error(`${positionField}.lastPrice 必须大于 0`)
    }
    for (const [price, activation] of [['takeProfitPrice', 'takeProfitActiveAfterTime'], ['stopLossPrice', 'stopLossActiveAfterTime']]) {
      if ((position[price] === null) !== (position[activation] === null)) throw new Error(`${positionField}.${price} 与生效时间不匹配`)
      if (position[price] !== null && new Decimal(position[price] as string).lessThanOrEqualTo(0)) throw new Error(`${positionField}.${price} 必须大于 0`)
    }
  }
  if (item.warning !== null && typeof item.warning !== 'string') {
    throw new Error(`${field}.warning 必须是字符串或 null`)
  }
  nonNegativeInteger(item.updatedAt, `${field}.updatedAt`)
  return normalizeSimulationStatePrices({
    ...(structuredClone(item) as unknown as StoredSimulationState),
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
  if (source.drawings !== undefined) {
    if (kind !== 'all') throw new Error('仅全部数据备份可包含绘图')
    data.drawings = validateDrawings(source.drawings)
  }
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
  const sessions = new Map((data.sessions ?? []).map((item) => [item.id, item]))
  for (const simulation of data.simulations ?? []) {
    const session = sessions.get(simulation.sessionId)
    if (session === undefined) {
      throw new Error(
        `模拟状态 ${simulation.sessionId} 缺少对应回放会话`,
      )
    }
    if (!sameCTraderTradingTerms(session.tradingConfig.ctrader, simulation.config.ctrader)) {
      throw new Error(`模拟状态 ${simulation.sessionId} 与会话的 IC Markets 交易规格不匹配`)
    }
    if (!sameOkxTradingTerms(session.tradingConfig.okx, simulation.config.okx) || (isOkxPriceSource(session.marketSource) &&
        (session.tradingConfig.feeRate !== simulation.config.feeRate ||
          session.tradingConfig.liquidationFeeRate !== simulation.config.liquidationFeeRate))) {
      throw new Error('回放会话与模拟状态的 OKX 交易规格不一致')
    }
    if (session.tradingConfig.cmeFeePerContractSide !== simulation.config.cmeFeePerContractSide) {
      throw new Error('回放会话与模拟状态的 CME 手续费不一致')
    }
    const cmeFee = simulation.config.cmeFeePerContractSide
    if (cmeFee !== undefined) {
      if (cmeFee === null && (simulation.positions.length || simulation.trades.length)) {
        throw new Error('缺少 CME 手续费的会话仅可回放行情')
      }
      const hasFractionalContracts = (item: { quantity: string }) => !new Decimal(item.quantity).isInteger()
      if (simulation.positions.some(hasFractionalContracts) || simulation.trades.some(hasFractionalContracts)) {
        throw new Error('CME 模拟持仓和成交的张数必须为整数')
      }
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
  const ctraderAccount = readCTraderAccount(storage)
  const okxSelectedSymbol = readSelectedOkxSymbol(storage)
  const databentoSelectedSymbol = readSelectedDatabentoSymbol(storage)
  return {
    binanceRestBaseUrl:
      storage.getItem(BASE_URL_PREFERENCE) ?? 'https://fapi.binance.com',
    favoriteSymbols,
    pinnedPeriods: readPinnedPeriods(storage),
    replayStepPeriod: readReplayStepPeriod(storage),
    showTradeOverlays: readShowTradeOverlays(storage),
    priceSource: readPriceSource(storage),
    chartWindowSize: readChartWindowSize(storage),
    candleType: readCandleType(storage),
    candleTransparency: readCandleTransparency(storage),
    showCandleHoverDetails: readShowCandleHoverDetails(storage),
    workspace: loadWorkspacePreferences(storage),
    ...(selectedSymbol === null ? {} : { selectedSymbol }),
    ...(ctraderAccount === undefined ? {} : { ctraderAccount }),
    ...(okxSelectedSymbol === null ? {} : { okxSelectedSymbol }),
    ...(databentoSelectedSymbol === null ? {} : { databentoSelectedSymbol }),
    ...(chartIndicators === null ? {} : { chartIndicators }),
  }
}

export class WorkstationBackupService {
  private readonly simulations: IndexedDbSimulationStateStore
  private readonly includeMarketHistory: boolean

  constructor(
    private readonly databaseName?: string,
    private readonly storage: StorageLike = ctraderStorage,
    private readonly now: () => number = Date.now,
    private readonly drawings?: DrawingStore,
    options: { includeMarketHistory?: boolean } = {},
  ) {
    this.simulations = new IndexedDbSimulationStateStore(databaseName)
    this.includeMarketHistory = options.includeMarketHistory ?? true
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
    if (!this.includeMarketHistory) throw new Error('cTrader 行情按需读取，不提供行情存档')
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
      this.includeMarketHistory ? database.getAll('symbols') : [],
      this.includeMarketHistory ? database.getAll('tradeCandles') : [],
      database.getAll('replaySessions'),
      database.getAll('simulationStates'),
    ])
    const simulations = (
      await Promise.all(
        stateRows.map((state) => this.simulations.load(state.sessionId)),
      )
    ).filter((state): state is SimulationState => state !== undefined)
    return this.envelope('all', {
      ...(this.drawings ? { drawings: this.drawings.read().local.drawings } : {}),
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

  async import(value: unknown, onProgress?: (message: string) => void, options: { source?: 'local' | 'cloud' } = {}): Promise<BackupImportReport> {
    onProgress?.('正在校验备份数据…')
    const envelope = validateBackupEnvelope(value, loadChartIndicatorPreferences(this.storage))
    if (envelope.kind === 'preferences') {
      this.restorePreferences(envelope.data.preferences!, options.source ?? 'local')
      return { kind: 'preferences', symbols: 0, tradeCandles: 0, markCandles: 0, sessions: 0, simulations: 0, preferences: true }
    }
    const symbols = this.includeMarketHistory ? envelope.data.symbols ?? [] : []
    const tradeCandles = this.includeMarketHistory ? envelope.data.tradeCandles ?? [] : []
    if (this.includeMarketHistory) onProgress?.(`正在恢复行情：${tradeCandles.length.toLocaleString()} 根…`)
    if (!this.includeMarketHistory && envelope.kind === 'market-data') {
      return { kind: 'market-data', symbols: 0, tradeCandles: 0, markCandles: 0, sessions: 0, simulations: 0, preferences: false }
    }
    const database = await openWorkstationDatabase(this.databaseName)
    const tables: BackupStoreName[] = ['replaySessions', 'simulationStates', 'simulationTrades', 'simulationLedger']
    if (this.includeMarketHistory) tables.push('symbols', 'tradeCandles')
    const transaction = database.transaction(tables, 'readwrite')
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
      const tradeExisting = await readExisting('tradeCandles', tradeCandles)
      const changed = (row: MarketCandle, existing: Map<string,MarketCandle>) => {
        const prior = existing.get(candleKey(row))
        return prior === undefined || (Object.keys(row) as Array<keyof MarketCandle>).some(field => prior[field] !== row[field])
      }
      const native = unwrap(transaction)
      for (const symbol of symbols) {
        native.objectStore('symbols').put(symbol)
      }
      for (const candle of tradeCandles) {
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
      this.restorePreferences(envelope.data.preferences, options.source ?? 'local')
    }
    if (envelope.data.drawings !== undefined) await this.drawings?.replace(envelope.data.drawings)
    return {
      kind: envelope.kind,
      symbols: symbols.length,
      tradeCandles: tradeCandles.length,
      markCandles: 0,
      sessions: envelope.data.sessions?.length ?? 0,
      simulations: envelope.data.simulations?.length ?? 0,
      preferences: envelope.data.preferences !== undefined,
    }
  }

  private restorePreferences(preferences: BackupPreferences, source: 'local' | 'cloud'): void {
    if (source === 'local') this.storage.setItem(CONFIG_PENDING_KEY, 'true')
    this.storage.setItem(BASE_URL_PREFERENCE, preferences.binanceRestBaseUrl)
    this.storage.setItem(FAVORITES_PREFERENCE, JSON.stringify(preferences.favoriteSymbols))
    const fields = {
      chartIndicators: CHART_INDICATORS_PREFERENCE,
      selectedSymbol: SELECTED_SYMBOL_STORAGE_KEY,
      okxSelectedSymbol: OKX_SYMBOL_STORAGE_KEY,
      databentoSelectedSymbol: DATABENTO_SYMBOL_STORAGE_KEY,
      ctraderAccount: CTRADER_ACCOUNT_KEY,
      priceSource: PRICE_SOURCE_KEY,
      pinnedPeriods: PINNED_PERIODS_KEY,
      replayStepPeriod: REPLAY_STEP_PERIOD_KEY,
      showTradeOverlays: SHOW_TRADE_OVERLAYS_KEY,
      chartWindowSize: CHART_WINDOW_SIZE_KEY,
      workspace: WORKSPACE_PREFERENCES_KEY,
      candleType: CANDLE_TYPE_KEY,
      candleTransparency: CANDLE_TRANSPARENCY_KEY,
      showCandleHoverDetails: SHOW_CANDLE_HOVER_DETAILS_KEY,
    } as const
    for (const [field, key] of Object.entries(fields)) {
      const value = preferences[field as keyof typeof fields]
      if (value !== undefined) this.storage.setItem(key, JSON.stringify(value))
    }
    preferencesRestored(this.storage, source)
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
