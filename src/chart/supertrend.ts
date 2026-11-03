import {
  registerIndicator,
  type IndicatorSeries,
  type IndicatorTemplate,
  type IndicatorDrawParams,
  type KLineData,
  type LineType,
} from 'klinecharts'

export const SUPERTREND_NAME = 'SUPERTREND'
export const SUPERTREND_DEFAULT_PARAMS = [10, 3, 88] as const

export interface SupertrendValue {
  up?: number
  down?: number
}

/** Fill each continuous trend between the band and the candle body midpoint. */
export function drawSupertrendFill({
  ctx, indicator, kLineDataList, visibleRange, bounding, xAxis, yAxis,
}: IndicatorDrawParams<SupertrendValue>): boolean {
  const from = Math.max(0, Math.floor(visibleRange.from) - 1)
  const to = Math.min(kLineDataList.length - 1, Math.ceil(visibleRange.to))
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, bounding.width, bounding.height)
  ctx.clip()
  // Keep candles and other indicators legible beneath the transparent fill.
  // Older saved indicators only have ATR period and multiplier.
  const transparency = indicator.calcParams?.[2] ?? SUPERTREND_DEFAULT_PARAMS[2]
  ctx.globalAlpha = (100 - (Number.isFinite(transparency)
    ? Math.min(100, Math.max(0, transparency))
    : SUPERTREND_DEFAULT_PARAMS[2])) / 100
  ctx.globalCompositeOperation = 'destination-over'
  for (const [lineIndex, key] of (['up', 'down'] as const).entries()) {
    ctx.fillStyle = indicator.styles?.lines?.[lineIndex]?.color
      ?? (key === 'up' ? '#26a69a' : '#ef5350')
    let start = from
    while (start <= to) {
      if (!Number.isFinite(indicator.result[start]?.[key])) {
        start += 1
        continue
      }
      let end = start
      while (end < to && Number.isFinite(indicator.result[end + 1]?.[key])) end += 1
      if (end > start) {
        ctx.beginPath()
        ctx.moveTo(xAxis.convertToPixel(start), yAxis.convertToPixel(indicator.result[start][key]!))
        for (let index = start + 1; index <= end; index += 1) {
          ctx.lineTo(xAxis.convertToPixel(index), yAxis.convertToPixel(indicator.result[index][key]!))
        }
        for (let index = end; index >= start; index -= 1) {
          const candle = kLineDataList[index]
          ctx.lineTo(xAxis.convertToPixel(index), yAxis.convertToPixel((candle.open + candle.close) / 2))
        }
        ctx.closePath()
        ctx.fill()
      }
      start = end + 1
    }
  }
  ctx.restore()
  // Retain the library's line rendering, tooltip values and editable styles.
  return false
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
  draw: drawSupertrendFill,
  createTooltipDataSource: ({ indicator, defaultStyles }) => ({
    name: 'Supertrend',
    calcParamsText: '',
    values: [],
    icons: defaultStyles.tooltip.icons.filter((icon) => icon.id !== (indicator.visible ? 'visible' : 'invisible')),
  }),
}

export function registerSupertrendIndicator(): void {
  registerIndicator(supertrendIndicator)
}
