import {
  registerIndicator,
  type IndicatorSeries,
  type IndicatorTemplate,
  type KLineData,
  type LineType,
} from 'klinecharts'

export const SUPERTREND_NAME = 'SUPERTREND'
export const SUPERTREND_DEFAULT_PARAMS = [10, 3] as const

export interface SupertrendValue {
  up?: number
  down?: number
}

/**
 * Standard Supertrend: HL2 bands and Wilder's ATR (SMA seed, then RMA).
 * Reference: https://www.tradingview.com/support/solutions/43000634738-supertrend/
 * Each result uses only the current candle and earlier candles.
 */
export function calculateSupertrend(
  candles: KLineData[],
  period: number = SUPERTREND_DEFAULT_PARAMS[0],
  multiplier: number = SUPERTREND_DEFAULT_PARAMS[1],
): SupertrendValue[] {
  if (!Number.isInteger(period) || period < 1 || !Number.isFinite(multiplier) || multiplier <= 0) {
    return candles.map(() => ({}))
  }
  let trueRangeSum = 0
  let atr = 0
  let upper = 0
  let lower = 0
  let rising = false

  return candles.map((candle, index) => {
    const previousClose = candles[index - 1]?.close
    const trueRange = previousClose === undefined
      ? candle.high - candle.low
      : Math.max(
          candle.high - candle.low,
          Math.abs(candle.high - previousClose),
          Math.abs(candle.low - previousClose),
        )

    if (index < period) trueRangeSum += trueRange
    if (index < period - 1) return {}
    atr = index === period - 1
      ? trueRangeSum / period
      : (atr * (period - 1) + trueRange) / period

    const midpoint = (candle.high + candle.low) / 2
    const basicUpper = midpoint + multiplier * atr
    const basicLower = midpoint - multiplier * atr
    if (index === period - 1) {
      upper = basicUpper
      lower = basicLower
    } else {
      upper = basicUpper < upper || previousClose! > upper ? basicUpper : upper
      lower = basicLower > lower || previousClose! < lower ? basicLower : lower
      rising = rising ? candle.close >= lower : candle.close > upper
    }
    // Separate figures leave a gap when direction changes instead of joining
    // the upper and lower bands across the price candles.
    return rising ? { up: lower } : { down: upper }
  })
}

export const supertrendIndicator: IndicatorTemplate<SupertrendValue> = {
  name: SUPERTREND_NAME,
  shortName: 'Supertrend',
  series: 'price' as IndicatorSeries,
  calcParams: [...SUPERTREND_DEFAULT_PARAMS],
  figures: [
    { key: 'up', title: '上涨: ', type: 'line' },
    { key: 'down', title: '下跌: ', type: 'line' },
  ],
  styles: {
    lines: [
      { color: '#26a69a', size: 2, style: 'solid' as LineType, smooth: false, dashedValue: [] },
      { color: '#ef5350', size: 2, style: 'solid' as LineType, smooth: false, dashedValue: [] },
    ],
  },
  calc: (candles, indicator) => calculateSupertrend(
    candles,
    indicator.calcParams[0],
    indicator.calcParams[1],
  ),
}

export function registerSupertrendIndicator(): void {
  registerIndicator(supertrendIndicator)
}
