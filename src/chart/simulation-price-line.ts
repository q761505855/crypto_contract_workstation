import { registerOverlay, utils, type OverlayTemplate } from 'klinecharts'

export const SIMULATION_PRICE_LINE = 'simulationPriceLine'

const simulationPriceLine: OverlayTemplate = {
  name: SIMULATION_PRICE_LINE,
  totalStep: 2,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates, bounding, precision, overlay, thousandsSeparator, decimalFoldThreshold }) => {
    const point = coordinates[0]
    const value = overlay.points[0]?.value
    if (!point || typeof value !== 'number') return []
    const price = utils.formatFoldDecimal(
      utils.formatThousands(value.toFixed(precision.price), thousandsSeparator),
      decimalFoldThreshold,
    )
    return [
      {
        type: 'line',
        attrs: { coordinates: [point, { x: bounding.width, y: point.y }] },
      },
      {
        type: 'text',
        ignoreEvent: true,
        attrs: {
          x: bounding.width - 8,
          y: point.y,
          text: `${overlay.extendData} · ${price}`,
          align: 'right',
          baseline: 'bottom',
        },
      },
    ]
  },
}

export function registerSimulationPriceLine(): void {
  registerOverlay(simulationPriceLine)
}
