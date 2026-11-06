import { registerIndicator, type IndicatorFigureAttrsCallbackParams, type IndicatorTemplate, type KLineData, type LineType, type PolygonType } from 'klinecharts'
import { TTM_WAVE_PALETTES, type TtmWave } from './ttm-wave-colors'

export type { TtmWave } from './ttm-wave-colors'
export const TTM_WAVE_PARAMS = {
  A: [8, 34, 55], B: [8, 89, 144], C: [8, 233, 377],
} as const

interface WaveBarColors {
  noChangeColor?: string
  positiveColor?: string
  negativeColor?: string
}

export interface TtmWaveValue {
  wave1?: number
  wave2?: number
  zero?: number
}

/** Public ABC-wave formula, independently implemented. EMA starts at the first close.
 * D(p) = EMA(close, fast) - EMA(close, p); H(p) = D(p) - EMA(D(p), p).
 * A/B: H(slow2), H(slow1). C: D(slow2), H(slow1), deliberately not H(slow2).
 * Reference: https://www.tradingview.com/script/nYOzTA1Y-UCS-TTM-Wave-A-B-C/
 */
export function calculateTtmWave(
  candles: KLineData[], wave: TtmWave,
  fast: number = TTM_WAVE_PARAMS[wave][0],
  slow1: number = TTM_WAVE_PARAMS[wave][1],
  slow2: number = TTM_WAVE_PARAMS[wave][2],
): TtmWaveValue[] {
  if (![fast, slow1, slow2].every(p => Number.isInteger(p) && p > 0) || fast >= slow1 || slow1 >= slow2) {
    return candles.map(() => ({}))
  }
  const fastAlpha = 2 / (fast + 1)
  const alpha1 = 2 / (slow1 + 1)
  const alpha2 = 2 / (slow2 + 1)
  let fastEma = candles[0]?.close ?? 0
  let ema1 = fastEma
  let ema2 = fastEma
  let signal1 = 0
  let signal2 = 0
  return candles.map(candle => {
    fastEma += fastAlpha * (candle.close - fastEma)
    ema1 += alpha1 * (candle.close - ema1)
    ema2 += alpha2 * (candle.close - ema2)
    const diff1 = fastEma - ema1
    const diff2 = fastEma - ema2
    signal1 += alpha1 * (diff1 - signal1)
    signal2 += alpha2 * (diff2 - signal2)
    const wave1 = wave === 'C' ? diff2 : diff2 - signal2
    const wave2 = diff1 - signal1
    return Number.isFinite(wave1) && Number.isFinite(wave2) ? { wave1, wave2, zero: 0 } : {}
  })
}

function template(wave: TtmWave): IndicatorTemplate<TtmWaveValue> {
  const colors = TTM_WAVE_PALETTES[wave]
  return {
    name: `TTM_WAVE_${wave}`,
    shortName: `TTM Wave ${wave}`,
    precision: 4,
    calcParams: [...TTM_WAVE_PARAMS[wave]],
    figures: [
      ...(['wave1', 'wave2'] as const).map((key, index) => ({
        key, title: `波形${index + 1}: `, type: 'bar', baseValue: 0,
        attrs: ({ coordinate, barSpace, yAxis }: IndicatorFigureAttrsCallbackParams<TtmWaveValue>) => {
          const width = Math.max(1, barSpace.gapBar * (index === 0 ? 1 : 0.5))
          const value = coordinate.current[key]
          const zero = yAxis.convertToPixel(0)
          return { x: coordinate.current.x - width / 2, y: Math.min(value, zero), width, height: Math.max(Math.abs(value - zero), 1) }
        },
        styles: ({ current }: { current: { indicatorData?: TtmWaveValue } }, indicator: { styles: { bars?: WaveBarColors[] } | null }) => {
          const bar = indicator.styles?.bars?.[index]
          const color = (current.indicatorData?.[key] ?? 0) >= 0
            ? bar?.positiveColor ?? bar?.noChangeColor ?? colors.positive[index]
            : bar?.negativeColor ?? colors.negative[index]
          return { color, borderColor: color, style: 'fill' as PolygonType }
        },
      })),
      { key: 'zero', title: '', type: 'line' },
    ],
    styles: {
      bars: colors.positive.map(color => ({
        upColor: color, downColor: color, noChangeColor: color,
        style: 'fill' as PolygonType, borderSize: 0, borderStyle: 'solid' as LineType, borderDashedValue: [],
      })),
      lines: [{ color: '#76808f', size: 1, smooth: false, style: 'dashed' as LineType, dashedValue: [3, 3] }],
    },
    calc: (candles, indicator) => calculateTtmWave(candles, wave, ...indicator.calcParams as [number, number, number]),
  }
}

export const ttmWaveIndicators = (['A', 'B', 'C'] as const).map(template)

export function registerTtmWaveIndicators(): void {
  ttmWaveIndicators.forEach(indicator => registerIndicator(indicator))
}
