import { registerIndicator, registerOverlay, type IndicatorDrawParams, type IndicatorTooltipData,
  type OverlayCreateFiguresCallbackParams, type OverlayFigure } from 'klinecharts'
import { BIG_TRADES, DEFAULT_BIG_TRADE_NOTIONAL, VOLUME_PROFILE_TOOL, bigTradeColors, type VolumeProfile } from './order-flow'
import type { TradeRange } from '../market-data/bybit/combined-source'
import type { BybitTrade } from '../market-data/bybit/trades'
import { drawingIndexAt } from './drawing-coordinates'
import { tradeBubbles, type TradeBar, type TradeBubble } from './order-flow-bars'
import { nextOpenTime } from '../market-data/intervals'

export const CANDLE_PANE = 'candle_pane'
export const bigTradesTitle = '大单气泡（Big Trades）'
const VALUE_AREA = '#aabcda'
const POC = '#ffcc70'

export interface ProfileDisplay { profile?: VolumeProfile; message?: string }
export interface BubbleDisplay {
  bars?: ReadonlyMap<number, TradeBar>
  updating?: TradeRange
  timeframe?: string
  projectToCandle?: boolean
  message?: string
}

export function tradeBubbleRadius(trade: BybitTrade, minimum: number): number {
  return Math.min(20, 5 * Math.sqrt(trade.price * trade.size / Math.max(1, minimum)))
}

export function tradeBubbleOffset(point: TradeBubble, start: number, end: number): number {
  return (point.trade.timeUs / 1000 - start) / (end - start) - 0.5
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
    const color = row.low < profile.vah && row.high > profile.val ? '#5e93d67a' : '#3b54766b'
    figures.push({ type: 'rect', attrs: { x, y: top, width: volumeWidth, height: rowHeight },
      styles: { color }, ignoreEvent: true })
    if (deltaWidth) figures.push({ type: 'rect', attrs: { x: x - deltaWidth, y: top, width: deltaWidth, height: rowHeight },
      styles: { color: delta > 0 ? '#49d4ae66' : '#ff827e66' }, ignoreEvent: true })
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

function drawBigTrades({ ctx, indicator, xAxis, yAxis, visibleRange, bounding, kLineDataList }: IndicatorDrawParams): boolean {
  const display = indicator.extendData as BubbleDisplay | undefined
  if (!display?.timeframe || (!display.bars?.size && !display.updating)) return true
  const minimum = indicator.calcParams[0] as number
  const colors = bigTradeColors(indicator.styles)
  ctx.save()
  ctx.globalAlpha = 1
  ctx.beginPath()
  ctx.rect(0, 0, bounding.width, bounding.height)
  ctx.clip()
  if (display.updating && kLineDataList.length) {
    const { fromUs, untilUs } = display.updating
    const x = xAxis.convertToPixel(drawingIndexAt(kLineDataList, fromUs / 1000, display.timeframe) - 0.5)
    const right = xAxis.convertToPixel(drawingIndexAt(kLineDataList, untilUs / 1000, display.timeframe) - 0.5)
    if (right > 0 && x < bounding.width) {
      const left = Math.max(0, x)
      const width = Math.max(2, Math.min(bounding.width, right) - left)
      ctx.fillStyle = 'rgba(90, 150, 230, 0.16)'
      ctx.fillRect(left, 0, width, bounding.height)
      ctx.fillStyle = '#81b5f2'
      ctx.fillRect(left, 0, width, 2)
      ctx.fillRect(left, 0, 1, bounding.height)
      ctx.font = '12px sans-serif'
      ctx.textBaseline = 'top'
      const label = '计算中'
      const labelWidth = ctx.measureText(label).width + 12
      if (width >= labelWidth) {
        ctx.fillStyle = '#243f60'
        ctx.fillRect(left, 2, labelWidth, 20)
        ctx.fillStyle = '#cce3fc'
        ctx.fillText(label, left + 6, 6)
      }
    }
  }
  for (let index = Math.max(0, visibleRange.from); index < Math.min(kLineDataList.length, visibleRange.to); index++) {
    const candle = kLineDataList[index]
    const bar = display.bars?.get(candle.timestamp)
    if (!bar?.firstPrice) continue
    const end = nextOpenTime(candle.timestamp, display.timeframe)
    const scale = display.projectToCandle ? candle.open / bar.firstPrice! : 1
    for (const point of tradeBubbles(bar)) {
      const { trade } = point
      const radius = tradeBubbleRadius(trade, minimum)
      const y = yAxis.convertToPixel(trade.price * scale)
      if (y + radius < 0 || y - radius > bounding.height) continue
      const { fill, outline } = colors[trade.side]
      ctx.beginPath()
      ctx.arc(xAxis.convertToPixel(index + tradeBubbleOffset(point, candle.timestamp, end)), y, radius, 0, Math.PI * 2)
      ctx.fillStyle = fill
      ctx.fill()
      ctx.strokeStyle = outline
      ctx.stroke()
    }
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
