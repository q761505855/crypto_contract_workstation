import Decimal from 'decimal.js'
import { validateCTraderTradingTerms, type CTraderTradingTerms } from '../simulation/ctrader-trading'
import {
  CTraderClient, CTraderMessage, cTraderInteger, cTraderObject, waitForCTraderResult,
  type CTraderPayload,
} from './ctrader-client'
import { CTRADER_TIMEFRAMES, alignOpenTime, isCTraderTimeframe, nextOpenTime, type CTraderTimeframe } from './intervals'
import { INITIAL_LIVE_STATUS, type LiveMarketStatus } from './live-models'
import { normalizeMarketTicker, type MarketCandle, type MarketSymbol } from './models'

const MINUTE = 60_000
const DAY = 86_400_000
const MAX_TIMESTAMP = 2_147_483_646_000
const HISTORY_MIN_SPACING_MS = 260
const HISTORY_PAGE_SIZE = 500
const RECENT_HISTORY_MAX_PAGES = 4
const SYMBOL_BATCH_SIZE = 100
const PERIOD_NAMES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M10', 'M15', 'M30', 'H1', 'H4', 'H12', 'D1', 'W1', 'MN1']
const MARKET_CLOSED = 'cTrader 市场休市'

interface Instrument {
  id: number
  symbol: MarketSymbol
  details: CTraderPayload
}

interface TradingAccount {
  assetId: number
  accountLeverage: number
  marginMode: CTraderTradingTerms['marginMode']
  stopOutMode: CTraderTradingTerms['stopOutMode']
  stopOutOrder: CTraderTradingTerms['stopOutOrder']
  swapFree: boolean
  moneyDigits: number
}

function specInteger(value: unknown, field: string, minimum = 0): number {
  const number = cTraderInteger(value)
  if (number === undefined || number < minimum) throw new Error(`缺少有效的 cTrader ${field}`)
  return number
}

function cents(value: unknown, field: string): string {
  return new Decimal(specInteger(value, field, 1)).div(100).toString()
}

function specEnum(value: unknown, names: readonly string[], offset = 0): number {
  const numeric = cTraderInteger(value)
  if (numeric !== undefined && numeric >= offset && numeric < offset + names.length) return numeric
  const index = typeof value === 'string' ? names.indexOf(value) : -1
  if (index >= 0) return index + offset
  throw new Error('cTrader 返回了未知的交易规格枚举值')
}

function swapTerms(details: CTraderPayload, account: TradingAccount): CTraderTradingTerms['swap'] {
  const admin = Number(details.rolloverCommission ?? 0)
  const long = account.swapFree ? -admin : Number(details.swapLong ?? 0)
  const short = account.swapFree ? -admin : Number(details.swapShort ?? 0)
  if (long === 0 && short === 0) return undefined
  const type = account.swapFree ? 'admin-per-lot' : specEnum(details.swapCalculationType ?? 0, ['PIPS', 'PERCENTAGE']) === 0 ? 'pips' : 'percent'
  return {
    type, long: String(long), short: String(short),
    pipPosition: specInteger(details.pipPosition, '点值精度'),
    periodHours: specInteger(details.swapPeriod ?? 24, '隔夜结算周期', 1),
    utcMinute: specInteger(details.swapTime, '隔夜结算时间'),
    tripleDay: specEnum((account.swapFree ? details.rolloverCommission3Days : details.swapRollover3Days) ?? 0,
      ['NONE', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']),
    skipPeriods: specInteger(account.swapFree ? details.skipRolloverDays ?? 0 : details.skipSWAPPeriods ?? 0, '隔夜免收周期'),
    weekends: details.chargeSwapAtWeekends === true,
    moneyDigits: account.moneyDigits,
  }
}

interface HistoryLoadOptions {
  signal?: AbortSignal
  onStatus?: (status: string) => void
}

interface CachedCandles {
  expires: number
  candles: MarketCandle[]
}

interface HistoryRange extends CachedCandles {
  series: string
  from: number
  to: number
}

interface HistoryPage {
  candles: MarketCandle[]
  hasMore: boolean
}

interface RecentHistoryPage {
  candles: MarketCandle[]
  nextTo: number
}

export interface CTraderTick {
  timestamp: number
  price: string
  /** Exchange trades may have finer timestamps and a traded quantity. */
  timeUs?: number
  size?: number
}

function appendHistoryPage(rows: Map<number, MarketCandle>, page: HistoryPage, start: number, end: number): number {
  let oldest = Infinity
  for (const candle of page.candles) {
    if (candle.openTime > end) continue
    // Counted responses can include bars before the requested start. They
    // prove this window has been covered without belonging to its output.
    oldest = Math.min(oldest, candle.openTime)
    if (candle.openTime >= start) rows.set(candle.openTime, candle)
  }
  if (!page.hasMore) return start - 1
  if (!Number.isFinite(oldest)) throw new Error('cTrader 历史行情分页没有推进')
  return Math.max(start, oldest) - 1
}

interface ActiveTrendbar {
  symbolId: number
  period: number
}

export interface CTraderMarketSubscription {
  symbol: string
  timeframe: string
  onCandle(candle: MarketCandle): void
  getHistoryCandle?(): MarketCandle | undefined
  onStatus?(status: LiveMarketStatus): void
}

interface Subscription {
  input: CTraderMarketSubscription
  timeframe: CTraderTimeframe
  status: LiveMarketStatus
  lastClosedOpen?: number
  lastBid?: string
  lastBidTime?: number
  forming?: MarketCandle
}

function objects(value: unknown): CTraderPayload[] {
  return Array.isArray(value) ? value.flatMap(item => {
    const record = cTraderObject(item)
    return record === undefined ? [] : [record]
  }) : []
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function cTraderPeriod(timeframe: CTraderTimeframe): number {
  return CTRADER_TIMEFRAMES.indexOf(timeframe) + 1
}

function decodePeriod(value: unknown): number | undefined {
  const number = cTraderInteger(value)
  if (number !== undefined) return number
  const index = typeof value === 'string' ? PERIOD_NAMES.indexOf(value) : -1
  return index === -1 ? undefined : index + 1
}

function cTraderPrice(raw: number, digits: number): string {
  return (raw / 100_000).toFixed(digits)
}

function readTrendbar(
  raw: CTraderPayload, symbol: MarketSymbol, timeframe: CTraderTimeframe, now: number,
): MarketCandle {
  const openInMinutes = cTraderInteger(raw.utcTimestampInMinutes)
  const low = cTraderInteger(raw.low)
  const deltaOpen = cTraderInteger(raw.deltaOpen ?? 0)
  const deltaHigh = cTraderInteger(raw.deltaHigh ?? 0)
  const deltaClose = cTraderInteger(raw.deltaClose ?? 0)
  const tickVolume = cTraderInteger(raw.volume)
  if (openInMinutes === undefined || openInMinutes < 0 || low === undefined
    || deltaOpen === undefined || deltaHigh === undefined || deltaClose === undefined
    || deltaOpen < 0 || deltaClose < 0 || deltaHigh < Math.max(deltaOpen, deltaClose)
    || tickVolume === undefined || tickVolume < 0 || !Number.isSafeInteger(low + deltaHigh)
    || (raw.period !== undefined && decodePeriod(raw.period) !== cTraderPeriod(timeframe))) {
    throw new Error('cTrader 返回了无效的原生 K 线')
  }
  const openTime = openInMinutes * MINUTE
  const closeTime = nextOpenTime(openTime, timeframe) - 1
  const digits = symbol.pricePrecision
  return {
    source: 'ctrader', symbol: symbol.symbol, timeframe, openTime, closeTime,
    open: cTraderPrice(low + deltaOpen, digits), low: cTraderPrice(low, digits),
    high: cTraderPrice(low + deltaHigh, digits), close: cTraderPrice(low + deltaClose, digits),
    isClosed: closeTime < now, tickVolume,
    volume: '', quoteVolume: '', tradeCount: 0,
  }
}

function updateFormingCandle(
  subscription: Subscription, instrument: Instrument, timestamp: number, priceText: string, nativeUpdate?: MarketCandle,
): void {
  const { timeframe } = subscription
  const openTime = nativeUpdate?.openTime ?? alignOpenTime(timestamp, timeframe, 'floor')
  const previous = subscription.forming
  if (openTime <= (subscription.lastClosedOpen ?? -1) || (previous && openTime < previous.openTime)) return
  const current = previous?.openTime === openTime ? previous : undefined
  if (!current && isInstrumentOpen(instrument.details, timestamp) === false) return
  const snapshot = subscription.input.getHistoryCandle?.()
  const native = nativeUpdate ?? (snapshot?.openTime === openTime ? snapshot : undefined)
  const price = Number(priceText)
  const digits = instrument.symbol.pricePrecision
  const candle: MarketCandle = {
    source: 'ctrader', symbol: instrument.symbol.symbol, timeframe, openTime,
    closeTime: nextOpenTime(openTime, timeframe) - 1, isClosed: false,
    open: native?.open ?? current?.open ?? priceText,
    high: Math.max(price, Number(native?.high ?? priceText), Number(current?.high ?? priceText)).toFixed(digits),
    low: Math.min(price, Number(native?.low ?? priceText), Number(current?.low ?? priceText)).toFixed(digits),
    close: priceText, tickVolume: native?.tickVolume ?? current?.tickVolume, volume: '', quoteVolume: '', tradeCount: 0,
  }
  if (current && candle.open === current.open && candle.high === current.high && candle.low === current.low &&
    candle.close === current.close && candle.tickVolume === current.tickVolume) return
  subscription.forming = candle
  subscription.input.onCandle(candle)
}

const exchangeClocks = new Map<string, Intl.DateTimeFormat>()

function localClock(timestamp: number, zone: string): { day: number; second: number; weekSecond: number } | undefined {
  try {
    let formatter = exchangeClocks.get(zone)
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
      })
      exchangeClocks.set(zone, formatter)
    }
    const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, Number(part.value)]))
    const date = Date.UTC(parts.year, parts.month - 1, parts.day)
    const second = parts.hour * 3_600 + parts.minute * 60 + parts.second
    return { day: date / DAY, second, weekSecond: new Date(date).getUTCDay() * 86_400 + second }
  } catch {
    return undefined
  }
}

function isInstrumentOpen(details: CTraderPayload, timestamp: number): boolean | null {
  for (const holiday of objects(details.holiday)) {
    const day = cTraderInteger(holiday.holidayDate)
    const local = localClock(timestamp, text(holiday.scheduleTimeZone) ?? text(details.scheduleTimeZone) ?? 'UTC')
    if (day === undefined || !local) continue
    const date = new Date(day * DAY)
    const localDate = new Date(local.day * DAY)
    const sameDate = holiday.isRecurring === true
      ? date.getUTCDate() === localDate.getUTCDate() && date.getUTCMonth() === localDate.getUTCMonth()
      : day === local.day
    if (!sameDate) continue
    const start = cTraderInteger(holiday.startSecond) ?? 0
    const end = cTraderInteger(holiday.endSecond) ?? 86_400
    if (start === end || (local.second >= start && local.second < end)) return false
  }
  const schedule = objects(details.schedule)
  const local = localClock(timestamp, text(details.scheduleTimeZone) ?? 'UTC')
  if (schedule.length === 0 || !local) return null
  return schedule.some(interval => {
    const start = cTraderInteger(interval.startSecond)
    const end = cTraderInteger(interval.endSecond)
    if (start === undefined || end === undefined) return false
    return end >= start
      ? local.weekSecond >= start && local.weekSecond < end
      : local.weekSecond >= start || local.weekSecond < end
  })
}

export class CTraderMarketService {
  readonly source = 'ctrader'
  private catalog?: Map<string, Instrument>
  private catalogRequest?: Promise<Map<string, Instrument>>
  private assetNames = new Map<number, string>()
  private tradingAccount?: { session: number; request: Promise<TradingAccount> }
  private leverageSession?: number
  private readonly leverageRequests = new Map<number, Promise<CTraderTradingTerms['leverageTiers']>>()
  private historyQueue = Promise.resolve()
  private nextHistoryRequest = 0
  private readonly history = new Map<string, HistoryRange>()
  private readonly recentHistory = new Map<string, RecentHistoryPage & { expires: number }>()
  private readonly historyReads = new Map<string, Promise<void>>()
  private readonly subscriptions = new Set<Subscription>()
  private readonly activeSpots = new Set<number>()
  private readonly activeTrendbars = new Map<string, ActiveTrendbar>()
  private subscriptionSession?: number
  private subscriptionQueue = Promise.resolve()
  private marketHoursTimer?: ReturnType<typeof setInterval>
  private status = { ...INITIAL_LIVE_STATUS }

  constructor(private readonly client: CTraderClient, private readonly now: () => number = Date.now) {
    client.onStatus(status => this.connectionChanged(status))
    client.onEvent((type, payload) => {
      if (type === CTraderMessage.Spot) this.onSpot(payload)
      if (type === CTraderMessage.SymbolChanged) {
        this.catalog = undefined
        this.leverageRequests.clear()
      }
      if (type === CTraderMessage.TraderUpdated) this.tradingAccount = undefined
    })
  }

  async getSymbols(options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<MarketSymbol[]> {
    if (options.forceRefresh) this.leverageRequests.clear()
    const catalog = await this.getCatalog(options)
    return [...catalog.values()].map(instrument => ({ ...instrument.symbol }))
  }

  getCachedLotSize(symbol: string): number | undefined {
    const size = cTraderInteger(this.catalog?.get(symbol.toUpperCase())?.details.lotSize)
    return size !== undefined && size > 0 ? size / 100 : undefined
  }

  async getReplayTradingTerms(symbol: string, timestamp: number, signal?: AbortSignal): Promise<CTraderTradingTerms> {
    const session = await this.client.connect(signal)
    const [{ details, symbol: instrument }, account] = await Promise.all([
      this.getInstrument(symbol, signal), waitForCTraderResult(this.loadTradingAccount(session), signal),
    ])
    const quoteCurrency = instrument.quoteAsset
    const accountCurrency = this.assetNames.get(account.assetId)
    if (!quoteCurrency || !accountCurrency) throw new Error('无法读取 cTrader 报价币种或账户币种')
    const commissionType = specEnum(details.commissionType ?? 1,
      ['USD_PER_MILLION_USD', 'USD_PER_LOT', 'PERCENTAGE_OF_VALUE', 'QUOTE_CCY_PER_LOT'], 1) as CTraderTradingTerms['commission']['type']
    const rate = details.preciseTradingCommissionRate === undefined
      ? new Decimal(specInteger(details.commission ?? 0, '佣金')).div(100)
      : new Decimal(specInteger(details.preciseTradingCommissionRate, '精确佣金')).div(commissionType === 3 ? 10_000_000 : 100_000_000)
    const minimum = details.preciseMinCommission === undefined
      ? new Decimal(specInteger(details.minCommission ?? 0, '最低佣金')).div(100)
      : new Decimal(specInteger(details.preciseMinCommission, '精确最低佣金')).div(100_000_000)
    const minType = specEnum(details.minCommissionType ?? 1, ['CURRENCY', 'QUOTE_CURRENCY'], 1)
    const minCurrency = minType === 2 ? quoteCurrency : text(details.minCommissionAsset) ?? 'USD'
    const leverageId = specInteger(details.leverageId ?? 0, '杠杆档位 ID')
    const [leverageTiers, quoteToUsd, usdToAccount, minimumToUsd] = await Promise.all([
      waitForCTraderResult(this.loadLeverageTiers(session, leverageId), signal),
      instrument.baseAsset === 'USD' && quoteCurrency !== 'USD' ? 'inverse-price' : this.conversionRate(quoteCurrency, 'USD', timestamp, signal),
      accountCurrency === quoteCurrency ? '1' : this.conversionRate('USD', accountCurrency, timestamp, signal),
      minimum.isZero() || minCurrency === quoteCurrency ? '1' : this.conversionRate(minCurrency, 'USD', timestamp, signal),
    ])
    const terms: CTraderTradingTerms = {
      accountCurrency, quoteCurrency, quoteToUsd, usdToAccount,
      lotSize: cents(details.lotSize, '每手合约大小'), minQuantity: cents(details.minVolume, '最小下单数量'),
      quantityStep: cents(details.stepVolume, '下单步长'), maxQuantity: cents(details.maxVolume, '最大下单数量'),
      accountLeverage: account.accountLeverage, leverageTiers, marginMode: account.marginMode,
      // cTrader Open API exposes the stop-out method, but the level is published by IC Markets.
      stopOutRate: '0.5', stopOutMode: account.stopOutMode, stopOutOrder: account.stopOutOrder,
      commission: { type: commissionType, rate: rate.toString(),
        minimumUsd: minCurrency === quoteCurrency ? '0' : minimum.mul(minimumToUsd).toString(),
        minimumQuote: minCurrency === quoteCurrency ? minimum.toString() : '0' },
      canShort: details.enableShortSelling !== false,
      tradingMode: specEnum(details.tradingMode ?? 0, ['ENABLED', 'DISABLED_WITHOUT_PENDINGS_EXECUTION', 'DISABLED_WITH_PENDINGS_EXECUTION', 'CLOSE_ONLY_MODE']) as CTraderTradingTerms['tradingMode'],
      pnlConversionFeeRate: new Decimal(specInteger(details.pnlConversionFeeRate ?? 0, '盈亏换汇费')).div(10_000).toString(),
      protection: {
        units: specEnum(details.distanceSetIn ?? 1, ['SYMBOL_DISTANCE_IN_POINTS', 'SYMBOL_DISTANCE_IN_PERCENTAGE'], 1) === 1 ? 'points' : 'percent',
        digits: instrument.pricePrecision,
        stopLoss: specInteger(details.slDistance ?? 0, '止损最小距离'),
        takeProfit: specInteger(details.tpDistance ?? 0, '止盈最小距离'),
      },
      swap: swapTerms(details, account),
    }
    validateCTraderTradingTerms(terms)
    return terms
  }

  private loadTradingAccount(session: number): Promise<TradingAccount> {
    if (this.tradingAccount?.session === session) return this.tradingAccount.request
    const request = this.client.request(CTraderMessage.Trader, {}, undefined, session).then(payload => {
      const trader = cTraderObject(payload.trader)
      if (!trader) throw new Error('cTrader 未返回账户交易规格')
      if (specEnum(trader.accountType ?? 0, ['HEDGED', 'NETTED', 'SPREAD_BETTING']) !== 0 || trader.isLimitedRisk === true) {
        throw new Error('当前回放适用于 IC Markets 的标准对冲账户')
      }
      return {
        assetId: specInteger(trader.depositAssetId, '账户币种 ID', 1),
        accountLeverage: specInteger(trader.leverageInCents, '账户杠杆', 100) / 100,
        marginMode: (['max', 'sum', 'net'] as const)[specEnum(trader.totalMarginCalculationType ?? 0, ['MAX', 'SUM', 'NET'])]!,
        stopOutMode: trader.fairStopOut === true ? 'fair' as const : 'smart' as const,
        stopOutOrder: specEnum(trader.stopOutStrategy ?? 0, ['MOST_MARGIN_USED_FIRST', 'MOST_LOSING_FIRST']) === 1 ? 'loss' as const : 'margin' as const,
        moneyDigits: specInteger(trader.moneyDigits ?? 2, '账户货币精度'),
        swapFree: trader.swapFree === true,
      }
    }).catch(error => {
      if (this.tradingAccount?.request === request) this.tradingAccount = undefined
      throw error
    })
    this.tradingAccount = { session, request }
    return request
  }

  private loadLeverageTiers(session: number, leverageId: number): Promise<CTraderTradingTerms['leverageTiers']> {
    if (leverageId === 0) return Promise.resolve([])
    if (this.leverageSession !== session) {
      this.leverageRequests.clear()
      this.leverageSession = session
    }
    const cached = this.leverageRequests.get(leverageId)
    if (cached) return cached
    const request = this.client.request(CTraderMessage.DynamicLeverage, { leverageId }, undefined, session).then(payload => {
      const leverage = cTraderObject(payload.leverage)
      const tiers = objects(leverage?.tiers)
      if (cTraderInteger(leverage?.leverageId) !== leverageId || tiers.length === 0) throw new Error('cTrader 未返回品种杠杆档位')
      return tiers.map(tier => ({ upToUsd: cents(tier.volume, '杠杆档位名义金额'),
        leverage: specInteger(tier.leverage, '品种杠杆档位', 100) / 100 }))
    }).catch(error => {
      if (this.leverageRequests.get(leverageId) === request) this.leverageRequests.delete(leverageId)
      throw error
    })
    this.leverageRequests.set(leverageId, request)
    return request
  }

  private async conversionRate(from: string, to: string, timestamp: number, signal?: AbortSignal): Promise<string> {
    if (from === to) return '1'
    const catalog = await this.getCatalog({ signal })
    const leg = (base: string, quote: string) => {
      if (catalog.has(base + quote)) return { symbol: base + quote, inverse: false }
      if (catalog.has(quote + base)) return { symbol: quote + base, inverse: true }
      return undefined
    }
    const direct = leg(from, to)
    const indirect = ['USD', 'EUR', 'GBP', 'JPY', 'CHF'].flatMap(via => {
      const first = via !== from ? leg(from, via) : undefined
      const second = via !== to ? leg(via, to) : undefined
      return first && second ? [[first, second]] : []
    })
    const paths = direct ? [[direct], ...indirect] : indirect
    const dayStart = Math.floor(timestamp / DAY) * DAY
    for (const path of paths) {
      const rates = await Promise.all(path.map(async ({ symbol, inverse }) => {
        const bars = await this.loadCandles('trade', symbol, '1d', dayStart - 14 * DAY, dayStart - 1, { signal })
        const last = bars.filter(bar => bar.isClosed && bar.closeTime < timestamp).at(-1)
        if (!last) return undefined
        return inverse ? new Decimal(1).div(last.close) : new Decimal(last.close)
      }))
      if (rates.every(rate => rate !== undefined)) return rates.reduce((rate, leg) => rate.mul(leg), new Decimal(1)).toString()
    }
    throw new Error(`没有 ${from}→${to} 的历史换汇报价`)
  }

  async isMarketOpen(symbol: string, timestamp = this.now(), signal?: AbortSignal): Promise<boolean | null> {
    const instrument = await this.getInstrument(symbol, signal)
    return isInstrumentOpen(instrument.details, timestamp)
  }

  async loadCandles(
    kind: 'trade', symbol: string, timeframe: string, from: number, to: number,
    options: HistoryLoadOptions = {},
  ): Promise<MarketCandle[]> {
    const { signal } = options
    signal?.throwIfAborted()
    if (kind !== 'trade' || !isCTraderTimeframe(timeframe)) throw new Error(`cTrader 不支持此 K 线类型或周期：${timeframe}`)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return []
    // All native trendbar opens use minute timestamps, even on higher periods.
    const requestedFrom = Math.max(0, Math.ceil(from / MINUTE) * MINUTE)
    const requestedTo = Math.floor(Math.min(MAX_TIMESTAMP, to, this.now()) / MINUTE) * MINUTE
    if (requestedFrom > requestedTo) return []
    const instrument = await this.getInstrument(symbol, signal)
    const series = `${instrument.id}:${timeframe}`
    return this.queueHistoryRead(series, signal, () => this.readCandleRange(
      instrument, timeframe, series, requestedFrom, requestedTo, options,
    ))
  }

  private async readCandleRange(
    instrument: Instrument, timeframe: CTraderTimeframe, series: string, from: number, to: number,
    { signal, onStatus }: HistoryLoadOptions,
  ): Promise<MarketCandle[]> {
    const now = this.now()
    const ranges = [...this.history.values()].filter(range =>
      range.series === series && range.expires > now && range.from <= to && range.to >= from,
    ).sort((left, right) => left.from - right.from)
    const candles = new Map<number, MarketCandle>()
    const gaps: { from: number; to: number }[] = []
    let cursor = from
    for (const range of ranges) {
      if (range.from > cursor) gaps.push({ from: cursor, to: range.from - MINUTE })
      cursor = Math.max(cursor, range.to + MINUTE)
      for (const candle of range.candles) {
        if (candle.openTime >= from && candle.openTime <= to) candles.set(candle.openTime, candle)
      }
    }
    if (cursor <= to) gaps.push({ from: cursor, to })
    if (gaps.length > 0) {
      onStatus?.('正在读取 cTrader 原生 K 线')
      try {
        for (const gap of gaps) {
          const page = await this.readUncachedCandles(instrument, timeframe, gap.from, gap.to, signal)
          for (const candle of page) candles.set(candle.openTime, candle)
          if (page.length <= 4_000) {
            this.rememberHistory(this.history, `${series}:${gap.from}:${gap.to}`, 32, {
              series, ...gap, candles: page, expires: this.historyExpiry(gap.to, page),
            })
          }
        }
      } finally {
        onStatus?.('')
      }
    }
    return [...candles.values()].sort((left, right) => left.openTime - right.openTime)
  }

  private async readUncachedCandles(
    instrument: Instrument, timeframe: CTraderTimeframe, from: number, to: number, signal?: AbortSignal,
  ): Promise<MarketCandle[]> {
    const candlesByOpen = new Map<number, MarketCandle>()
    const step = nextOpenTime(0, timeframe)
    const pageSpan = Math.min(step * (HISTORY_PAGE_SIZE - 1), 365 * DAY)
    let end = to
    while (end >= from) {
      signal?.throwIfAborted()
      const start = Math.max(from, end - pageSpan)
      const page = await this.getHistoryPage(
        instrument, timeframe, Math.max(0, start - 1), end, HISTORY_PAGE_SIZE, signal,
      )
      end = appendHistoryPage(candlesByOpen, page, start, end)
    }
    return [...candlesByOpen.values()]
  }

  async loadRecentCandles(
    symbol: string, timeframe: string, to: number, options?: HistoryLoadOptions & { count?: number },
  ): Promise<MarketCandle[]> {
    return (await this.loadRecentCandlesPage(symbol, timeframe, to, options)).candles
  }

  async loadRecentCandlesPage(
    symbol: string, timeframe: string, to: number, options: HistoryLoadOptions & { count?: number } = {},
  ): Promise<RecentHistoryPage> {
    const { signal, count = 499, onStatus } = options
    signal?.throwIfAborted()
    if (!isCTraderTimeframe(timeframe)) throw new Error(`cTrader 不支持的原生周期：${timeframe}`)
    if (!Number.isInteger(count) || count < 1 || count > HISTORY_PAGE_SIZE) throw new Error('cTrader K 线数量超出范围')
    if (!Number.isFinite(to) || to < 0) return { candles: [], nextTo: -1 }
    const latest = Math.floor(Math.min(MAX_TIMESTAMP, to, this.now()) / MINUTE) * MINUTE
    const instrument = await this.getInstrument(symbol, signal)
    const series = `${instrument.id}:${timeframe}`
    return this.queueHistoryRead(series, signal, async () => {
      const key = `${series}:${count}:${latest}`
      const cached = this.recentHistory.get(key)
      if (cached && cached.expires > this.now()) return cached
      onStatus?.('正在读取 cTrader 最近的原生 K 线')
      try {
        const page = await this.readRecentCandles(instrument, timeframe, latest, count, signal)
        const cachedPage = { ...page, expires: this.historyExpiry(latest, page.candles) }
        this.rememberHistory(this.recentHistory, key, 16, cachedPage)
        return cachedPage
      } finally {
        onStatus?.('')
      }
    })
  }

  private async readRecentCandles(
    instrument: Instrument, timeframe: CTraderTimeframe, end: number, count: number, signal?: AbortSignal,
  ): Promise<RecentHistoryPage> {
    const step = nextOpenTime(0, timeframe)
    // A provider-side count can jump over a closure without requesting each empty chart window.
    const span = Math.min(365 * DAY, Math.max(7 * DAY, 2 * step * count))
    const candlesByOpen = new Map<number, MarketCandle>()
    for (let page = 0; page < RECENT_HISTORY_MAX_PAGES && end >= 0 && candlesByOpen.size < count; page++) {
      signal?.throwIfAborted()
      const start = Math.max(0, end - span)
      const response = await this.getHistoryPage(
        instrument, timeframe, start, end, count - candlesByOpen.size, signal,
      )
      end = appendHistoryPage(candlesByOpen, response, start, end)
    }
    const candles = [...candlesByOpen.values()].sort((left, right) => left.openTime - right.openTime).slice(-count)
    return { candles, nextTo: end }
  }

  private queueHistoryRead<T>(series: string, signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
    const previous = this.historyReads.get(series) ?? Promise.resolve()
    const pending = previous.then(() => {
      signal?.throwIfAborted()
      return read()
    })
    const settled = pending.then(() => {}, () => {})
    this.historyReads.set(series, settled)
    void settled.then(() => {
      if (this.historyReads.get(series) === settled) this.historyReads.delete(series)
    })
    return waitForCTraderResult(pending, signal)
  }

  private historyExpiry(to: number, candles: readonly MarketCandle[]): number {
    const now = this.now()
    let expires = now + (to >= now - MINUTE ? 2_000 : 5 * MINUTE)
    for (const candle of candles) {
      if (!candle.isClosed) expires = Math.min(expires, now + 2_000, candle.closeTime + 1)
    }
    return expires
  }

  private rememberHistory<T>(cache: Map<string, T>, key: string, limit: number, value: T): void {
    cache.delete(key)
    cache.set(key, value)
    if (cache.size > limit) cache.delete(cache.keys().next().value!)
  }

  async loadTicks(symbol: string, from: number, to: number, signal?: AbortSignal): Promise<CTraderTick[]> {
    signal?.throwIfAborted()
    const end = Math.min(to, this.now(), MAX_TIMESTAMP - 1)
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(end) || from < 0 || end - from >= 7 * DAY) {
      throw new Error('cTrader Tick 历史请求时间范围无效')
    }
    if (from > end) return []
    const instrument = await this.getInstrument(symbol, signal)
    return this.getTickRange(instrument, from, end, signal)
  }

  private async getTickRange(instrument: Instrument, from: number, to: number, signal?: AbortSignal): Promise<CTraderTick[]> {
    const payload = await this.requestHistory(CTraderMessage.GetTicks, {
      // The quote API includes the start and excludes the end.
      symbolId: instrument.id, type: 1, fromTimestamp: from, toTimestamp: to + 1,
    }, signal)
    if (payload.hasMore === true) {
      if (from === to) throw new Error('cTrader 单毫秒 Tick 数量超过接口限制')
      const middle = from + Math.floor((to - from) / 2)
      const earlier = await this.getTickRange(instrument, from, middle, signal)
      const later = await this.getTickRange(instrument, middle + 1, to, signal)
      return earlier.concat(later)
    }
    const rows = objects(payload.tickData)
    if (typeof payload.hasMore !== 'boolean' ||
      (payload.tickData !== undefined && (!Array.isArray(payload.tickData) || rows.length !== payload.tickData.length))) {
      throw new Error('cTrader 返回了无效的 Tick 历史')
    }
    // The newest row is absolute, followed by signed timestamp and price deltas.
    let timestamp = 0
    let price = 0
    return rows.flatMap((row, index) => {
      const timeValue = cTraderInteger(row.timestamp)
      const priceValue = cTraderInteger(row.tick)
      if (timeValue === undefined || priceValue === undefined || (index > 0 && timeValue > 0)) {
        throw new Error('cTrader 返回了无效的 Tick 报价')
      }
      timestamp += timeValue
      price += priceValue
      if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isSafeInteger(price)) {
        throw new Error('cTrader 返回了无效的 Tick 报价')
      }
      return timestamp >= from && timestamp <= to
        ? [{ timestamp, price: cTraderPrice(price, instrument.symbol.pricePrecision) }]
        : []
    }).reverse()
  }

  subscribe(input: CTraderMarketSubscription): () => void {
    const { timeframe } = input
    if (!isCTraderTimeframe(timeframe)) throw new Error(`cTrader 不支持的原生周期：${timeframe}`)
    const subscription: Subscription = { input, timeframe, status: { ...this.status } }
    this.subscriptions.add(subscription)
    input.onStatus?.({ ...subscription.status })
    this.marketHoursTimer ??= setInterval(() => this.refreshMarketHours(), 30_000)
    this.client.setReconnectEnabled(true)
    if (this.client.sessionId === undefined) void this.client.connect().catch(() => {})
    else this.synchronizeSubscriptions()
    return () => {
      this.subscriptions.delete(subscription)
      if (this.subscriptions.size === 0) {
        this.client.setReconnectEnabled(false)
        clearInterval(this.marketHoursTimer)
        this.marketHoursTimer = undefined
      }
      this.synchronizeSubscriptions()
    }
  }

  dispose(): void {
    this.subscriptions.clear()
    clearInterval(this.marketHoursTimer)
    this.marketHoursTimer = undefined
    this.client.dispose()
  }

  private async getCatalog(options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<Map<string, Instrument>> {
    const { forceRefresh, signal } = options
    signal?.throwIfAborted()
    if (!forceRefresh && this.catalog) return this.catalog
    if (!this.catalogRequest) {
      this.catalogRequest = this.loadCatalog().then(catalog => {
        this.catalog = catalog
        return catalog
      }).finally(() => {
        this.catalogRequest = undefined
      })
    }
    return waitForCTraderResult(this.catalogRequest, signal)
  }

  private async getInstrument(symbol: string, signal?: AbortSignal): Promise<Instrument> {
    const catalog = await this.getCatalog({ signal })
    const instrument = catalog.get(symbol.trim().toUpperCase())
    if (!instrument) throw new Error(`cTrader 账户中找不到品种 ${symbol}`)
    return instrument
  }

  private async loadCatalog(): Promise<Map<string, Instrument>> {
    const session = await this.client.connect()
    const [list, assets] = await Promise.all([
      this.client.request(CTraderMessage.SymbolsList, { includeArchivedSymbols: false }, undefined, session),
      this.client.request(CTraderMessage.AssetList, {}, undefined, session),
    ])
    const currencies = new Map<number, string>()
    for (const asset of objects(assets.asset)) {
      const id = cTraderInteger(asset.assetId)
      const currency = text(asset.name)
      if (id !== undefined && currency !== undefined) currencies.set(id, currency)
    }
    const symbols = new Map<number, CTraderPayload>()
    for (const light of objects(list.symbol)) {
      const id = cTraderInteger(light.symbolId)
      if (id !== undefined && id > 0 && light.enabled !== false && text(light.symbolName)) symbols.set(id, light)
    }
    const result = new Map<string, Instrument>()
    const ids = [...symbols.keys()]
    for (let index = 0; index < ids.length; index += SYMBOL_BATCH_SIZE) {
      const batch = ids.slice(index, index + SYMBOL_BATCH_SIZE)
      const full = await this.client.request(CTraderMessage.SymbolDetail, { symbolId: batch }, undefined, session)
      for (const details of objects(full.symbol)) {
        const id = cTraderInteger(details.symbolId)
        const digits = cTraderInteger(details.digits)
        const light = id === undefined ? undefined : symbols.get(id)
        const symbol = normalizeMarketTicker(light?.symbolName)
        if (id === undefined || !symbol || digits === undefined || digits < 0 || digits > 15) continue
        const step = cTraderInteger(details.stepVolume)
        result.set(symbol, {
          id, details,
          symbol: {
            symbol, baseAsset: currencies.get(cTraderInteger(light?.baseAssetId) ?? -1) ?? symbol,
            quoteAsset: currencies.get(cTraderInteger(light?.quoteAssetId) ?? -1) ?? '',
            description: text(light?.description),
            contractType: 'CFD', status: 'TRADING', onboardDate: 0,
            pricePrecision: digits,
            quantityPrecision: step === undefined || step % 100 === 0 ? 0 : step % 10 === 0 ? 1 : 2,
          },
        })
      }
    }
    this.assetNames = currencies
    return result
  }

  private requestHistory(
    type: typeof CTraderMessage.GetTrendbars | typeof CTraderMessage.GetTicks, payload: CTraderPayload, signal?: AbortSignal,
  ): Promise<CTraderPayload> {
    const response = this.historyQueue.then(async () => {
      signal?.throwIfAborted()
      const delay = this.nextHistoryRequest - Date.now()
      if (delay > 0) await waitForCTraderResult(new Promise(resolve => setTimeout(resolve, delay)), signal)
      const session = await this.client.connect(signal)
      this.nextHistoryRequest = Date.now() + HISTORY_MIN_SPACING_MS
      return this.client.request(type, payload, signal, session)
    })
    this.historyQueue = response.then(() => {}, () => {})
    return waitForCTraderResult(response, signal)
  }

  private async getHistoryPage(
    instrument: Instrument, timeframe: CTraderTimeframe, from: number, to: number, count: number, signal?: AbortSignal,
  ): Promise<HistoryPage> {
    const period = cTraderPeriod(timeframe)
    const response = await this.requestHistory(CTraderMessage.GetTrendbars, {
      symbolId: instrument.id, period, fromTimestamp: from, toTimestamp: to, count,
    }, signal)
    if ((response.symbolId !== undefined && cTraderInteger(response.symbolId) !== instrument.id)
      || (response.period !== undefined && decodePeriod(response.period) !== period)) {
      throw new Error('cTrader 返回了不同品种或周期的历史行情')
    }
    const rows = objects(response.trendbar)
    if (response.trendbar !== undefined && (!Array.isArray(response.trendbar) || rows.length !== response.trendbar.length)) {
      throw new Error('cTrader 返回了无效的历史行情')
    }
    const now = this.now()
    return {
      candles: rows.map(raw => readTrendbar(raw, instrument.symbol, timeframe, now)),
      hasMore: response.hasMore === true,
    }
  }

  private refreshMarketHours(): void {
    if (this.client.sessionId === undefined) return
    const now = this.now()
    for (const subscription of this.subscriptions) {
      if (subscription.status.warning !== MARKET_CLOSED && subscription.status.warning.length > 0) continue
      const instrument = this.catalog?.get(subscription.input.symbol.trim().toUpperCase())
      if (!instrument) continue
      const warning = isInstrumentOpen(instrument.details, now) === false ? MARKET_CLOSED : ''
      if (warning !== subscription.status.warning) this.publishSubscriptionStatus(subscription, { warning })
    }
  }

  private connectionChanged(status: LiveMarketStatus): void {
    this.status = status
    for (const subscription of this.subscriptions) {
      subscription.status = { ...status }
      subscription.input.onStatus?.({ ...status })
    }
    if (status.connection === 'connected') this.synchronizeSubscriptions()
  }

  private synchronizeSubscriptions(): void {
    const session = this.client.sessionId
    if (session === undefined) return
    this.subscriptionQueue = this.subscriptionQueue.then(async () => {
      if (this.client.sessionId !== session) return
      if (this.subscriptionSession !== session) {
        this.subscriptionSession = session
        this.activeSpots.clear()
        this.activeTrendbars.clear()
      }
      const catalog = this.subscriptions.size > 0 ? await this.getCatalog() : this.catalog
      if (this.client.sessionId !== session) return
      const wantedSpots = new Set<number>()
      const wantedTrendbars = new Map<string, ActiveTrendbar>()
      for (const subscription of this.subscriptions) {
        const symbol = subscription.input.symbol.trim().toUpperCase()
        const instrument = catalog?.get(symbol)
        if (!instrument) {
          this.publishSubscriptionStatus(subscription, { warning: `cTrader 账户中找不到品种 ${symbol}` })
          continue
        }
        const period = cTraderPeriod(subscription.timeframe)
        wantedSpots.add(instrument.id)
        wantedTrendbars.set(`${instrument.id}:${period}`, { symbolId: instrument.id, period })
        const isOpen = isInstrumentOpen(instrument.details, this.now())
        this.publishSubscriptionStatus(subscription, { warning: isOpen === false ? MARKET_CLOSED : '' })
      }
      for (const [key, trendbar] of this.activeTrendbars) {
        if (wantedTrendbars.has(key)) continue
        await this.client.request(CTraderMessage.UnsubscribeTrendbar, { ...trendbar }, undefined, session)
        this.activeTrendbars.delete(key)
      }
      const removedSpots = [...this.activeSpots].filter(id => !wantedSpots.has(id))
      if (removedSpots.length > 0) {
        await this.client.request(CTraderMessage.UnsubscribeSpots, { symbolId: removedSpots }, undefined, session)
        removedSpots.forEach(id => this.activeSpots.delete(id))
      }
      const addedSpots = [...wantedSpots].filter(id => !this.activeSpots.has(id))
      if (addedSpots.length > 0) {
        await this.client.request(CTraderMessage.SubscribeSpots, {
          symbolId: addedSpots, subscribeToSpotTimestamp: true,
        }, undefined, session)
        addedSpots.forEach(id => this.activeSpots.add(id))
      }
      for (const [key, trendbar] of wantedTrendbars) {
        if (this.activeTrendbars.has(key)) continue
        await this.client.request(CTraderMessage.SubscribeTrendbar, { ...trendbar }, undefined, session)
        this.activeTrendbars.set(key, trendbar)
      }
    }).catch(error => {
      if (this.client.sessionId !== session) return
      for (const subscription of this.subscriptions) {
        this.publishSubscriptionStatus(subscription, { warning: error instanceof Error ? error.message : 'cTrader 行情订阅失败' })
      }
    })
  }

  private onSpot(payload: CTraderPayload): void {
    const id = cTraderInteger(payload.symbolId)
    if (id === undefined) return
    const now = this.now()
    const timestamp = cTraderInteger(payload.timestamp)
    const time = timestamp ?? now
    const rawBid = cTraderInteger(payload.bid)
    const rawAsk = cTraderInteger(payload.ask)
    const trendbars = objects(payload.trendbar)
    for (const subscription of this.subscriptions) {
      const instrument = this.catalog?.get(subscription.input.symbol.trim().toUpperCase())
      if (instrument?.id !== id) continue
      const digits = instrument.symbol.pricePrecision
      const bid = rawBid === undefined ? undefined : cTraderPrice(rawBid, digits)
      const ask = rawAsk === undefined ? undefined : cTraderPrice(rawAsk, digits)
      const period = cTraderPeriod(subscription.timeframe)
      let closed = false
      let invalid = false
      let nativeUpdate: MarketCandle | undefined
      for (const raw of trendbars) {
        if (decodePeriod(raw.period ?? 1) !== period) continue
        let candle: MarketCandle
        try {
          candle = readTrendbar(raw, instrument.symbol, subscription.timeframe, time)
        } catch {
          invalid = true
          continue
        }
        // Some spot payloads also include a snapshot of the active interval.
        if (!candle.isClosed) {
          if (candle.openTime <= time) nativeUpdate = candle
          continue
        }
        if (subscription.lastClosedOpen !== undefined && candle.openTime <= subscription.lastClosedOpen) continue
        subscription.lastClosedOpen = candle.openTime
        if (subscription.forming && subscription.forming.openTime <= candle.openTime) subscription.forming = undefined
        subscription.input.onCandle(candle)
        closed = true
      }
      const lastBidTime = subscription.lastBidTime ?? -1
      if (time >= lastBidTime) {
        if (bid !== undefined) {
          subscription.lastBid = bid
          subscription.lastBidTime = time
          updateFormingCandle(subscription, instrument, time, bid, nativeUpdate)
        } else if (nativeUpdate) {
          const price = lastBidTime >= nativeUpdate.openTime ? subscription.lastBid ?? nativeUpdate.close : nativeUpdate.close
          updateFormingCandle(subscription, instrument, time, price, nativeUpdate)
        }
      }
      this.publishSubscriptionStatus(subscription, {
        lastPrice: subscription.lastBid ?? ask ?? subscription.status.lastPrice,
        lastMessageTime: time,
        latencyMs: timestamp === undefined ? null : Math.max(0, now - timestamp),
        candleClosed: subscription.forming && time <= subscription.forming.closeTime ? false : closed ? true : subscription.status.candleClosed,
        warning: invalid ? 'cTrader 返回了无效的实时 K 线' : subscription.status.warning === MARKET_CLOSED ? MARKET_CLOSED : '',
      })
    }
  }

  private publishSubscriptionStatus(subscription: Subscription, status: Partial<LiveMarketStatus>): void {
    subscription.status = { ...subscription.status, ...status }
    subscription.input.onStatus?.({ ...subscription.status })
  }
}
