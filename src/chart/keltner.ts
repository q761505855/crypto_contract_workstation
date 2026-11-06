import { registerIndicator, type IndicatorSeries, type LineType, type IndicatorTemplate, type KLineData } from 'klinecharts'

export const KELTNER_NAME = 'KC'
export const KELTNER_DEFAULT_PARAMS = [20, 1.5, 20] as const

export interface KeltnerValue {
  middle?: number
  upper?: number
  lower?: number
}

/** Modern KC: close EMA and Wilder ATR, both seeded with a full-window SMA. */
export function calculateKeltner(
  candles: KLineData[],
  emaPeriod: number = KELTNER_DEFAULT_PARAMS[0],
  multiplier: number = KELTNER_DEFAULT_PARAMS[1],
  atrPeriod: number = KELTNER_DEFAULT_PARAMS[2],
): KeltnerValue[] {
  if (!Number.isInteger(emaPeriod) || emaPeriod < 1 || !Number.isInteger(atrPeriod) || atrPeriod < 1 ||
      !Number.isFinite(multiplier) || multiplier <= 0) return candles.map(() => ({}))

  let closeSum = 0
  let rangeSum = 0
  let ema = 0
  let atr = 0
  const alpha = 2 / (emaPeriod + 1)
  return candles.map((candle, index) => {
    const previousClose = candles[index - 1]?.close
    const range = previousClose === undefined ? candle.high - candle.low : Math.max(
      candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose),
    )
    if (index < emaPeriod) closeSum += candle.close
    if (index === emaPeriod - 1) ema = closeSum / emaPeriod
    else if (index >= emaPeriod) ema += alpha * (candle.close - ema)
    if (index < atrPeriod) rangeSum += range
    if (index === atrPeriod - 1) atr = rangeSum / atrPeriod
    else if (index >= atrPeriod) atr = (atr * (atrPeriod - 1) + range) / atrPeriod
    if (index < Math.max(emaPeriod, atrPeriod) - 1) return {}
    const upper = ema + multiplier * atr
    const lower = ema - multiplier * atr
    return [ema, upper, lower].every(Number.isFinite) ? { middle: ema, upper, lower } : {}
  })
}

export const keltnerIndicator: IndicatorTemplate<KeltnerValue> = {
  name: KELTNER_NAME,
  shortName: 'KC',
  series: 'price' as IndicatorSeries,
  calcParams: [...KELTNER_DEFAULT_PARAMS],
  figures: [
    { key: 'upper', title: '上轨: ', type: 'line' },
    { key: 'middle', title: '中轨: ', type: 'line' },
    { key: 'lower', title: '下轨: ', type: 'line' },
  ],
  styles: { lines: ['#ff9800', '#2196f3', '#ab47bc'].map(color => ({
    color, style: 'solid' as LineType, size: 1, smooth: false, dashedValue: [],
  })) },
  calc: (candles, indicator) => calculateKeltner(candles, ...indicator.calcParams as [number, number, number]),
}

export function registerKeltnerIndicator(): void {
  registerIndicator(keltnerIndicator)
}
