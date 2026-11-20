import {
  CTraderClient, CTraderMessage, cTraderInteger, cTraderObject, waitForCTraderResult,
  type CTraderPayload,
} from './ctrader-client'
import { CTRADER_TIMEFRAMES, isCTraderTimeframe, nextOpenTime, type CTraderTimeframe } from './intervals'
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

interface HistoryLoadOptions {
  signal?: AbortSignal
  onStatus?: (status: string) => void
}

interface HistoryRange {
  from: number
  to: number
  expires: number
  candles: MarketCandle[]
}

interface HistoryPage {
  candles: MarketCandle[]
  hasMore: boolean
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
  onStatus?(status: LiveMarketStatus): void
}

interface Subscription {
  input: CTraderMarketSubscription
  timeframe: CTraderTimeframe
  status: LiveMarketStatus
  lastClosedOpen?: number
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
  private historyQueue = Promise.resolve()
  private nextHistoryRequest = 0
  private readonly history = new Map<string, HistoryRange>()
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
      if (type === CTraderMessage.SymbolChanged) this.catalog = undefined
    })
  }

  async getSymbols(options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<MarketSymbol[]> {
    const catalog = await this.getCatalog(options)
    return [...catalog.values()].map(instrument => ({ ...instrument.symbol }))
  }

  async isMarketOpen(symbol: string, timestamp = this.now(), signal?: AbortSignal): Promise<boolean | null> {
    const instrument = await this.getInstrument(symbol, signal)
    return isInstrumentOpen(instrument.details, timestamp)
  }

  async loadCandles(
    kind: 'trade', symbol: string, timeframe: string, from: number, to: number,
    options: HistoryLoadOptions = {},
  ): Promise<MarketCandle[]> {
    const { signal, onStatus } = options
    signal?.throwIfAborted()
    if (kind !== 'trade' || !isCTraderTimeframe(timeframe)) throw new Error(`cTrader 不支持此 K 线类型或周期：${timeframe}`)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return []
    const requestedFrom = Math.max(0, Math.ceil(from))
    const requestedTo = Math.min(MAX_TIMESTAMP, Math.floor(to), this.now())
    if (requestedFrom > requestedTo) return []
    const instrument = await this.getInstrument(symbol, signal)
    const key = `${instrument.id}:${timeframe}:`
    for (const [cacheKey, range] of this.history) {
      if (cacheKey.startsWith(key) && range.expires > this.now() && range.from <= requestedFrom && range.to >= requestedTo) {
        return range.candles.filter(candle => candle.openTime >= requestedFrom && candle.openTime <= requestedTo)
      }
    }
    onStatus?.('正在读取 cTrader 原生 K 线')
    const candlesByOpen = new Map<number, MarketCandle>()
    let end = requestedTo
    while (end >= requestedFrom) {
      signal?.throwIfAborted()
      // Bound both the nominal history span and the number of bars per request.
      const step = nextOpenTime(0, timeframe)
      const pageSpan = Math.min(step * (HISTORY_PAGE_SIZE - 1), 365 * DAY)
      const start = Math.max(requestedFrom, end - pageSpan)
      const page = await this.getHistoryPage(
        instrument, timeframe, Math.max(0, start - 1), end, HISTORY_PAGE_SIZE, signal,
      )
      end = appendHistoryPage(candlesByOpen, page, start, end)
    }
    const candles = [...candlesByOpen.values()].sort((left, right) => left.openTime - right.openTime)
    const nextExpiry = candles.some(candle => !candle.isClosed) ? 2_000 : 60_000
    if (candles.length <= 4_000) {
      this.history.set(key + requestedFrom + ':' + requestedTo, {
        from: requestedFrom, to: requestedTo, expires: this.now() + nextExpiry, candles,
      })
      if (this.history.size > 32) this.history.delete(this.history.keys().next().value!)
    }
    onStatus?.('')
    return candles
  }

  async loadRecentCandles(
    symbol: string, timeframe: string, to: number, options: HistoryLoadOptions & { count?: number } = {},
  ): Promise<MarketCandle[]> {
    const { signal, count = 499, onStatus } = options
    signal?.throwIfAborted()
    if (!isCTraderTimeframe(timeframe)) throw new Error(`cTrader 不支持的原生周期：${timeframe}`)
    if (!Number.isInteger(count) || count < 1 || count > HISTORY_PAGE_SIZE) throw new Error('cTrader K 线数量超出范围')
    if (!Number.isFinite(to) || to < 0) return []
    let end = Math.min(MAX_TIMESTAMP, Math.floor(to), this.now())
    const instrument = await this.getInstrument(symbol, signal)
    const step = nextOpenTime(0, timeframe)
    // A provider-side count can jump over a closure without requesting each empty chart window.
    const span = Math.min(365 * DAY, Math.max(7 * DAY, 2 * step * count))
    const candlesByOpen = new Map<number, MarketCandle>()
    onStatus?.('正在读取 cTrader 最近的原生 K 线')
    for (let page = 0; page < RECENT_HISTORY_MAX_PAGES && end >= 0 && candlesByOpen.size < count; page++) {
      signal?.throwIfAborted()
      const start = Math.max(0, end - span)
      const response = await this.getHistoryPage(
        instrument, timeframe, start, end, count - candlesByOpen.size, signal,
      )
      end = appendHistoryPage(candlesByOpen, response, start, end)
    }
    onStatus?.('')
    return [...candlesByOpen.values()].sort((left, right) => left.openTime - right.openTime).slice(-count)
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
    const currencies = new Map(objects(assets.asset).map(asset => [cTraderInteger(asset.assetId), text(asset.name)]))
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
            symbol, baseAsset: currencies.get(cTraderInteger(light?.baseAssetId)) ?? symbol,
            quoteAsset: currencies.get(cTraderInteger(light?.quoteAssetId)) ?? '',
            description: text(light?.description),
            contractType: 'CFD', status: 'TRADING', onboardDate: 0,
            pricePrecision: digits,
            quantityPrecision: step === undefined || step % 100 === 0 ? 0 : step % 10 === 0 ? 1 : 2,
          },
        })
      }
    }
    return result
  }

  private requestHistory(payload: CTraderPayload, signal?: AbortSignal): Promise<CTraderPayload> {
    const response = this.historyQueue.then(async () => {
      signal?.throwIfAborted()
      const delay = this.nextHistoryRequest - Date.now()
      if (delay > 0) await waitForCTraderResult(new Promise(resolve => setTimeout(resolve, delay)), signal)
      const session = await this.client.connect(signal)
      this.nextHistoryRequest = Date.now() + HISTORY_MIN_SPACING_MS
      return this.client.request(CTraderMessage.GetTrendbars, payload, signal, session)
    })
    this.historyQueue = response.then(() => {}, () => {})
    return waitForCTraderResult(response, signal)
  }

  private async getHistoryPage(
    instrument: Instrument, timeframe: CTraderTimeframe, from: number, to: number, count: number, signal?: AbortSignal,
  ): Promise<HistoryPage> {
    const period = cTraderPeriod(timeframe)
    const response = await this.requestHistory({
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
      for (const raw of trendbars) {
        if (decodePeriod(raw.period ?? 1) !== period) continue
        let candle: MarketCandle
        try {
          // Spot events expose the most recently closed native bar.
          candle = readTrendbar(raw, instrument.symbol, subscription.timeframe, Infinity)
        } catch {
          invalid = true
          continue
        }
        if (subscription.lastClosedOpen !== undefined && candle.openTime <= subscription.lastClosedOpen) continue
        subscription.lastClosedOpen = candle.openTime
        subscription.input.onCandle(candle)
        closed = true
      }
      this.publishSubscriptionStatus(subscription, {
        lastPrice: bid ?? ask ?? subscription.status.lastPrice,
        lastMessageTime: timestamp ?? now,
        latencyMs: timestamp === undefined ? null : Math.max(0, now - timestamp),
        candleClosed: closed ? true : subscription.status.candleClosed,
        warning: invalid ? 'cTrader 返回了无效的实时 K 线' : subscription.status.warning === MARKET_CLOSED ? MARKET_CLOSED : '',
      })
    }
  }

  private publishSubscriptionStatus(subscription: Subscription, status: Partial<LiveMarketStatus>): void {
    subscription.status = { ...subscription.status, ...status }
    subscription.input.onStatus?.({ ...subscription.status })
  }
}
