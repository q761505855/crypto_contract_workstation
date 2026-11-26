import Decimal from 'decimal.js'
import type { ChartPriceMarket } from '../ctrader-datafeed'
import type { CTraderTick } from '../ctrader-market'
import { alignOpenTime, nextOpenTime, shiftOpenTime } from '../intervals'
import { INITIAL_LIVE_STATUS } from '../live-models'
import type { MarketCandle, MarketSymbol } from '../models'
import { validateOkxTradingTerms, type OkxReplayRisk, type OkxTradingTerms } from '../../simulation/okx-trading'
import { rememberOkxInstrument } from './trades'
import { readOkxTradePages } from './live'

const bars: Record<string, string> = {
  '1m': '1m', '2m': '1m', '3m': '3m', '4m': '1m', '5m': '5m', '10m': '5m',
  '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '12h': '12Hutc',
  '1d': '1Dutc', '1w': '1Wutc', '1M': '1Mutc',
}
const syntheticPeriods: Record<string, string> = { '2m': '1m', '4m': '1m', '10m': '5m' }
const PAGE_SIZE = 300
const OKX_URL = 'https://www.okx.com/api/v5'
const OKX_SOCKET = 'wss://ws.okx.com/ws/v5/business'
const CATALOG_LIFETIME = 5 * 60_000

interface Instrument {
  symbol: MarketSymbol
  family: string
  terms: Omit<OkxTradingTerms, 'tiers'>
}

const tickerPattern = /^([A-Z0-9]+)-USDT-SWAP$/
const decimalText = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))
const positive = (value: unknown): value is string => decimalText(value) && Number(value) > 0

function instrumentFromRow(value: unknown): Instrument | undefined {
  const row = value as Record<string, unknown> | null
  if (!row || row.state !== 'live' || row.ctType !== 'linear' || row.settleCcy !== 'USDT' ||
      typeof row.instId !== 'string' || typeof row.instFamily !== 'string') return
  const base = tickerPattern.exec(row.instId)?.[1]
  if (!base || !positive(row.ctVal) || !positive(row.minSz) || !positive(row.lotSz) ||
      !positive(row.tickSz) || !positive(row.maxMktSz) || !positive(row.lever)) return
  const contractValue = new Decimal(row.ctVal).mul(positive(row.ctMult) ? row.ctMult : 1)
  return {
    symbol: {
      exchange: 'OKX', symbol: row.instId, baseAsset: base, quoteAsset: 'USDT', contractType: 'PERPETUAL',
      status: 'TRADING', onboardDate: Number(row.listTime) || 0, pricePrecision: new Decimal(row.tickSz).decimalPlaces(),
      quantityPrecision: Math.max(3, contractValue.mul(row.lotSz).decimalPlaces()), description: `${base} / USDT 永续合约`,
    },
    family: row.instFamily,
    terms: { accountCurrency: 'USDT', contractValue: contractValue.toString(), minContracts: row.minSz,
      contractStep: row.lotSz, maxOrderContracts: row.maxMktSz, maxLeverage: Number(row.lever), tickSize: row.tickSz },
  }
}

function readCandle(value: unknown, symbol: string, timeframe: string): MarketCandle {
  if (!Array.isArray(value) || value.length < 9) throw new Error('OKX K 线格式无效')
  const [time, open, high, low, close, , volume, quoteVolume, confirmed] = value
  const openTime = Number(time)
  if (typeof time !== 'string' || !/^\d+$/.test(time) || !Number.isSafeInteger(openTime) || openTime <= 0 ||
      ![open, high, low, close].every(positive) || ![volume, quoteVolume].every(decimalText) ||
      Number(low) > Math.min(Number(open), Number(close)) || Number(high) < Math.max(Number(open), Number(close)) ||
      (confirmed !== '0' && confirmed !== '1')) throw new Error('OKX K 线字段无效')
  return { symbol, timeframe, openTime, closeTime: nextOpenTime(openTime, timeframe) - 1,
    open, high, low, close, volume, quoteVolume, tradeCount: 0, isClosed: confirmed === '1', source: 'okx' }
}

function groupCandles(rows: MarketCandle[], timeframe: string): MarketCandle[] {
  const native = syntheticPeriods[timeframe]
  if (!native) return rows
  const grouped = new Map<number, MarketCandle>()
  for (const bar of rows) {
    const openTime = alignOpenTime(bar.openTime, timeframe, 'floor')
    const closeTime = nextOpenTime(openTime, timeframe) - 1
    const previous = grouped.get(openTime)
    // Require a continuous prefix, including the first child, before publishing a synthetic bar.
    if ((previous?.closeTime ?? openTime - 1) + 1 !== bar.openTime) continue
    grouped.set(openTime, {
      ...bar, timeframe, openTime,
      closeTime: bar.closeTime, open: previous?.open ?? bar.open,
      high: previous && Number(previous.high) > Number(bar.high) ? previous.high : bar.high,
      low: previous && Number(previous.low) < Number(bar.low) ? previous.low : bar.low,
      volume: new Decimal(previous?.volume ?? 0).plus(bar.volume).toString(),
      quoteVolume: new Decimal(previous?.quoteVolume ?? 0).plus(bar.quoteVolume).toString(),
      isClosed: (previous?.isClosed ?? true) && bar.isClosed,
    })
    if (bar.closeTime > closeTime) throw new Error('OKX K 线周期对齐失败')
  }
  return [...grouped.values()].map(bar => {
    const closeTime = nextOpenTime(bar.openTime, timeframe) - 1
    return { ...bar, closeTime, isClosed: bar.isClosed && bar.closeTime === closeTime }
  })
}

export class OkxMarketService implements ChartPriceMarket {
  readonly source = 'okx'
  readonly tickWindowMs = 60_000
  private catalog = new Map<string, Instrument>()
  private catalogExpires = 0
  private catalogRequest?: Promise<MarketSymbol[]>
  private nextCandleRequest = 0
  private readonly markWindows = new Map<string, { from: number; to: number; bars: Map<number, MarketCandle> }>()
  private readonly fundingMonths = new Map<string, { expires: number; rows: { timestamp: number; rate: string }[] }>()
  private readonly stops = new Set<() => void>()

  constructor(private readonly fetcher: typeof fetch = fetch,
    private readonly connect = (url: string) => new WebSocket(url), private readonly now = Date.now) {}

  async getSymbols({ forceRefresh = false, signal }: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<MarketSymbol[]> {
    signal?.throwIfAborted()
    if (!forceRefresh && this.catalogExpires > this.now()) return [...this.catalog.values()].map(row => row.symbol)
    this.catalogRequest ??= this.request('public/instruments', { instType: 'SWAP' }).then(rows => {
      const catalog = new Map<string, Instrument>()
      for (const row of rows) {
        const instrument = instrumentFromRow(row)
        if (!instrument) continue
        const { symbol, terms } = instrument
        catalog.set(symbol.symbol, instrument)
        if (symbol.onboardDate > 0) rememberOkxInstrument({ symbol: symbol.symbol, contractValue: Number(terms.contractValue),
          firstDay: new Date(symbol.onboardDate).toISOString().slice(0, 10) })
      }
      if (!catalog.size) throw new Error('OKX 未返回可用的 USDT 永续合约')
      this.catalog = catalog
      this.catalogExpires = this.now() + CATALOG_LIFETIME
      return [...catalog.values()].map(row => row.symbol)
    }).finally(() => { this.catalogRequest = undefined })
    const symbols = await this.catalogRequest
    signal?.throwIfAborted()
    return symbols
  }

  async getReplayTradingTerms(symbol: string, _start: number, signal?: AbortSignal): Promise<OkxTradingTerms> {
    await this.getSymbols({ signal })
    const instrument = this.catalog.get(symbol)
    if (!instrument) throw new Error('OKX 品种不在当前 USDT 永续交易目录中')
    const rows = await this.request('public/position-tiers', { instType: 'SWAP', tdMode: 'isolated', instFamily: instrument.family }, signal)
    const tiers = rows.flatMap(value => {
      const row = value as Record<string, unknown> | null
      if (!row || row.instFamily !== instrument.family || !positive(row.maxSz) || !decimalText(row.mmr) || !positive(row.maxLever)) return []
      return [{ maxContracts: row.maxSz, maxLeverage: Number(row.maxLever), maintenanceMarginRate: row.mmr }]
    }).sort((left, right) => new Decimal(left.maxContracts).cmp(right.maxContracts))
    const terms = { ...instrument.terms, tiers }
    validateOkxTradingTerms(terms)
    return terms
  }

  async getReplayRisk(candle: MarketCandle, from: number, signal: AbortSignal): Promise<OkxReplayRisk> {
    const risk: OkxReplayRisk = { funding: [] }
    const warnings: string[] = []
    try {
      if (bars[candle.timeframe]) risk.mark = await this.markAt(candle.symbol, candle.timeframe, candle.openTime, signal)
    } catch { signal.throwIfAborted() }
    if (!risk.mark) warnings.push('缺少 OKX 标记价格，当前步以成交价估算强平')
    const recent = this.now() - 90 * 86_400_000
    // OKX publishes only recent funding history. Never synthesize older rates.
    if (from < recent) warnings.push('较早的 OKX 资金费率超出公开历史范围')
    try {
      for (let month = alignOpenTime(Math.max(from, recent), '1M', 'floor'); month <= candle.closeTime; month = nextOpenTime(month, '1M')) {
        const rows = await this.fundingMonth(candle.symbol, month, signal)
        for (const { timestamp, rate } of rows) {
          if (timestamp < Math.max(from, recent) || timestamp > candle.closeTime || new Decimal(rate).isZero()) continue
          const timeframe = timestamp % 3_600_000 === 0 ? '1h' : '1m'
          const mark = await this.markAt(candle.symbol, timeframe, alignOpenTime(timestamp, timeframe, 'floor'), signal)
          if (mark) risk.funding.push({ timestamp, rate, price: mark.open })
          else if (!warnings.includes('部分 OKX 资金费缺少结算标记价格')) warnings.push('部分 OKX 资金费缺少结算标记价格')
        }
      }
    } catch {
      signal.throwIfAborted()
      warnings.push('部分 OKX 历史资金费率暂不可用')
    }
    if (warnings.length) risk.warning = warnings.join(' · ')
    return risk
  }

  async loadTicks(symbol: string, from: number, to: number, signal = new AbortController().signal): Promise<CTraderTick[]> {
    const now = new Date(this.now())
    const earliest = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, now.getUTCDate())
    if (from < earliest) throw new Error('OKX 在线逐笔仅提供最近三个月的成交。更早的回放可使用 OKX-本地日档。')
    await this.getSymbols({ signal })
    const instrument = this.catalog.get(symbol)
    if (!instrument) throw new Error('OKX 品种不在当前 USDT 永续交易目录中')
    const ticks: CTraderTick[] = []
    const tradeInstrument = { symbol, contractValue: Number(instrument.terms.contractValue),
      firstDay: new Date(instrument.symbol.onboardDate).toISOString().slice(0, 10) }
    for await (const { rows } of readOkxTradePages(tradeInstrument, from * 1000, (to + 1) * 1000, signal, this.fetcher)) {
      for (let index = rows.length - 1; index >= 0; index--) {
        const trade = rows[index]
        ticks.push({ timestamp: Math.floor(trade.timeUs / 1000), timeUs: trade.timeUs,
          price: String(trade.price), size: trade.size })
      }
    }
    return ticks.reverse()
  }

  private async markAt(symbol: string, timeframe: string, time: number, signal: AbortSignal): Promise<MarketCandle | undefined> {
    const key = `${symbol}:${timeframe}`
    let window = this.markWindows.get(key)
    if (!window || time < window.from || time > window.to) {
      const to = Math.min(shiftOpenTime(time, timeframe, 120) - 1, this.now())
      const rows = await this.readNative(symbol, timeframe, time, to, signal, false, true)
      window = { from: time, to, bars: new Map(groupCandles(rows, timeframe).map(bar => [bar.openTime, bar])) }
      this.markWindows.set(key, window)
      if (this.markWindows.size > 24) this.markWindows.delete(this.markWindows.keys().next().value!)
    }
    return window.bars.get(time)
  }

  private async fundingMonth(symbol: string, month: number, signal: AbortSignal) {
    const key = `${symbol}:${month}`
    const cached = this.fundingMonths.get(key)
    if (cached && cached.expires > this.now()) return cached.rows
    const rows = new Map<number, string>()
    const end = nextOpenTime(month, '1M')
    let cursor = Math.min(end, this.now() + 1)
    while (cursor > month) {
      const page = await this.request('public/funding-rate-history', { instId: symbol, after: String(cursor), limit: '100' }, signal)
      let oldest = cursor
      for (const value of page) {
        const row = value as Record<string, unknown>
        const timestamp = Number(row?.fundingTime)
        if (row?.instId !== symbol || !Number.isSafeInteger(timestamp) || timestamp >= cursor || timestamp <= 0) continue
        oldest = Math.min(oldest, timestamp)
        if (timestamp >= month && typeof row.realizedRate === 'string' &&
            /^-?\d+(?:\.\d+)?$/.test(row.realizedRate) && Number.isFinite(Number(row.realizedRate))) rows.set(timestamp, row.realizedRate)
      }
      if (page.length < 100 || oldest <= month) break
      if (oldest === cursor) throw new Error('OKX 历史资金费率分页未推进')
      cursor = oldest
      await new Promise(resolve => setTimeout(resolve, 225))
      signal.throwIfAborted()
    }
    const result = [...rows].sort(([left], [right]) => left - right).map(([timestamp, rate]) => ({ timestamp, rate }))
    this.fundingMonths.set(key, { rows: result, expires: end <= this.now() ? Infinity : this.now() + 60_000 })
    if (this.fundingMonths.size > 16) this.fundingMonths.delete(this.fundingMonths.keys().next().value!)
    return result
  }

  async loadCandles(_kind: 'trade', symbol: string, timeframe: string, from: number, to: number,
    { signal }: { signal?: AbortSignal } = {}): Promise<MarketCandle[]> {
    if (from > to) return []
    const end = Math.min(nextOpenTime(alignOpenTime(to, timeframe, 'floor'), timeframe) - 1, this.now())
    const rows = await this.readNative(symbol, timeframe, from, end, signal)
    return groupCandles(rows, timeframe).filter(bar => bar.openTime >= from && bar.openTime <= to)
  }

  async loadRecentCandles(symbol: string, timeframe: string, to: number, options: { signal?: AbortSignal }) {
    return (await this.loadRecentCandlesPage(symbol, timeframe, to, options)).candles
  }

  async loadRecentCandlesPage(symbol: string, timeframe: string, to: number, { signal }: { signal?: AbortSignal }) {
    const edge = alignOpenTime(to, timeframe, 'floor')
    const end = Math.min(nextOpenTime(edge, timeframe) - 1, this.now())
    const rows = await this.readNative(symbol, timeframe, 0, end, signal, true)
    const candles = groupCandles(rows, timeframe)
    return { candles, nextTo: rows.length ? alignOpenTime(rows[0].openTime, timeframe, 'floor') - 1 : -1 }
  }

  private async readNative(symbol: string, timeframe: string, from: number, to: number,
    signal?: AbortSignal, singlePage = false, mark = false): Promise<MarketCandle[]> {
    const bar = bars[timeframe]
    if (!bar || !tickerPattern.test(symbol) || to < from) return []
    const native = syntheticPeriods[timeframe] ?? timeframe
    const rows = new Map<number, MarketCandle>()
    let cursor = to + 1
    while (cursor > from) {
      const wait = Math.max(0, this.nextCandleRequest - performance.now())
      this.nextCandleRequest = performance.now() + wait + 115
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      signal?.throwIfAborted()
      const atLiveEdge = cursor > this.now() - 1_000
      const series = mark ? 'mark-price-candles' : 'candles'
      const limit = mark ? 100 : PAGE_SIZE
      const page = await this.request(`market/${atLiveEdge ? '' : 'history-'}${series}`,
        { instId: symbol, bar, limit: String(limit), ...(atLiveEdge ? {} : { after: String(cursor) }) }, signal)
      let oldest = cursor
      for (const value of page) {
        const row = mark && Array.isArray(value) ? [...value.slice(0, 5), '0', '0', '0', value[5]] : value
        const candle = readCandle(row, symbol, native)
        if (candle.openTime >= cursor) continue
        oldest = Math.min(oldest, candle.openTime)
        if (candle.openTime >= from) rows.set(candle.openTime, candle)
      }
      if (page.length === 0) break
      if (oldest === cursor) throw new Error('OKX 历史 K 线分页未推进')
      if (singlePage || oldest <= from || (page.length < limit && !atLiveEdge)) break
      cursor = oldest
    }
    return [...rows.values()].sort((a, b) => a.openTime - b.openTime)
  }

  private async request(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown[]> {
    const timeout = AbortSignal.timeout(12_000)
    const response = await this.fetcher.call(globalThis, `${OKX_URL}/${path}?${new URLSearchParams(params)}`, {
      credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) throw new Error(`OKX 行情读取失败（HTTP ${response.status}）`)
    const value = await response.json()
    if (value?.code !== '0' || !Array.isArray(value.data)) throw new Error(`OKX 行情读取失败${value?.code ? `（${value.code}）` : ''}`)
    return value.data
  }

  subscribe({ symbol, timeframe, getHistoryCandle, onCandle, onStatus }: Parameters<ChartPriceMarket['subscribe']>[0]): () => void {
    if (!tickerPattern.test(symbol) || !bars[timeframe]) return () => {}
    const subscription = { channel: `candle${bars[timeframe]}`, instId: symbol }
    const native = syntheticPeriods[timeframe] ?? timeframe
    let socket: WebSocket | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    let stopped = false
    let latest: MarketCandle | undefined
    let seed: AbortController | undefined
    const liveRows = new Map<number, MarketCandle>()

    const emit = () => {
      const grouped = groupCandles([...liveRows.values()].sort((a, b) => a.openTime - b.openTime), timeframe)
      let emitted = false
      for (const candle of grouped) {
        const known = latest ?? getHistoryCandle()
        if (known && (candle.openTime < known.openTime ||
            (candle.openTime === known.openTime && known.isClosed && !candle.isClosed))) continue
        latest = candle
        emitted = true
        onCandle(candle)
      }
      if (emitted && latest) onStatus({ ...INITIAL_LIVE_STATUS, connection: 'connected', lastMessageTime: this.now(),
        lastPrice: latest.close, candleClosed: latest.isClosed })
      if (grouped.length) {
        const active = grouped.at(-1)!.openTime
        for (const time of liveRows.keys()) if (time < active) liveRows.delete(time)
      }
    }
    const reconnect = () => {
      clearInterval(heartbeat)
      seed?.abort()
      seed = undefined
      liveRows.clear()
      if (stopped) return
      attempts += 1
      onStatus({ ...INITIAL_LIVE_STATUS, connection: 'reconnecting', reconnectAttempt: attempts, warning: 'OKX 实时连接中断，正在重连' })
      retry = setTimeout(open, Math.min(30_000, 500 * 2 ** Math.min(attempts, 6)))
    }
    const open = () => {
      let client: WebSocket
      try { client = this.connect(OKX_SOCKET) } catch { reconnect(); return }
      socket = client
      let last = this.now()
      let acknowledged = false
      heartbeat = setInterval(() => {
        if (this.now() - last >= 25_000 || (!acknowledged && this.now() - last >= 10_000)) client.close()
        else if (client.readyState === 1) client.send('ping')
      }, 10_000)
      client.onopen = () => {
        if (socket === client) client.send(JSON.stringify({ op: 'subscribe', args: [subscription] }))
      }
      client.onclose = () => { if (socket === client) { socket = undefined; reconnect() } }
      client.onerror = () => client.close()
      client.onmessage = event => {
        if (socket !== client || typeof event.data !== 'string') return
        if (event.data === 'pong') { if (acknowledged) last = this.now(); return }
        try {
          const packet = JSON.parse(event.data)
          if (packet.event === 'error') { client.close(); return }
          if (packet.arg?.channel !== subscription.channel || packet.arg?.instId !== symbol) return
          last = this.now()
          if (packet.event === 'subscribe') {
            acknowledged = true
            attempts = 0
            onStatus({ ...INITIAL_LIVE_STATUS, connection: 'connected' })
            if (native !== timeframe) {
              const pending = new AbortController()
              seed = pending
              const end = this.now()
              void this.readNative(symbol, timeframe, alignOpenTime(end, timeframe, 'floor'), end, pending.signal)
                .then(rows => {
                  if (socket !== client || pending.signal.aborted) return
                  for (const row of rows) if (!liveRows.has(row.openTime)) liveRows.set(row.openTime, row)
                  emit()
                }).catch(() => { /* The next complete streaming bucket can resume without a seed. */ })
            }
            return
          }
          if (!Array.isArray(packet.data)) return
          for (const value of packet.data) {
            const candle = readCandle(value, symbol, native)
            const prior = liveRows.get(candle.openTime)
            if (prior?.isClosed && !candle.isClosed) continue
            liveRows.set(candle.openTime, candle)
          }
          if (liveRows.size) {
            const newest = Math.max(...liveRows.keys())
            const previous = shiftOpenTime(alignOpenTime(newest, timeframe, 'floor'), timeframe, -1)
            for (const time of liveRows.keys()) if (time < previous) liveRows.delete(time)
          }
          emit()
        } catch { client.close() }
      }
    }
    const stop = () => {
      stopped = true
      clearInterval(heartbeat)
      clearTimeout(retry)
      seed?.abort()
      const client = socket
      socket = undefined
      client?.close()
      this.stops.delete(stop)
    }
    this.stops.add(stop)
    onStatus({ ...INITIAL_LIVE_STATUS, connection: 'connecting' })
    open()
    return stop
  }

  dispose(): void {
    for (const stop of this.stops) stop()
  }
}
