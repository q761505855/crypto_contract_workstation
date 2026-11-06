import { registerIndicator, type LineType, type PolygonType, type IndicatorTemplate, type KLineData } from 'klinecharts'
import { calculateKeltner } from './keltner'

export const TTM_SQUEEZE_NAME = 'TTM_SQUEEZE'
export const TTM_SQUEEZE_DEFAULT_PARAMS = [20, 2, 1.5] as const

export interface TtmSqueezeValue {
  squeeze?: boolean
  dot?: number
  momentum?: number
}

/** BB population deviation, modern KC, and rolling least-squares endpoint momentum. */
export function calculateTtmSqueeze(
  candles: KLineData[],
  period: number = TTM_SQUEEZE_DEFAULT_PARAMS[0],
  bbMultiplier: number = TTM_SQUEEZE_DEFAULT_PARAMS[1],
  kcMultiplier: number = TTM_SQUEEZE_DEFAULT_PARAMS[2],
): TtmSqueezeValue[] {
  if (!Number.isInteger(period) || period < 1 || !Number.isFinite(bbMultiplier) || bbMultiplier <= 0 ||
      !Number.isFinite(kcMultiplier) || kcMultiplier <= 0) return candles.map(() => ({}))
  const channel = calculateKeltner(candles, period, kcMultiplier, period)
  const bases: number[] = []
  return candles.map((candle, index) => {
    if (index < period - 1 || channel[index].upper === undefined) return {}
    const window = candles.slice(index - period + 1, index + 1)
    const mean = window.reduce((sum, c) => sum + c.close, 0) / period
    const deviation = Math.sqrt(window.reduce((sum, c) => sum + (c.close - mean) ** 2, 0) / period)
    let high = -Infinity
    let low = Infinity
    for (const c of window) { high = Math.max(high, c.high); low = Math.min(low, c.low) }
    bases[index] = candle.close - ((high + low) / 2 + mean) / 2
    const result: TtmSqueezeValue = {
      squeeze: mean + bbMultiplier * deviation < channel[index].upper! &&
        mean - bbMultiplier * deviation > channel[index].lower!,
      dot: 0,
    }
    if (index < 2 * (period - 1)) return result
    const center = (period - 1) / 2
    let sum = 0
    let numerator = 0
    let denominator = 0
    for (let offset = 0; offset < period; offset++) {
      const value = bases[index - period + 1 + offset]
      sum += value
      numerator += (offset - center) * value
      denominator += (offset - center) ** 2
    }
    const momentum = sum / period + (denominator === 0 ? 0 : numerator / denominator * center)
    if (Number.isFinite(momentum)) result.momentum = momentum
    return result
  })
}

const MOMENTUM_COLORS = ['#00bcd4', '#2962ff', '#ef5350', '#ffca28']

export const ttmSqueezeIndicator: IndicatorTemplate<TtmSqueezeValue> = {
  name: TTM_SQUEEZE_NAME,
  shortName: 'TTM Squeeze',
  precision: 4,
  calcParams: [...TTM_SQUEEZE_DEFAULT_PARAMS],
  figures: [
    {
      key: 'momentum', title: '动量: ', type: 'bar', baseValue: 0,
      styles: ({ prev, current }, indicator) => {
        const value = current.indicatorData?.momentum ?? 0
        const previous = prev.indicatorData?.momentum ?? 0
        const index = value >= 0 ? (value >= previous ? 0 : 1) : (value < previous ? 2 : 3)
        const color = indicator.styles?.bars?.[index]?.noChangeColor ?? MOMENTUM_COLORS[index]
        return { color, borderColor: color, style: 'fill' as PolygonType }
      },
    },
    {
      key: 'dot', title: '', type: 'circle',
      attrs: ({ coordinate }) => ({ x: coordinate.current.x, y: coordinate.current.dot, r: 3 }),
      styles: ({ current }, indicator) => {
        const index = current.indicatorData?.squeeze ? 0 : 1
        const color = indicator.styles?.circles?.[index]?.noChangeColor ?? (index === 0 ? '#ef5350' : '#26a69a')
        return { color, borderColor: color, style: 'fill' as PolygonType }
      },
    },
  ],
  styles: {
    bars: MOMENTUM_COLORS.map(color => ({
      upColor: color, downColor: color, noChangeColor: color,
      style: 'fill' as PolygonType, borderSize: 0, borderStyle: 'solid' as LineType, borderDashedValue: [],
    })),
    circles: ['#ef5350', '#26a69a'].map(color => ({
      upColor: color, downColor: color, noChangeColor: color,
      style: 'fill' as PolygonType, borderSize: 0, borderStyle: 'solid' as LineType, borderDashedValue: [],
    })),
  },
  calc: (candles, indicator) => calculateTtmSqueeze(candles, ...indicator.calcParams as [number, number, number]),
  createTooltipDataSource: ({ indicator, crosshair, kLineDataList, defaultStyles }) => {
    const value = indicator.result[crosshair.dataIndex ?? kLineDataList.length - 1]
    return {
      name: 'TTM Squeeze',
      calcParamsText: `(${indicator.calcParams.join(', ')})`,
      icons: defaultStyles.tooltip.icons.filter(icon => icon.id !== (indicator.visible ? 'visible' : 'invisible')),
      values: [
        { title: '动量: ', value: value?.momentum?.toFixed(indicator.precision) ?? '--' },
        { title: '状态: ', value: value?.squeeze === undefined ? '预热中' : value.squeeze ? '挤压中' : '未挤压' },
      ],
    }
  },
}

export function registerTtmSqueezeIndicator(): void {
  registerIndicator(ttmSqueezeIndicator)
}
