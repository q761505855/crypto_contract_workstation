import { registerIndicator, registerOverlay, type IndicatorDrawParams, type IndicatorTooltipData,
  type OverlayCreateFiguresCallbackParams, type OverlayFigure } from 'klinecharts'
import { BIG_TRADES, DEFAULT_BIG_TRADE_NOTIONAL, VOLUME_PROFILE_TOOL, type VolumeProfile } from './order-flow'
import type { BybitTrade } from '../market-data/bybit/trades'

export const CANDLE_PANE = 'candle_pane'
export const bigTradesTitle = '大单气泡（Big Trades）'
const BUY = '#49d4ae'
const SELL = '#ff827e'
const VALUE_AREA = '#aabcda'
const POC = '#ffcc70'

export interface ProfileDisplay { profile?: VolumeProfile; message?: string }
export interface BubbleDisplay {
  points: { index: number; offset: number; trade: BybitTrade; price: number }[]
  message?: string
}

export function tradeBubbleRadius(trade: BybitTrade, minimum: number): number {
  return Math.min(20, 5 * Math.sqrt(trade.price * trade.size / Math.max(1, minimum)))
}

export function drawVolumeProfile({ overlay, coordinates, yAxis, precision }: OverlayCreateFiguresCallbackParams): OverlayFigure[] {
  if (coordinates.length < 2) return []
  const [first, second] = coordinates
  const x = Math.min(first.x, second.x)
  const right = Math.max(first.x, second.x)
  const y = Math.min(first.y, second.y)
  const height = Math.abs(second.y - first.y)
  const width = right - x
  const figures: OverlayFigure[] = [{
    type: 'rect', attrs: { x, y, width, height },
    styles: { style: 'stroke_fill', color: 'rgba(99,145,208,0.07)', borderColor: 'rgba(151,184,226,0.65)', borderSize: 1 },
  }]
  const { profile, message } = overlay.extendData as ProfileDisplay ?? {}
  const text = (label: string, labelX: number, labelY: number, color: string) => {
    figures.push({ type: 'text', attrs: { x: labelX, y: labelY, text: label, baseline: 'bottom' },
      styles: { color, size: 11, backgroundColor: 'rgba(18,26,39,0.86)', paddingLeft: 3, paddingRight: 3 }, ignoreEvent: true })
  }
  if (message) text(message, x + 4, y + 17, VALUE_AREA)
  if (!profile || !yAxis) return figures
  text('Bybit Delta / 成交量', x + 4, y + (message ? 30 : 17), VALUE_AREA)
  const maxVolume = Math.max(...profile.rows.map(row => row.buy + row.sell))
  const maxDelta = Math.max(...profile.rows.map(row => Math.abs(row.buy - row.sell)))
  const barWidth = Math.min(160, Math.max(10, width * 0.42))
  for (const row of profile.rows) {
    const volume = row.buy + row.sell
    if (!volume) continue
    const top = yAxis.convertToPixel(row.high)
    const rowHeight = Math.max(1, Math.abs(yAxis.convertToPixel(row.low) - top) - 0.7)
    const delta = row.buy - row.sell
    const volumeWidth = volume / maxVolume * barWidth
    const deltaWidth = maxDelta ? Math.abs(delta) / maxDelta * barWidth : 0
    const color = row.low < profile.vah && row.high > profile.val ? '#5e93d6' : '#3b5476'
    figures.push({ type: 'rect', attrs: { x, y: top, width: volumeWidth, height: rowHeight },
      styles: { color }, ignoreEvent: true })
    if (deltaWidth) figures.push({ type: 'rect', attrs: { x: x - deltaWidth, y: top, width: deltaWidth, height: rowHeight },
      styles: { color: delta > 0 ? BUY : SELL }, ignoreEvent: true })
  }
  const levels = [['VAH', profile.vah], ['POC', profile.poc], ['VAL', profile.val]] as const
  let lastLabel = -Infinity
  for (const [name, value] of levels) {
    const level = yAxis.convertToPixel(value)
    const color = name === 'POC' ? POC : VALUE_AREA
    figures.push({ type: 'line', attrs: { coordinates: [{ x, y: level }, { x: right, y: level }] },
      styles: { color, size: name === 'POC' ? 1.5 : 1, style: name === 'POC' ? 'solid' : 'dashed', dashedValue: [4, 3] },
      ignoreEvent: true })
    const labelY = Math.max(level, lastLabel + 13)
    text(`${name} ${value.toFixed(precision.price)}`, x + 4, labelY, color)
    lastLabel = labelY
  }
  return figures
}

function drawBigTrades({ ctx, indicator, xAxis, yAxis, visibleRange, bounding }: IndicatorDrawParams): boolean {
  const display = indicator.extendData as BubbleDisplay | undefined
  if (!display?.points?.length) return true
  const minimum = indicator.calcParams[0] as number
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, bounding.width, bounding.height)
  ctx.clip()
  for (const { trade, index, offset, price } of display.points) {
    if (index < visibleRange.from || index >= visibleRange.to) continue
    const radius = tradeBubbleRadius(trade, minimum)
    const color = trade.side === 'buy' ? BUY : SELL
    ctx.beginPath()
    ctx.arc(xAxis.convertToPixel(index + offset), yAxis.convertToPixel(price), radius, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.globalAlpha = 0.42
    ctx.fill()
    ctx.globalAlpha = 0.9
    ctx.strokeStyle = color
    ctx.stroke()
  }
  ctx.restore()
  return true
}

export function registerOrderFlow(): void {
  registerOverlay({ name: VOLUME_PROFILE_TOOL, totalStep: 3, needDefaultPointFigure: true, createPointFigures: drawVolumeProfile })
  registerIndicator({
    name: BIG_TRADES, shortName: bigTradesTitle, calcParams: [DEFAULT_BIG_TRADE_NOTIONAL], figures: [],
    calc: () => [], draw: drawBigTrades,
    createTooltipDataSource: ({ indicator, defaultStyles }): IndicatorTooltipData => ({
      name: bigTradesTitle, calcParamsText: `${indicator.calcParams[0]} USDT`,
      icons: defaultStyles.tooltip.icons.filter(icon => icon.id !== (indicator.visible ? 'visible' : 'invisible')),
      values: indicator.extendData
        ? ((indicator.extendData as BubbleDisplay).message ? [{ title: '', value: (indicator.extendData as BubbleDisplay).message! }] : [])
        : [{ title: '', value: '使用 Bybit 逐笔成交' }],
    }),
  })
}
