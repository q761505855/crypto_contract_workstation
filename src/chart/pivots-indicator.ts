import {
  registerIndicator,
  type IndicatorSeries,
  type Indicator,
  type IndicatorTemplate,
  type IndicatorDrawParams,
  type KLineData,
} from 'klinecharts'
import type { Datafeed, Period, SymbolInfo } from '@klinecharts/pro'
import { alignOpenTime, nextOpenTime } from '../market-data/intervals'
import { readIndicatorHistory } from '../market-data/indicator-history'
import { SUPPORTED_PERIODS } from './chart-config'
import {
  calculatePivots, PIVOT_LEVELS, PIVOTS_DEFAULT_PARAMS, pivotSettings,
  pivotPeriodStart, pivotSourceTimeframe, resolvePivotAnchor, shiftPivotPeriod,
  pivotGroup,
  type PivotSegment, type PivotValue,
} from './pivots'

export interface PivotChartContext {
  symbol: SymbolInfo
  period: Period
  confirmedUntil: number
  sessionKey: string
}

/** Only complete anchor data and current open are consumed; requests are reused within a source bucket. */
export function createPivotCalculator(feed: Datafeed, getContext: () => PivotChartContext) {
  const requests = new Map<string, Promise<KLineData[]>>()
  const calculate = async (candles: KLineData[], params: unknown[]): Promise<PivotValue[]> => {
    if (candles.length === 0) return []
    const context = getContext()
    const settings = pivotSettings(params)
    if (!settings.dailyBased) return calculatePivots(candles, context.period.text, settings, candles, context.period.text, context.confirmedUntil)
    const anchor = resolvePivotAnchor(settings.anchor, context.period.text)
    const sourceTimeframe = pivotSourceTimeframe(anchor)
    const sourcePeriod = SUPPORTED_PERIODS.find((period) => period.text === sourceTimeframe)!
    const lastStart = pivotPeriodStart(candles.at(-1)!.timestamp, anchor)
    const from = Math.max(0, shiftPivotPeriod(lastStart, anchor, -settings.history - (settings.showPrevious ? 1 : 0)))
    const to = alignOpenTime(candles.at(-1)!.timestamp, sourceTimeframe, 'floor')
    const sourceComplete = nextOpenTime(to, sourceTimeframe) <= context.confirmedUntil
    const key = JSON.stringify([context.symbol.ticker, sourceTimeframe, from, to, sourceComplete, context.sessionKey])
    let request = requests.get(key)
    if (request === undefined) {
      request = readIndicatorHistory(feed, context.symbol, sourcePeriod, from, to)
      // Remember failures too: a live tick must not restart failed remote work.
      requests.set(key, request)
      if (requests.size > 24) requests.delete(requests.keys().next().value!)
    }
    try {
      const source = await request
      return calculatePivots(candles, context.period.text, settings, source, sourceTimeframe, context.confirmedUntil)
    } catch {
      const result: PivotValue[] = candles.map(() => ({}))
      result.at(-1)!.message = '枢轴周期数据读取失败，请检查缓存和行情请求保护'
      return result
    }
  }
  return Object.assign(calculate, { clearCache: () => requests.clear() })
}

/** KLineCharts awaits custom calculations but does not discard older async results. */
export function latestPivotCalculation(
  calculate: (candles: KLineData[], params: unknown[]) => Promise<PivotValue[]>,
  getContext: () => PivotChartContext,
) {
  const sequences = new WeakMap<Indicator<PivotValue>, number>()
  return async (candles: KLineData[], indicator: Indicator<PivotValue>): Promise<PivotValue[]> => {
    const sequence = (sequences.get(indicator) ?? 0) + 1
    sequences.set(indicator, sequence)
    const before = getContext()
    const identity = JSON.stringify([before.symbol.ticker, before.period.text, before.sessionKey])
    const confirmedUntil = before.confirmedUntil
    const result = await calculate(candles, indicator.calcParams)
    const after = getContext()
    if (sequences.get(indicator) !== sequence ||
      identity !== JSON.stringify([after.symbol.ticker, after.period.text, after.sessionKey]) ||
      after.confirmedUntil < confirmedUntil) {
      // The chart catches rejected calculations and keeps the latest result.
      throw new Error('Superseded pivot calculation')
    }
    return result
  }
}

function fractionalIndex(timestamp: number, candles: KLineData[], timeframe: string): number {
  let low = 0, high = candles.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (candles[middle].timestamp < timestamp) low = middle + 1
    else high = middle
  }
  if (low === 0) return (timestamp - candles[0].timestamp) / (nextOpenTime(candles[0].timestamp, timeframe) - candles[0].timestamp)
  if (low === candles.length) {
    const last = candles.at(-1)!
    return candles.length - 1 + (timestamp - last.timestamp) / (nextOpenTime(last.timestamp, timeframe) - last.timestamp)
  }
  return low - 1 + (timestamp - candles[low - 1].timestamp) / (candles[low].timestamp - candles[low - 1].timestamp)
}

export function drawPivots({ ctx, indicator, kLineDataList, xAxis, yAxis, bounding }: IndicatorDrawParams<PivotValue>, timeframe: string): boolean {
  if (kLineDataList.length === 0) return true
  const settings = pivotSettings(indicator.calcParams)
  const segments = new Map<number, PivotSegment>()
  for (const value of indicator.result) {
    if (value.segment) segments.set(value.segment.start, value.segment)
    if (value.projection) segments.set(value.projection.start, value.projection)
  }
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, bounding.width, bounding.height)
  ctx.clip()
  ctx.lineWidth = settings.width
  ctx.setLineDash([])
  ctx.font = '11px sans-serif'
  for (const segment of segments.values()) {
    const start = xAxis.convertToPixel(fractionalIndex(segment.start, kLineDataList, timeframe))
    const end = xAxis.convertToPixel(fractionalIndex(segment.end, kLineDataList, timeframe))
    if (end < 0 || start > bounding.width) continue
    for (const previous of (segment.previous ? [true, false] : [false])) {
      ctx.setLineDash(previous ? [5, 4] : [])
      for (const key of PIVOT_LEVELS) {
        const price = (previous ? segment.previous : segment.levels)?.[key]
        if (price === undefined || !settings.levels[key].visible) continue
        const y = yAxis.convertToPixel(price)
        ctx.strokeStyle = previous ? settings.previousColors[pivotGroup(key)] : settings.levels[key].color
        ctx.fillStyle = ctx.strokeStyle
        ctx.beginPath()
        ctx.moveTo(Math.max(0, start), y)
        ctx.lineTo(Math.min(bounding.width, end), y)
        ctx.stroke()
        if (settings.labels || settings.prices) {
          const right = settings.labelPosition === 'Right'
          const label = [previous ? '上期' : '', settings.labels ? key : '', settings.prices ? `(${price.toFixed(indicator.precision)})` : ''].filter(Boolean).join(' ')
          ctx.textAlign = right ? 'right' : 'left'
          ctx.fillText(label, right ? Math.min(bounding.width - 3, end - 3) : Math.max(3, start + 3), y - 3)
        }
      }
    }
  }
  ctx.restore()
  return true
}

export function registerPivotsIndicator(feed: Datafeed, getContext: () => PivotChartContext): () => void {
  const calculate = createPivotCalculator(feed, getContext)
  const template: IndicatorTemplate<PivotValue> = {
    name: 'PIVOTS', shortName: 'Pivots', series: 'price' as IndicatorSeries,
    calcParams: [...PIVOTS_DEFAULT_PARAMS],
    figures: PIVOT_LEVELS.flatMap((key) => [
      { key, title: `${key}: `, type: 'line' },
      { key: `previous${key}`, title: `上期 ${key}: `, type: 'line' },
    ]),
    calc: latestPivotCalculation(calculate, getContext),
    draw: (params) => drawPivots(params, getContext().period.text),
    createTooltipDataSource: ({ indicator, crosshair, defaultStyles }) => {
      const value: PivotValue = indicator.result[crosshair.dataIndex ?? indicator.result.length - 1] ?? {}
      return {
        name: 'Pivots', calcParamsText: '',
        icons: defaultStyles.tooltip.icons.filter((icon) => icon.id !== (indicator.visible ? 'visible' : 'invisible')),
        values: value.message ? [{ title: '', value: value.message }] : [],
      }
    },
  }
  registerIndicator(template)
  return calculate.clearCache
}
