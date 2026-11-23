import { registerIndicator, registerOverlay, type IndicatorDrawParams, type IndicatorTooltipData,
  type OverlayCreateFiguresCallbackParams, type OverlayFigure } from 'klinecharts'
import { BIG_TRADES, DEFAULT_BIG_TRADE_NOTIONAL, VOLUME_PROFILE_TOOL, bigTradeColors, bigTradeMode,
  type BigTradeMode, type VolumeProfile } from './order-flow'
import type { TradeRange } from '../market-data/bybit/combined-source'
import type { BybitTrade } from '../market-data/bybit/trades'
import { drawingIndexAt } from './drawing-coordinates'
import { displayedTradeBubbles, type TradeBar, type TradeBubble } from './order-flow-bars'
import { nextOpenTime } from '../market-data/intervals'
import { orderFlowSettings } from './order-flow-preferences'
import { formatFlowAmount, registerOrderFlowIndicators } from './order-flow-indicators'

export const CANDLE_PANE = 'candle_pane'
export const bigTradesTitle = '大单气泡（Big Trades）'
type BubbleSettings = ReturnType<typeof orderFlowSettings<'bubbles'>>
type ProfileSettings = ReturnType<typeof orderFlowSettings<'profile'>>

export interface ProfileDisplay { profile?: VolumeProfile; message?: string; settings?: ProfileSettings }
export interface BubbleDisplay {
  bars?: ReadonlyMap<number, TradeBar>
  mode?: BigTradeMode
  updating?: TradeRange
  timeframe?: string
  projectToCandle?: boolean
  message?: string
  settings?: BubbleSettings
}

export function tradeBubbleRadius(trade: BybitTrade, minimum: number, settings: BubbleSettings): number {
  return Math.min(settings.maxRadius, Math.max(settings.minRadius, 5 * Math.sqrt(trade.price * trade.size / Math.max(1, minimum))))
}

export function* filteredTradeBubbles(bar: TradeBar, mode: BigTradeMode, minimum: number, maximum: number): Iterable<TradeBubble> {
  for (const point of displayedTradeBubbles(bar, mode, minimum)) {
    if (maximum === 0 || point.trade.price * point.trade.size <= maximum) yield point
  }
}

export function tradeBubbleOffset(point: TradeBubble, start: number, end: number): number {
  return (point.trade.timeUs / 1000 - start) / (end - start) - 0.5
}

export function tradeBubblePrice(trade: BybitTrade, bar: TradeBar, open: number, project?: boolean): number {
  return project && !trade.venue && bar.firstBybitPrice ? trade.price * open / bar.firstBybitPrice : trade.price
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
    styles: { style: 'stroke_fill' },
  }]
  const { profile, message, settings = orderFlowSettings('profile') } = overlay.extendData as ProfileDisplay ?? {}
  const text = (label: string, labelX: number, labelY: number, color: string) => {
    figures.push({ type: 'text', attrs: { x: labelX, y: labelY, text: label, baseline: 'bottom' },
      styles: { color, size: 11, backgroundColor: 'rgba(18,26,39,0.86)', paddingLeft: 3, paddingRight: 3 }, ignoreEvent: true })
  }
  if (message) text(message, x + 4, y + 17, settings.levelColor)
  if (!profile || !yAxis) return figures
  const { type } = settings
  text({ volumeDelta: 'Delta / 成交量', volume: '成交量', bidAsk: 'Bid / Ask', delta: 'Delta' }[type],
    x + 4, y + (message ? 30 : 17), settings.levelColor)
  const maxVolume = Math.max(...profile.rows.map(row => row.buy + row.sell))
  const maxDelta = Math.max(...profile.rows.map(row => Math.abs(row.buy - row.sell)))
  const maxSide = Math.max(...profile.rows.map(row => Math.max(row.buy, row.sell)))
  const barWidth = width * settings.width / 100
  const addBar = (left: number, top: number, width: number, height: number, color: string) => {
    if (width > 0) figures.push({ type: 'rect', attrs: { x: left, y: top, width, height }, styles: { color }, ignoreEvent: true })
  }
  for (const row of profile.rows) {
    const volume = row.buy + row.sell
    if (!volume) continue
    const first = yAxis.convertToPixel(row.high)
    const last = yAxis.convertToPixel(row.low)
    const top = Math.min(first, last)
    const rowHeight = Math.max(1, Math.abs(last - first) - 0.7)
    const delta = row.buy - row.sell
    const volumeWidth = volume / maxVolume * barWidth
    const deltaWidth = maxDelta ? Math.abs(delta) / maxDelta * barWidth : 0
    if (type === 'volume' || type === 'volumeDelta') {
      const inArea = settings.showValueArea && row.low < profile.vah && row.high > profile.val
      addBar(x, top, volumeWidth, rowHeight, inArea ? settings.valueAreaColor : settings.volumeColor)
    }
    if (type === 'delta' || type === 'volumeDelta') {
      const left = type === 'volumeDelta' || delta < 0 ? x - deltaWidth : x
      addBar(left, top, deltaWidth, rowHeight, delta > 0 ? settings.askColor : settings.bidColor)
    }
    if (type === 'bidAsk') {
      const sellWidth = row.sell / maxSide * barWidth
      addBar(x - sellWidth, top, sellWidth, rowHeight, settings.bidColor)
      addBar(x, top, row.buy / maxSide * barWidth, rowHeight, settings.askColor)
    }
    if (settings.showValues && rowHeight >= 13) {
      const value = type === 'bidAsk' ? `${formatFlowAmount(row.sell)} / ${formatFlowAmount(row.buy)}`
        : type === 'volumeDelta' ? `${formatFlowAmount(delta)} / ${formatFlowAmount(volume)}`
          : formatFlowAmount(type === 'delta' ? delta : volume)
      text(value, x + 4, top + rowHeight, '#e7eef8')
    }
  }
  const levels = [['VAH', profile.vah], ['POC', profile.poc], ['VAL', profile.val]] as const
  let lastLabel = -Infinity
  for (const { name, value, level } of levels.map(([name, value]) => ({ name, value, level: yAxis.convertToPixel(value) })).sort((a, b) => a.level - b.level)) {
    if (name === 'POC' ? !settings.showPoc : !settings.showValueArea) continue
    const color = name === 'POC' ? settings.pocColor : settings.levelColor
    figures.push({ type: 'line', attrs: { coordinates: [{ x, y: level }, { x: right, y: level }] },
      styles: { color, size: name === 'POC' ? 1.5 : 1, style: name === 'POC' ? 'solid' : 'dashed', dashedValue: [4, 3] },
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
  if (!display?.timeframe || display.mode !== mode || (!display.bars?.size && !display.updating)) return true
  const minimum = indicator.calcParams[0] as number
  const settings = display.settings ?? orderFlowSettings('bubbles')
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
    for (const point of filteredTradeBubbles(bar, mode, minimum, settings.maxNotional)) {
      const { trade } = point
      const radius = tradeBubbleRadius(trade, minimum, settings)
      const y = yAxis.convertToPixel(tradeBubblePrice(trade, bar, candle.open, display.projectToCandle))
      if (y + radius < 0 || y - radius > bounding.height) continue
      const x = xAxis.convertToPixel(index + tradeBubbleOffset(point, candle.timestamp, end))
      const { fill, outline } = colors[trade.side]
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
      if (settings.showText && radius >= 5) {
        ctx.fillStyle = settings.textColor
        ctx.font = '10px system-ui'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(formatFlowAmount(trade.size), x, y, 2 * radius)
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
    styles: { rect: { color: 'rgba(99,145,208,0.07)', borderColor: 'rgba(151,184,226,0.65)', borderSize: 1 } },
  })
  registerIndicator({
    name: BIG_TRADES, shortName: bigTradesTitle, calcParams: [DEFAULT_BIG_TRADE_NOTIONAL], figures: [],
    calc: () => [], draw: drawBigTrades,
    createTooltipDataSource: ({ indicator, defaultStyles }): IndicatorTooltipData => ({
      name: bigTradesTitle, calcParamsText: `${bigTradeMode(indicator.styles) === 'aggregate' ? 'Aggregate' : 'Volume'} · ${indicator.calcParams[0]} USDT`,
      icons: defaultStyles.tooltip.icons.filter(icon => icon.id !== (indicator.visible ? 'visible' : 'invisible')),
      values: indicator.extendData
        ? ((indicator.extendData as BubbleDisplay).message ? [{ title: '', value: (indicator.extendData as BubbleDisplay).message! }] : [])
        : [{ title: '', value: '使用交易所逐笔成交' }],
    }),
  })
}
