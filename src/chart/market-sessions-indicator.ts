import { registerIndicator, type IndicatorDrawParams, type IndicatorTemplate } from 'klinecharts'
import { drawingIndexAt, drawingTimeAt } from './drawing-coordinates'
import { isMarketSessionTimeframe, MARKET_SESSIONS, SESSION_MARKETS, marketSessionForecast, marketSessionReference, marketSessionWindows } from './market-session-times'
import { MARKET_SESSION_STYLES, marketSessionStyles, sessionAccentColor } from './market-session-styles'

const lineDashes = { solid: [], dashed: [5, 4], dotted: [1, 3] }
type SessionContext = { timeframe: string; confirmedUntil: number }

export function drawMarketSessions(
  { ctx, indicator, kLineDataList, visibleRange, bounding, xAxis }: IndicatorDrawParams,
  { timeframe, confirmedUntil }: SessionContext,
): boolean {
  if (kLineDataList.length === 0 || !isMarketSessionTimeframe(timeframe)) return true
  const { sessionVisibility, sessionFills, sessionLines } = marketSessionStyles(indicator.styles)
  if (!sessionVisibility.some(Boolean)) return true

  const left = drawingTimeAt(kLineDataList, Math.max(0, visibleRange.realFrom), timeframe)
  const right = drawingTimeAt(kLineDataList, visibleRange.realTo, timeframe)
  const { width, height } = bounding
  const reference = marketSessionReference(kLineDataList.at(-1)!.timestamp, confirmedUntil, timeframe)
  const sessions = marketSessionWindows(Math.min(left, reference), Math.min(reference, right))
    .filter(session => session.close > left && sessionVisibility[SESSION_MARKETS[session.market].index])
  if (right > reference) {
    sessions.push(...marketSessionForecast(reference, sessionVisibility).sessions.filter(session => session.open <= right && session.close > left))
  }
  if (sessions.length === 0) return true
  const xAt = (time: number) => xAxis.convertToPixel(drawingIndexAt(kLineDataList, time, timeframe))

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, width, height)
  ctx.clip()
  // Composite the translucent fills behind the candles and other indicators.
  ctx.globalCompositeOperation = 'destination-over'
  for (const session of sessions) {
    const start = Math.max(0, xAt(session.open))
    const end = Math.min(width, xAt(session.close))
    if (end <= start) continue
    ctx.fillStyle = sessionFills[SESSION_MARKETS[session.market].index].color
    ctx.fillRect(start, 0, end - start, height)
  }

  const markers = sessions.flatMap(({ market, open, close, closed }) => closed
    ? [{ time: open, title: closed, market, closed: true }]
    : [{ time: open, title: '开盘', market, closed: false }, { time: close, title: '收盘', market, closed: false }],
  ).sort((first, second) => first.time - second.time)

  ctx.globalCompositeOperation = 'source-over'
  ctx.font = '11px sans-serif'
  ctx.textBaseline = 'bottom'
  const [line] = sessionLines
  const labelEnds = [0, 0, 0]
  for (const marker of markers) {
    if ((!marker.closed && marker.time < left) || marker.time > right) continue
    if (!marker.closed && line.size === 0) continue
    const lineX = xAt(marker.time)
    if ((!marker.closed && lineX < 0) || lineX >= width) continue
    const { name, index } = SESSION_MARKETS[marker.market]
    const color = sessionAccentColor(sessionFills[index].color, MARKET_SESSION_STYLES.sessionFills[index].color)
    if (!marker.closed) {
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.9
      ctx.lineWidth = line.size
      ctx.setLineDash(lineDashes[line.style])
      ctx.beginPath()
      const aligned = Math.floor(lineX) + line.size % 2 / 2
      ctx.moveTo(aligned, 0)
      ctx.lineTo(aligned, height)
      ctx.stroke()
    }

    const label = `${name}${marker.title}`
    const labelWidth = ctx.measureText(label).width
    const x = Math.max(3, Math.min(lineX + 3, width - labelWidth - 3))
    const y = height - 5 - index * 14
    if (x < labelEnds[index] || y < 12 || x + labelWidth > width) continue
    ctx.globalAlpha = 1
    ctx.setLineDash([])
    ctx.lineWidth = 3
    ctx.strokeStyle = '#101824'
    ctx.strokeText(label, x, y)
    ctx.fillStyle = color
    ctx.fillText(label, x, y)
    labelEnds[index] = x + labelWidth + 5
  }
  ctx.restore()
  return true
}

export function registerMarketSessionsIndicator(getContext: () => SessionContext): void {
  const template: IndicatorTemplate = {
    name: MARKET_SESSIONS,
    shortName: '市场开收盘',
    calcParams: [],
    figures: [],
    calc: () => [],
    draw: params => drawMarketSessions(params, getContext()),
    createTooltipDataSource: ({ indicator, defaultStyles }) => ({
      name: '市场开收盘',
      calcParamsText: '',
      icons: defaultStyles.tooltip.icons.filter(icon => icon.id !== (indicator.visible ? 'visible' : 'invisible')),
      values: isMarketSessionTimeframe(getContext().timeframe) ? [] : [{ title: '', value: '切换到日内周期查看' }],
    }),
  }
  registerIndicator(template)
}
