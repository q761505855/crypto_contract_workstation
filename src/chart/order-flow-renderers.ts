import { registerIndicator, registerOverlay, type IndicatorDrawParams, type IndicatorTooltipData,
  type OverlayCreateFiguresCallbackParams, type OverlayFigure } from 'klinecharts'
import { BIG_TRADES, DEFAULT_BIG_TRADE_NOTIONAL, VOLUME_PROFILE_TOOL, bigTradeColors, bigTradeMode, bigTradeThresholdUnits,
  paintVolumeProfileRows, volumeProfileBounds, volumeProfileCenter, volumeProfileDisplayType, volumeProfilePriceLines,
  type BigTradeMode, type BigTradeThreshold, type BigTradeUnits, type VolumeProfile, type VolumeProfileBounds } from './order-flow'
import type { TradeRange } from '../market-data/bybit/combined-source'
import { drawingIndexAt } from './drawing-coordinates'
import { tradeBubblePrice, type TradeBar, type TradeBubble } from './order-flow-bars'
import { nextOpenTime } from '../market-data/intervals'
import { bigTradeThreshold, orderFlowSettings } from './order-flow-preferences'
import { formatProfileAmount, registerOrderFlowIndicators } from './order-flow-indicators'
import type { DisplayedTradeBubble } from './order-flow-bubbles'

export const CANDLE_PANE = 'candle_pane'
export const bigTradesTitle = '大单气泡（Big Trades）'
type BubbleSettings = ReturnType<typeof orderFlowSettings<'bubbles'>>
type ProfileSettings = ReturnType<typeof orderFlowSettings<'profile'>>
const bubbleAmountFormat = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumSignificantDigits: 4 })
const shortBubbleAmountFormat = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumSignificantDigits: 1 })
const bubbleLabelWidth = { circle: 1.7, square: 2, diamond: 1.35 }

export interface ProfileDisplay { profile?: VolumeProfile; bounds?: VolumeProfileBounds; message?: string; settings?: ProfileSettings }
export function profileDisplayCenter(display?: ProfileDisplay): number | undefined {
  return volumeProfileCenter(display?.profile, display?.bounds)
}

export interface BubbleDisplay extends BigTradeUnits {
  bars?: ReadonlyMap<number, TradeBar>
  points?: ReadonlyMap<number, readonly DisplayedTradeBubble[]>
  minimumNotional?: number
  mode?: BigTradeMode
  updating?: TradeRange
  timeframe?: string
  message?: string
  settings?: BubbleSettings
}

function tradeBubbleScale(amount: number, threshold: BigTradeThreshold): number {
  const scale = threshold.unit === 'notional' ? Math.max(1, threshold.minimum) : threshold.minimum || 1
  return amount / scale
}

export function tradeBubbleRadius(amount: number, threshold: BigTradeThreshold, settings: BubbleSettings): number {
  if (!settings.sizeByVolume) return settings.fixedRadius
  return Math.min(settings.maxRadius, Math.max(settings.minRadius, 5 * Math.sqrt(tradeBubbleScale(amount, threshold))))
}

export function tradeBubbleOpacity(amount: number, threshold: BigTradeThreshold, settings: BubbleSettings): number {
  return settings.opacityByVolume ? 1 - 0.7 / (1 + tradeBubbleScale(amount, threshold)) : 1
}

export function drawTradeBubbleLabel(ctx: CanvasRenderingContext2D, amount: number, x: number, y: number, radius: number,
  marker: BubbleSettings['marker']): void {
  const width = Math.floor(radius * bubbleLabelWidth[marker]) - 2
  if (width < 8) return
  ctx.font = '10px system-ui'
  const label = bubbleAmountFormat.format(amount)
  if (ctx.measureText(label).width <= width) {
    ctx.fillText(label, x, y, width)
    return
  }
  ctx.font = '8px system-ui'
  const candidates = [label, shortBubbleAmountFormat.format(amount), amount.toExponential(0).replace('e+', 'e')]
  const fitting = candidates.find(candidate => ctx.measureText(candidate).width <= width)
  if (fitting) ctx.fillText(fitting, x, y, width)
}

export function tradeBubbleOffset(point: TradeBubble, start: number, end: number): number {
  return (point.trade.timeUs / 1000 - start) / (end - start) - 0.5
}

export function drawVolumeProfile({ overlay, coordinates, bounding, yAxis, precision }: OverlayCreateFiguresCallbackParams): OverlayFigure[] {
  if (coordinates.length < 2) return []
  const [first, second] = coordinates
  const x = Math.min(first.x, second.x)
  const right = Math.max(first.x, second.x)
  const { profile, bounds = volumeProfileBounds(profile), message, settings = orderFlowSettings('profile') } = overlay.extendData as ProfileDisplay ?? {}
  const paneHeight = bounding?.height ?? Infinity
  const low = bounds && yAxis ? yAxis.convertToPixel(bounds.low) : Math.min(first.y, bounding.height - 6)
  const high = bounds && yAxis ? yAxis.convertToPixel(bounds.high) : low
  const top = Math.max(0, Math.min(paneHeight - 6, Math.min(low, high) - (low === high ? 3 : 0)))
  const height = Math.max(6, Math.min(paneHeight, Math.max(low, high)) - top)
  const width = Math.max(2, right - x)
  const figures: OverlayFigure[] = [{
    type: 'rect', attrs: { x, y: top, width, height },
    styles: { style: 'stroke_fill' },
  }]
  const text = (label: string, labelX: number, labelY: number, color: string) => {
    figures.push({ type: 'text', attrs: { x: labelX, y: labelY, text: label, baseline: 'bottom' },
      styles: { color, size: 11, backgroundColor: 'rgba(18,26,39,0.86)', paddingLeft: 3, paddingRight: 3 }, ignoreEvent: true })
  }
  if (message) text(message, x + 4, Math.min(paneHeight - 2, top + 17), settings.levelColor)
  if (!profile || !yAxis) return figures
  const type = volumeProfileDisplayType(settings.type, settings.showDelta)
  text({ volumeDelta: 'Delta / 成交量', volume: '成交量', bidAsk: 'Bid / Ask', delta: 'Delta' }[type],
    x + 4, Math.min(paneHeight - 2, top + (message ? 30 : 17)), settings.levelColor)
  paintVolumeProfileRows(profile, type, settings, {
    axisX: x, barWidth: width * settings.width / 100, paneHeight, pixelAt: value => yAxis.convertToPixel(value),
  }, (left, top, width, height, color) => {
    figures.push({ type: 'rect', attrs: { x: left, y: top, width, height }, styles: { color }, ignoreEvent: true })
  }, settings.showValues ? (row, top, height) => {
    if (height >= 13) text(formatProfileAmount(type, row), x + 4, top + height, '#e7eef8')
  } : undefined)
  let lastLabel = -Infinity
  for (const { name, value, color, solid, y: level } of volumeProfilePriceLines(profile, settings, value => yAxis.convertToPixel(value))) {
    if (level < 0 || level >= paneHeight) continue
    figures.push({ type: 'line', attrs: { coordinates: [{ x, y: level }, { x: right, y: level }] },
      styles: { color, size: solid ? 1.5 : 1, style: solid ? 'solid' : 'dashed', dashedValue: [4, 3] },
      ignoreEvent: true })
    const labelY = Math.max(level, lastLabel + 13)
    if (settings.showLabels) text(`${name} ${value.toFixed(precision.price)}`, x + 4, labelY, color)
    lastLabel = labelY
  }
  return figures
}

function drawBigTrades({ ctx, indicator, xAxis, yAxis, visibleRange, bounding, kLineDataList }: IndicatorDrawParams): boolean {
  const display = indicator.extendData as BubbleDisplay | undefined
  const mode = bigTradeMode(indicator.styles)
  if (!display?.timeframe || display.mode !== mode || (!display.points?.size && !display.updating)) return true
  const minimum = indicator.calcParams[0] as number
  const settings = display.settings ?? orderFlowSettings('bubbles')
  const threshold = bigTradeThreshold(settings, minimum)
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
    const points = display.points?.get(candle.timestamp)
    if (!points) continue
    const bar = display.bars?.get(candle.timestamp)
    if (!bar) continue
    const end = nextOpenTime(candle.timestamp, display.timeframe)
    for (const point of points) {
      const { trade, amount } = point
      const radius = tradeBubbleRadius(amount, threshold, settings)
      const y = yAxis.convertToPixel(tradeBubblePrice(trade, bar, candle.open, display.projectToCandle))
      if (y + radius < 0 || y - radius > bounding.height) continue
      const x = xAxis.convertToPixel(index + tradeBubbleOffset(point, candle.timestamp, end))
      const { fill, outline } = colors[trade.side]
      ctx.globalAlpha = tradeBubbleOpacity(amount, threshold, settings)
      ctx.beginPath()
      if (settings.marker === 'circle') ctx.arc(x, y, radius, 0, Math.PI * 2)
      else if (settings.marker === 'square') ctx.rect(x - radius, y - radius, 2 * radius, 2 * radius)
      else {
        ctx.moveTo(x - radius, y)
        ctx.lineTo(x, y - radius)
        ctx.lineTo(x + radius, y)
        ctx.lineTo(x, y + radius)
        ctx.closePath()
      }
      if (!settings.hollow) {
        ctx.fillStyle = fill
        ctx.fill()
      }
      ctx.strokeStyle = outline
      ctx.stroke()
      if (settings.showText) {
        ctx.globalAlpha = 1
        ctx.fillStyle = settings.textColor
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        drawTradeBubbleLabel(ctx, threshold.unit === 'notional' ? trade.size : amount, x, y, radius, settings.marker)
      }
    }
  }
  ctx.restore()
  return true
}

export function registerOrderFlow(): void {
  registerOrderFlowIndicators()
  registerOverlay({
    name: VOLUME_PROFILE_TOOL, totalStep: 3, needDefaultPointFigure: true, createPointFigures: drawVolumeProfile,
    performEventMoveForDrawing({ points, performPoint }) {
      const value = profileDisplayCenter(this.extendData as ProfileDisplay | undefined) ?? points[0]?.value
      if (value !== undefined) performPoint.value = value
    },
    styles: { rect: { color: 'rgba(99,145,208,0.07)', borderColor: 'rgba(151,184,226,0.65)', borderSize: 1 } },
  })
  registerIndicator({
    name: BIG_TRADES, shortName: bigTradesTitle, calcParams: [DEFAULT_BIG_TRADE_NOTIONAL], figures: [],
    calc: () => [], draw: drawBigTrades,
    createTooltipDataSource: ({ indicator, defaultStyles }): IndicatorTooltipData => {
      const display = indicator.extendData as BubbleDisplay | undefined
      const { unit, minimum } = bigTradeThreshold(display?.settings ?? orderFlowSettings('bubbles'), Number(indicator.calcParams[0]))
      const message = display ? display.message : '使用交易所逐笔成交'
      return {
        name: bigTradesTitle,
        calcParamsText: `${bigTradeMode(indicator.styles) === 'aggregate' ? 'Aggregate' : 'Volume'} · ${minimum} ${bigTradeThresholdUnits[unit]}`,
        icons: defaultStyles.tooltip.icons.filter(icon => icon.id !== (indicator.visible ? 'visible' : 'invisible')),
        values: message ? [{ title: '', value: message }] : [],
      }
    },
  })
}
