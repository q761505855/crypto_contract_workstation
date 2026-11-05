import Decimal from 'decimal.js'
import { alignOpenTime, nextOpenTime, SUPPORTED_TIMEFRAMES } from './intervals'
import type { MarketCandle } from './models'

const MINUTE = 60_000

function sameMinute(left: MarketCandle, right: MarketCandle): boolean {
  return (Object.keys(left) as Array<keyof MarketCandle>).every(
    (field) => left[field] === right[field],
  )
}

// Decimal's default precision is too small for a month's exact volume sum.
// Reserve every input digit plus enough places for carries from all rows.
function exactSum(rows: readonly MarketCandle[], field: 'volume' | 'quoteVolume'): string {
  const values = rows.map((row) => new Decimal(row[field]))
  let integerDigits = 1
  let fractionalDigits = 0
  for (const value of values) {
    if (!value.isFinite() || value.isNegative()) {
      throw new Error(`分钟 K 线包含无效 ${field}`)
    }
    integerDigits = Math.max(integerDigits, value.e + 1)
    fractionalDigits = Math.max(fractionalDigits, value.decimalPlaces())
  }
  const Arithmetic = Decimal.clone({
    precision: Math.max(20, integerDigits + fractionalDigits + String(rows.length).length + 1),
  })
  return values.reduce((sum, value) => sum.plus(value), new Arithmetic(0)).toFixed()
}

/** Aggregate only contiguous closed minutes; visibleUntil is an exclusive replay boundary. */
export function aggregateMinuteCandles(
  candles: readonly MarketCandle[],
  timeframe: string,
  visibleUntil = Infinity,
): MarketCandle[] {
  if (!SUPPORTED_TIMEFRAMES.includes(timeframe)) {
    throw new Error(`不支持的周期：${timeframe}`)
  }
  if (visibleUntil !== Infinity && (!Number.isFinite(visibleUntil) || visibleUntil < 0)) {
    throw new Error('无效的行情可见边界')
  }

  const unique = new Map<number, MarketCandle>()
  const symbol = candles[0]?.symbol
  for (const row of candles) {
    if (row.symbol !== symbol) {
      throw new Error('不能聚合不同交易对的分钟 K 线')
    }
    if (
      row.timeframe !== '1m' || !Number.isSafeInteger(row.openTime) || row.openTime < 0 ||
      row.openTime % MINUTE !== 0 || row.closeTime !== row.openTime + MINUTE - 1
    ) {
      throw new Error('聚合输入必须是有效的分钟 K 线')
    }
    if (!row.isClosed || row.openTime + MINUTE > visibleUntil) continue
    const prior = unique.get(row.openTime)
    if (prior && !sameMinute(prior, row)) {
      throw new Error(`分钟 K 线重复且内容冲突：${row.openTime}`)
    }
    unique.set(row.openTime, row)
  }

  const sorted = [...unique.values()].sort((left, right) => left.openTime - right.openTime)
  if (timeframe === '1m') {
    // Minutes are already canonical: validate without constructing per-row
    // arithmetic contexts or changing their stored decimal representation.
    return sorted.map((row) => {
      new Decimal(row.high)
      new Decimal(row.low)
      for (const field of ['volume', 'quoteVolume'] as const) {
        const value = new Decimal(row[field])
        if (!value.isFinite() || value.isNegative()) {
          throw new Error(`分钟 K 线包含无效 ${field}`)
        }
      }
      if (!Number.isSafeInteger(row.tradeCount) || row.tradeCount < 0) {
        throw new Error('分钟 K 线包含无效交易笔数')
      }
      return { ...row }
    })
  }

  const groups = new Map<number, MarketCandle[]>()
  for (const row of sorted) {
    const bucket = alignOpenTime(row.openTime, timeframe, 'floor')
    const group = groups.get(bucket)
    if (group) group.push(row)
    else groups.set(bucket, [row])
  }

  const result: MarketCandle[] = []
  for (const [start, rows] of groups) {
    const end = nextOpenTime(start, timeframe)
    const visibleEnd = Math.min(end, Math.floor(visibleUntil / MINUTE) * MINUTE)
    const count = (visibleEnd - start) / MINUTE
    if (
      count <= 0 || rows.length !== count ||
      rows.some((row, index) => row.openTime !== start + index * MINUTE)
    ) continue

    let high = rows[0].high
    let low = rows[0].low
    let tradeCount = 0
    for (const row of rows) {
      if (new Decimal(row.high).greaterThan(high)) high = row.high
      if (new Decimal(row.low).lessThan(low)) low = row.low
      if (!Number.isSafeInteger(row.tradeCount) || row.tradeCount < 0) {
        throw new Error('分钟 K 线包含无效交易笔数')
      }
      tradeCount += row.tradeCount
    }
    if (!Number.isSafeInteger(tradeCount)) throw new Error('聚合交易笔数超出安全范围')
    result.push({
      ...rows[0], timeframe, openTime: start, closeTime: end - 1,
      high, low, close: rows[rows.length - 1].close,
      volume: exactSum(rows, 'volume'), quoteVolume: exactSum(rows, 'quoteVolume'),
      tradeCount, isClosed: visibleUntil >= end,
    })
  }
  return result
}
