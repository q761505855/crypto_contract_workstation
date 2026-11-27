import { registerOverlay, utils, type Chart, type KLineData, type OverlayFigure, type OverlayTemplate } from 'klinecharts'
import { alignOpenTime } from '../market-data/intervals'

export const SIMULATION_PRICE_LINE = 'simulationPriceLine'
export const SIMULATION_TRADE_LABEL = 'simulationTradeLabel'
export const SIMULATION_BUY_COLOR = '#4fd49f'
export const SIMULATION_SELL_COLOR = '#ff7f79'

export interface SimulationTradeLabel {
  timestamp: number
  label: string
  color: string
}

interface SimulationTradeLabelData {
  chart: Chart
  trades: SimulationTradeLabel[]
  displayCandle: (index: number, candle: KLineData, timestamp: number) => KLineData | undefined
  timeframe: string
}

export interface SimulationPriceLineData {
  color: string
  active: boolean
  placeLabel?: (y: number) => void
}

const simulationPriceLine: OverlayTemplate = {
  name: SIMULATION_PRICE_LINE,
  totalStep: 2,
  createPointFigures: ({ coordinates, bounding, overlay }) => {
    const point = coordinates[0]
    if (!point) return []
    const data = overlay.extendData as SimulationPriceLineData
    data.placeLabel?.(point.y)
    return {
      type: 'line',
      ignoreEvent: true,
      attrs: { coordinates: [{ x: 0, y: point.y }, { x: bounding.width, y: point.y }] },
      styles: { color: data.color, size: data.active ? 2 : 1, style: 'dashed', dashedValue: [4, 4] },
    }
  },
  createYAxisFigures: ({ coordinates, bounding, precision, overlay, thousandsSeparator, decimalFoldThreshold, yAxis }) => {
    const point = coordinates[0]
    const value = overlay.points[0]?.value
    if (!point || point.y < 0 || point.y > bounding.height || typeof value !== 'number') return []
    const { color, active } = overlay.extendData as SimulationPriceLineData
    const price = utils.formatFoldDecimal(
      utils.formatThousands(value.toFixed(precision.price), thousandsSeparator),
      decimalFoldThreshold,
    )
    const fromZero = yAxis?.isFromZero()
    return {
      type: 'text',
      ignoreEvent: true,
      attrs: { x: fromZero ? 0 : bounding.width, y: point.y, text: price, align: fromZero ? 'left' : 'right', baseline: 'middle' },
      styles: {
        style: 'stroke_fill',
        color: active ? '#111820' : color,
        backgroundColor: active ? color : '#141d29',
        borderColor: color,
        borderSize: 1,
        borderRadius: 3,
        paddingLeft: 3,
        paddingRight: 3,
        paddingTop: 3,
        paddingBottom: 3,
      },
    }
  },
}

const simulationTradeLabel: OverlayTemplate = {
  name: SIMULATION_TRADE_LABEL,
  totalStep: 2,
  createPointFigures: ({ overlay, bounding, xAxis, yAxis, defaultStyles }) => {
    if (xAxis === null || yAxis === null) return []
    const { chart, trades, displayCandle, timeframe } = overlay.extendData as SimulationTradeLabelData
    const candles = chart.getDataList()
    const { from, to } = chart.getVisibleRange()
    const visible = new Map<number, number>()
    for (let index = Math.max(0, from); index < Math.min(to, candles.length); index++) {
      visible.set(candles[index].timestamp, index)
    }
    const style = { size: 11, family: defaultStyles.text.family, weight: 600, paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 3 }
    const height = style.size + style.paddingTop + style.paddingBottom
    const { candle: candleStyles, yAxis: axis } = chart.getStyles()
    const insideAxisWidth = axis.inside && typeof axis.size === 'number' ? axis.size : 0
    const plotLeft = axis.position === 'left' ? insideAxisWidth : 0
    const plotRight = bounding.width - (axis.position === 'right' ? insideAxisWidth : 0)
    const labels: { trade: SimulationTradeLabel; x: number; wick: number; center: number; width: number; bottom: number }[] = []
    // Place the newest marker nearest its candle. Move earlier labels above
    // any overlapping later labels, including fills on neighbouring candles.
    for (let index = trades.length - 1; index >= 0; index--) {
      const trade = trades[index]
      const candleIndex = visible.get(alignOpenTime(trade.timestamp, timeframe, 'floor'))
      if (candleIndex === undefined) continue
      const candle = displayCandle(candleIndex, candles[candleIndex], trade.timestamp)
      if (!candle) continue
      const x = xAxis.convertToPixel(candleIndex)
      const wick = candleStyles.type === 'area' ? yAxis.convertToPixel(Number(candle[candleStyles.area.value])) :
        Math.min(yAxis.convertToPixel(candle.high), yAxis.convertToPixel(candle.low))
      if (x < 0 || x > bounding.width || !Number.isFinite(wick) || wick < 0 || wick > bounding.height) continue
      const width = utils.calcTextWidth(trade.label, style.size, style.weight, style.family) + style.paddingLeft + style.paddingRight
      const center = Math.max(plotLeft + width / 2 + 2, Math.min(x, plotRight - width / 2 - 2))
      let bottom = wick - 9
      for (const label of labels) {
        if (Math.abs(center - label.center) < (width + label.width) / 2 + 3 &&
            bottom - height < label.bottom + 3 && bottom > label.bottom - height - 3) {
          bottom = label.bottom - height - 3
        }
      }
      // Bottom-to-top traversal still works when candles have different highs.
      const next = labels.findIndex(label => label.bottom < bottom)
      labels.splice(next < 0 ? labels.length : next, 0, { trade, x, wick, center, width, bottom })
    }
    const figures: OverlayFigure[] = []
    for (const { trade, x, wick, center, bottom } of labels) {
      if (bottom < height) continue
      figures.push(
        { type: 'line', ignoreEvent: true, attrs: { coordinates: [{ x: center, y: bottom }, { x, y: wick - 5 }] }, styles: { color: trade.color, size: 1 } },
        { type: 'polygon', ignoreEvent: true, attrs: { coordinates: [{ x: x - 3, y: wick - 5 }, { x: x + 3, y: wick - 5 }, { x, y: wick }] }, styles: { style: 'fill', color: trade.color } },
      )
    }
    for (const { trade, center, bottom } of labels) {
      if (bottom < height) continue
      figures.push({
        type: 'text',
        ignoreEvent: true,
        attrs: { x: center, y: bottom, text: trade.label, align: 'center', baseline: 'bottom' },
        styles: { ...style, style: 'stroke_fill', color: trade.color, backgroundColor: '#141d29', borderColor: trade.color, borderSize: 1, borderRadius: 3 },
      })
    }
    return figures
  },
}

export function registerSimulationPriceLine(): void {
  registerOverlay(simulationPriceLine)
  registerOverlay(simulationTradeLabel)
}
