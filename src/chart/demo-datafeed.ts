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

function candleAt(timestamp: number, index: number): KLineData {
  const baseline = 60_000 + index * 8
  const wave = Math.sin(index / 6) * 120
  const open = baseline + wave
  const close = open + Math.cos(index / 4) * 45
  return {
    timestamp,
    open,
    high: Math.max(open, close) + 30,
    low: Math.min(open, close) - 30,
    close,
    volume: 100 + (index % 20) * 15,
    turnover: close * (100 + (index % 20) * 15),
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
    const alignedStart = Math.ceil(from / interval) * interval
    const start = Math.max(alignedStart, safeTo - interval * 499)
    const rows: KLineData[] = []
    for (
      let timestamp = start, index = 0;
      timestamp <= safeTo;
      timestamp += interval, index += 1
    ) {
      rows.push(candleAt(timestamp, index))
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
