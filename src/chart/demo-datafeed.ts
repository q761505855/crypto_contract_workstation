import type {
  Datafeed,
  DatafeedSubscribeCallback,
  Period,
  SymbolInfo,
} from '@klinecharts/pro'
import type { KLineData } from 'klinecharts'

const DEMO_SYMBOLS: readonly SymbolInfo[] = Object.freeze([
  {
    exchange: 'BINANCE',
    market: 'USDT-M PERPETUAL',
    name: 'Bitcoin / Tether USDT Perpetual',
    shortName: 'BTCUSDT',
    ticker: 'BTCUSDT',
    priceCurrency: 'USDT',
    type: 'PERPETUAL',
  },
  {
    exchange: 'BINANCE',
    market: 'USDT-M PERPETUAL',
    name: 'Ethereum / Tether USDT Perpetual',
    shortName: 'ETHUSDT',
    ticker: 'ETHUSDT',
    priceCurrency: 'USDT',
    type: 'PERPETUAL',
  },
])

function periodToMilliseconds(period: Period): number {
  const unitMilliseconds: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000,
  }
  const unit = unitMilliseconds[period.timespan]
  if (unit === undefined) {
    throw new Error('Unsupported demo period: ' + period.timespan)
  }
  return period.multiplier * unit
}

function stableHash(input: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 16_777_619)
  }
  return hash >>> 0
}

function stableUnit(seed: number, bucket: number, salt: number): number {
  let value = (seed ^ Math.imul(bucket, 0x9e3779b1) ^ salt) >>> 0
  value ^= value >>> 16
  value = Math.imul(value, 0x85ebca6b)
  value ^= value >>> 13
  value = Math.imul(value, 0xc2b2ae35)
  value ^= value >>> 16
  return (value >>> 0) / 0x1_0000_0000
}

function candleAt(
  timestamp: number,
  symbol: SymbolInfo,
  period: Period,
  interval: number,
): KLineData {
  const bucket = Math.floor(timestamp / interval)
  const seed = stableHash(
    `${symbol.ticker.toUpperCase()}:${period.multiplier}:${period.timespan}`,
  )
  const baseline =
    60_000 +
    (seed % 500) +
    Math.sin(bucket * 0.11 + (seed % 360)) * 320 +
    Math.cos(bucket * 0.037 + (seed % 97)) * 180
  const open = baseline + (stableUnit(seed, bucket, 0x1a2b3c4d) - 0.5) * 90
  const close = open + (stableUnit(seed, bucket, 0x5e6f7788) - 0.5) * 130
  const volume = 100 + Math.floor(stableUnit(seed, bucket, 0x9abcdeff) * 300)
  const wick = 20 + stableUnit(seed, bucket, 0x10293847) * 35
  return {
    timestamp,
    open,
    high: Math.max(open, close) + wick,
    low: Math.min(open, close) - wick,
    close,
    volume,
    turnover: close * volume,
  }
}

export class DemoDatafeed implements Datafeed {
  constructor(private readonly now: () => number = Date.now) {}

  async searchSymbols(search = ''): Promise<SymbolInfo[]> {
    const normalized = search.trim().toUpperCase()
    return DEMO_SYMBOLS.filter((symbol) =>
      symbol.ticker.toUpperCase().includes(normalized),
    ).map((symbol) => ({ ...symbol }))
  }

  async getHistoryKLineData(
    _symbol: SymbolInfo,
    period: Period,
    from: number,
    to: number,
  ): Promise<KLineData[]> {
    const interval = periodToMilliseconds(period)
    const safeTo = Math.min(to, this.now())
    const alignedEnd = Math.floor(safeTo / interval) * interval
    const alignedStart = Math.ceil(from / interval) * interval
    const start = Math.max(alignedStart, alignedEnd - interval * 499)
    if (start > alignedEnd) {
      return []
    }
    const rows: KLineData[] = []
    for (let timestamp = start; timestamp <= alignedEnd; timestamp += interval) {
      rows.push(candleAt(timestamp, _symbol, period, interval))
    }
    return rows
  }

  subscribe(
    _symbol: SymbolInfo,
    _period: Period,
    _callback: DatafeedSubscribeCallback,
  ): void {}

  unsubscribe(_symbol: SymbolInfo, _period: Period): void {}
}
