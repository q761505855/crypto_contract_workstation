import { registerOverlay, utils, type OverlayTemplate } from 'klinecharts'

export const SIMULATION_PRICE_LINE = 'simulationPriceLine'
export const SIMULATION_TRADE_LABEL = 'simulationTradeLabel'
export const SIMULATION_BUY_COLOR = '#4fd49f'
export const SIMULATION_SELL_COLOR = '#ff7f79'

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
  createPointFigures: ({ coordinates, overlay }) => {
    const point = coordinates[0]
    if (!point) return []
    const buy = overlay.styles?.text?.color === SIMULATION_BUY_COLOR
    return {
      type: 'text',
      ignoreEvent: true,
      attrs: {
        x: point.x,
        y: point.y + (buy ? 10 : -10),
        text: overlay.extendData,
        align: 'center',
        baseline: buy ? 'top' : 'bottom',
      },
      styles: { style: 'fill', backgroundColor: '#141d29', borderRadius: 3, weight: 600, paddingLeft: 4, paddingRight: 4 },
    }
  },
}

export function registerSimulationPriceLine(): void {
  registerOverlay(simulationPriceLine)
  registerOverlay(simulationTradeLabel)
}
