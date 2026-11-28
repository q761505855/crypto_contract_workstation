import { registerIndicator, type IndicatorDrawParams, type IndicatorTooltipData } from 'klinecharts'
import { paintVolumeProfileRows, volumeProfileBarColor, volumeProfileDisplayType, volumeProfilePriceLines, type VolumeProfile, type VolumeProfilePrices, type VolumeProfileRow } from './order-flow'
import type { CvdCandle, FootprintRow, VwapPoint } from './order-flow-metrics'
import { CANDLE_VOLUME_PROFILE, CVD, FOOTPRINT, VISIBLE_VOLUME_PROFILE, VWAP, orderFlowSettings, type FootprintType } from './order-flow-preferences'

export const footprintTitle = '足迹图（Footprint）'
export const cvdTitle = '累计成交量差（CVD）'
export const visibleProfileTitle = '可见范围成交分布（Volume Profile）'
export const candleProfileTitle = 'K线成交量分布图'
const defaultVisibleProfile = orderFlowSettings('visibleProfile')

export interface FootprintDisplay {
  rows?: ReadonlyMap<number, readonly FootprintRow[]>
  settings: ReturnType<typeof orderFlowSettings<'footprint'>>
  message?: string
  shareCandleSpace?: boolean
}

export interface CvdDisplay {
  values?: ReadonlyMap<number, CvdCandle>
  settings: ReturnType<typeof orderFlowSettings<'cvd'>>
  message?: string
}

type CvdPoint = Partial<CvdCandle> & { zero?: number }

export interface VwapDisplay {
  values?: ReadonlyMap<number, VwapPoint>
  precision: number
  message?: string
}

export interface VisibleProfileDisplay {
  rows?: readonly VolumeProfileRow[]
  prices?: VolumeProfilePrices
  precision: number
  axisInset: () => number
  settings?: typeof defaultVisibleProfile
  message?: string
}

export interface CandleProfileDisplay {
  profiles?: ReadonlyMap<number, VolumeProfile>
  settings: ReturnType<typeof orderFlowSettings<'candleProfile'>>
  precision: number
  message?: string
}

const amount = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 })
export const formatFlowAmount = (value: number): string => amount.format(value)

export function formatProfileAmount(type: CandleProfileDisplay['settings']['type'], { buy, sell }: VolumeProfileRow): string {
  if (type === 'bidAsk') return `${formatFlowAmount(sell)} / ${formatFlowAmount(buy)}`
  if (type === 'volumeDelta') return `${formatFlowAmount(buy - sell)} / ${formatFlowAmount(buy + sell)}`
  return formatFlowAmount(type === 'delta' ? buy - sell : buy + sell)
}

type DrawFootprintCell = (value: number, maximum: number, left: number, size: number, color: string, imbalance: boolean) => void

function paintFootprint({ ctx, barSpace, bounding, indicator, kLineDataList, visibleRange, xAxis, yAxis }: IndicatorDrawParams, foreground: boolean): void {
  const display = indicator.extendData as FootprintDisplay | undefined
  if (!display?.rows || barSpace.bar < 18 || (foreground && !display.settings.showText)) return
  const { settings } = display
  const plotType = settings.plotType === 'matchText' ? settings.type : settings.plotType
  const width = display.shareCandleSpace ? barSpace.bar / 2 - 8 : barSpace.bar - 14
  if (width < 4) return
  const half = (width - 1) / 2
  const splitText = settings.type === 'bidAsk' || settings.type === 'volumeDelta'
  if (foreground && (splitText ? half : width) < 10) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, bounding.width, bounding.height)
  ctx.clip()
  if (foreground) {
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
  }
  for (let index = Math.max(visibleRange.from, 0); index < Math.min(visibleRange.to, kLineDataList.length); index++) {
    const rows = display.rows.get(kLineDataList[index].timestamp)
    if (!rows?.length) continue
    const x = xAxis.convertToPixel(index) + 6
    let maxVolume = 0
    let maxDelta = 0
    let previousTextY = Infinity
    let previousFontSize = 0
    if (!foreground) {
      for (const { buy, sell } of rows) {
        maxVolume = Math.max(maxVolume, buy + sell)
        maxDelta = Math.max(maxDelta, Math.abs(buy - sell))
      }
    }
    for (const row of rows) {
      const low = yAxis.convertToPixel(row.low)
      const high = yAxis.convertToPixel(row.high)
      const top = Math.min(low, high)
      const height = Math.max(1, Math.abs(high - low) - 0.5)
      if (top > bounding.height || top + height < 0) continue
      const volume = row.buy + row.sell
      const delta = row.buy - row.sell
      const side = delta >= 0 ? settings.askColor : settings.bidColor
      const imbalance = row.askImbalance || row.bidImbalance
      const drawCells = (type: FootprintType, cell: DrawFootprintCell) => {
        if (type === 'bidAsk') {
          cell(row.sell, maxVolume, x, half, settings.bidColor, row.bidImbalance)
          cell(row.buy, maxVolume, x + half + 1, half, settings.askColor, row.askImbalance)
        } else if (type === 'volumeDelta') {
          cell(delta, maxDelta, x, half, side, imbalance)
          cell(volume, maxVolume, x + half + 1, half, side, false)
        } else {
          cell(type === 'volume' ? volume : delta, type === 'volume' ? maxVolume : maxDelta, x, width, side, imbalance)
        }
      }
      if (foreground) {
        const textY = top + height / 2
        const fontSize = rows.length === 1 ? settings.fontSize
          : Math.min(settings.fontSize, Math.max(8, Math.floor(Math.abs(high - low))))
        if (Math.abs(textY - previousTextY) < (previousFontSize + fontSize) / 2) continue
        ctx.font = `${fontSize}px system-ui`
        drawCells(settings.type, (value, _maximum, left, size, _color, highlight) => {
          ctx.fillStyle = settings.showImbalance && highlight ? settings.imbalanceColor : settings.textColor
          ctx.fillText(formatFlowAmount(value), left + size / 2, textY, size - 2)
        })
        previousTextY = textY
        previousFontSize = fontSize
        continue
      }
      drawCells(plotType, (value, maximum, left, size, color, highlight) => {
        const ratio = maximum > 0 ? Math.abs(value) / maximum : 0
        const fillWidth = settings.layout === 'histogram' ? size * ratio : size
        ctx.globalAlpha = settings.shading === 'fade' ? 0.13 + ratio * 0.58 : 0.48
        ctx.fillStyle = color
        if (value !== 0) ctx.fillRect(left, top, fillWidth, height)
        ctx.globalAlpha = 1
        if (settings.showImbalance && highlight) {
          ctx.fillStyle = settings.imbalanceColor
          ctx.fillRect(left, top, Math.min(2, size), height)
        }
      })
      if (settings.showPoc && row.poc) {
        ctx.strokeStyle = settings.pocColor
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, top + 0.5, width - 1, Math.max(0, height - 1))
      }
    }
  }
  ctx.restore()
}

export function drawFootprint(params: IndicatorDrawParams): boolean {
  paintFootprint(params, false)
  // A running chart can still use the previous dependency bundle during an update.
  if (!params.indicator.drawForeground) drawFootprintText(params)
  return true
}

export function drawFootprintText(params: IndicatorDrawParams): void {
  paintFootprint(params, true)
}

function drawCvd({ ctx, barSpace, indicator, visibleRange, xAxis, yAxis, bounding }: IndicatorDrawParams<CvdPoint>): boolean {
  const display = indicator.extendData as CvdDisplay | undefined
  if (!display?.values?.size) return true
  const { settings } = display
  const zero = yAxis.convertToPixel(0)
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, bounding.width, bounding.height)
  ctx.clip()
  if (settings.showZero) {
    ctx.fillStyle = settings.zeroColor
    ctx.fillRect(0, zero, bounding.width, 1)
  }
  let previous: { x: number; y: number } | undefined
  for (let index = Math.max(visibleRange.from - 1, 0); index < Math.min(visibleRange.to + 1, indicator.result.length); index++) {
    const { open, high, low, close } = indicator.result[index] ?? {}
    if (close === undefined) { previous = undefined; continue }
    const x = xAxis.convertToPixel(index)
    const y = yAxis.convertToPixel(close)
    const color = close >= 0 ? settings.positiveColor : settings.negativeColor
    if (settings.plot === 'candlestick' && open !== undefined && high !== undefined && low !== undefined) {
      const top = yAxis.convertToPixel(high)
      const bottom = yAxis.convertToPixel(low)
      const openY = yAxis.convertToPixel(open)
      const width = Math.max(1, Math.min(18, barSpace.gapBar))
      ctx.fillStyle = close >= open ? settings.positiveColor : settings.negativeColor
      ctx.fillRect(x - 0.5, top, 1, bottom - top)
      ctx.fillRect(x - width / 2, Math.min(openY, y), width, Math.max(1, Math.abs(openY - y)))
    } else if (settings.plot === 'histogram') {
      ctx.fillStyle = color
      const width = Math.min(18, barSpace.gapBar)
      ctx.fillRect(x - width / 2, Math.min(y, zero), width, Math.max(1, Math.abs(y - zero)))
    } else if (settings.plot === 'line') {
      ctx.strokeStyle = color
      ctx.lineWidth = settings.lineWidth
      ctx.beginPath()
      ctx.moveTo(previous?.x ?? x - 1, previous?.y ?? y)
      ctx.lineTo(x, y)
      ctx.stroke()
    }
    previous = { x, y }
  }
  ctx.restore()
  return true
}

function drawVwap({ ctx, indicator, visibleRange, xAxis, yAxis, barSpace }: IndicatorDrawParams<Partial<VwapPoint>>): boolean {
  const { result } = indicator
  ctx.save()
  ctx.strokeStyle = '#f4bc58'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let index = Math.max(0, visibleRange.from - 1); index < Math.min(visibleRange.to + 1, result.length); index++) {
    const point = result[index]
    if (point?.price === undefined) continue
    const x = xAxis.convertToPixel(index)
    const y = yAxis.convertToPixel(point.price)
    if (result[index - 1]?.price !== undefined && result[index - 1].day === point.day && index > Math.max(0, visibleRange.from - 1)) {
      ctx.lineTo(x, y)
    } else {
      ctx.moveTo(x - barSpace.gapBar / 2, y)
      ctx.lineTo(x, y)
    }
  }
  ctx.stroke()
  ctx.restore()
  return true
}

function paintCandleVolumeProfile({ ctx, barSpace, bounding, indicator, kLineDataList, visibleRange, xAxis, yAxis }: IndicatorDrawParams, foreground: boolean): void {
  const display = indicator.extendData as CandleProfileDisplay | undefined
  if (!display?.profiles?.size) return
  const { profiles, settings, precision } = display
  if (foreground && !settings.showPoc && !settings.showValueArea) return
  const type = volumeProfileDisplayType(settings.type, settings.showDelta)
  const split = type !== 'volume'
  const availableWidth = barSpace.bar / 2 - 6
  const minimumWidth = split ? 5 : 2
  if (availableWidth < minimumWidth) return
  const width = Math.max(minimumWidth, availableWidth * settings.width / 100)
  const barWidth = split ? width / 2 : width

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, bounding.width, bounding.height)
  ctx.clip()
  ctx.globalCompositeOperation = foreground ? 'source-over' : 'destination-over'
  ctx.font = '10px system-ui'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  const pixelAt = (value: number) => yAxis.convertToPixel(value)
  const paintBar = (x: number, top: number, size: number, height: number, color: string) => {
    ctx.fillStyle = color
    ctx.fillRect(x, top, size, height)
  }
  for (let index = Math.max(0, visibleRange.from); index < Math.min(visibleRange.to, kLineDataList.length); index++) {
    const profile = profiles.get(kLineDataList[index].timestamp)
    if (!profile) continue
    const candleX = xAxis.convertToPixel(index)
    const right = candleX - 6
    const axisX = right - barWidth
    if (!foreground) {
      paintVolumeProfileRows(profile, type, settings, { axisX, barWidth, paneHeight: bounding.height, pixelAt },
        paintBar, settings.showValues && barWidth >= 18 ? (row, top, height) => {
          if (height < 13) return
          ctx.fillStyle = '#e7eef8'
          ctx.fillText(formatProfileAmount(type, row), axisX + 2, top + height, barWidth - 2)
        } : undefined)
      if (settings.showValueArea) {
        const vah = pixelAt(profile.vah)
        const val = pixelAt(profile.val)
        const top = Math.max(0, Math.min(vah, val))
        const bottom = Math.min(bounding.height, Math.max(vah, val))
        if (bottom > top) {
          // In destination-over mode this later fill goes behind the bars.
          const alpha = ctx.globalAlpha
          ctx.globalAlpha = alpha * 0.20
          paintBar(axisX, top, barWidth, bottom - top, settings.valueAreaColor)
          ctx.globalAlpha = alpha
        }
      }
      continue
    }
    const lineEnd = candleX + barSpace.bar / 2
    let lastLabel = -Infinity
    for (const { name, value, color, solid, y } of volumeProfilePriceLines(profile, settings, pixelAt)) {
      if (y < 0 || y >= bounding.height) continue
      ctx.strokeStyle = color
      ctx.lineWidth = solid ? 1.5 : 1
      ctx.setLineDash(solid ? [] : [4, 3])
      ctx.beginPath()
      ctx.moveTo(axisX, y)
      ctx.lineTo(lineEnd, y)
      ctx.stroke()
      if (settings.showLabels && barWidth >= 24) {
        const label = `${name} ${value.toFixed(precision)}`
        lastLabel = Math.max(10, y, lastLabel + 11)
        if (lastLabel > bounding.height) continue
        const labelWidth = Math.min(barWidth, ctx.measureText(label).width + 4)
        ctx.fillStyle = 'rgba(18,26,39,0.86)'
        ctx.fillRect(axisX, lastLabel - 10, labelWidth, 11)
        ctx.fillStyle = color
        ctx.fillText(label, axisX + 2, lastLabel, labelWidth - 2)
      }
    }
  }
  ctx.restore()
}

export function drawCandleVolumeProfile(params: IndicatorDrawParams): boolean {
  paintCandleVolumeProfile(params, false)
  // Keep the lines visible with an older chart runtime during an update.
  if (!params.indicator.drawForeground) drawCandleVolumeProfileLevels(params)
  return true
}

export function drawCandleVolumeProfileLevels(params: IndicatorDrawParams): void {
  paintCandleVolumeProfile(params, true)
}

export function drawVisibleVolumeProfile({ ctx, bounding, indicator, yAxis }: IndicatorDrawParams): boolean {
  const display = indicator.extendData as VisibleProfileDisplay | undefined
  if (!display?.rows?.length) return true
  const { settings = defaultVisibleProfile, rows, prices } = display
  const type = volumeProfileDisplayType(settings.type, settings.showDelta)
  const showVolume = type !== 'delta'
  const showDelta = type !== 'volume'
  const both = showVolume && showDelta
  const right = bounding.width - display.axisInset() - 3
  const available = right - 3
  const offset = Math.floor(available * settings.offset / 100)
  const totalWidth = Math.floor(available * settings.width / 100)
  const left = settings.placement === 'left' ? 3 + offset : right - offset - totalWidth
  const columnWidth = both ? (totalWidth - 2) / 2 : totalWidth
  if (columnWidth < 4) return true
  const deltaLeft = both ? left + columnWidth + 2 : left
  const maxVolume = showVolume ? Math.max(...rows.map(({ buy, sell }) => buy + sell)) : 0
  const maxDelta = showDelta ? Math.max(...rows.map(({ buy, sell }) => Math.abs(buy - sell))) : 0
  ctx.save()
  ctx.beginPath()
  ctx.rect(left, 0, totalWidth, bounding.height)
  ctx.clip()
  for (const { low, high, buy, sell } of rows) {
    if (!(buy + sell)) continue
    const y1 = yAxis.convertToPixel(low)
    const y2 = yAxis.convertToPixel(high)
    const top = Math.min(y1, y2)
    const height = Math.max(1, Math.abs(y1 - y2) - 0.5)
    if (top >= bounding.height || top + height <= 0) continue
    if (maxVolume > 0) {
      const volumeWidth = (buy + sell) / maxVolume * columnWidth
      ctx.fillStyle = volumeProfileBarColor({ low, high }, prices, settings)
      ctx.fillRect(left + columnWidth - volumeWidth, top, volumeWidth, height)
    }
    const delta = buy - sell
    if (maxDelta > 0 && delta !== 0) {
      ctx.fillStyle = delta > 0 ? settings.positiveColor : settings.negativeColor
      ctx.fillRect(deltaLeft, top, Math.abs(delta) / maxDelta * columnWidth, height)
    }
  }
  if (settings.showHeaders && columnWidth >= 32) {
    ctx.font = '11px system-ui'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    if (showVolume) {
      ctx.fillStyle = '#92b5f6'
      ctx.fillText('成交量', left + columnWidth / 2, 5, columnWidth)
    }
    if (showDelta) {
      ctx.fillStyle = '#aab7c9'
      ctx.fillText('Delta', deltaLeft + columnWidth / 2, 5, columnWidth)
    }
  }
  ctx.restore()
  if (prices) {
    const lines = volumeProfilePriceLines(prices, settings, value => yAxis.convertToPixel(value))
    ctx.save()
    ctx.font = '11px system-ui'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    let lastLabel = settings.showHeaders && columnWidth >= 32 ? 15 : 0
    for (const { name, value, color, solid, y } of lines) {
      if (y < 0 || y > bounding.height) continue
      ctx.strokeStyle = color
      ctx.lineWidth = solid ? 1.5 : 1
      ctx.setLineDash(solid ? [] : [4, 3])
      ctx.beginPath()
      ctx.moveTo(left, y)
      ctx.lineTo(0, y)
      ctx.stroke()
      if (settings.showLabels && totalWidth > 6) {
        const label = `${name} ${value.toFixed(display.precision)}`
        lastLabel = Math.max(y, lastLabel + 13)
        const labelWidth = Math.min(totalWidth, ctx.measureText(label).width + 6)
        ctx.fillStyle = 'rgba(18,26,39,0.86)'
        ctx.fillRect(left, lastLabel - 12, labelWidth, 13)
        ctx.fillStyle = color
        ctx.fillText(label, left + 3, lastLabel, totalWidth - 6)
      }
    }
    ctx.restore()
  }
  return true
}

function flowTooltip(name: string, defaultStyles: IndicatorDrawParams['defaultStyles'], visible: boolean,
  values: IndicatorTooltipData['values'], configurable = false): IndicatorTooltipData {
  const icons = defaultStyles.tooltip.icons.filter(icon =>
    icon.id !== (visible ? 'visible' : 'invisible') && (configurable || icon.id !== 'setting'))
  return { name, calcParamsText: '', icons, values }
}

export function registerOrderFlowIndicators(): void {
  registerIndicator<Partial<VwapPoint>>({
    name: VWAP, shortName: VWAP, calcParams: [], figures: [{ key: 'price' }],
    calc: (candles, { extendData }) => {
      const display = extendData as VwapDisplay | undefined
      return candles.map(({ timestamp }) => display?.values?.get(timestamp) ?? {})
    },
    draw: drawVwap,
    createTooltipDataSource: ({ indicator, crosshair, defaultStyles }) => {
      const display = indicator.extendData as VwapDisplay | undefined
      const price = indicator.result[crosshair.dataIndex ?? indicator.result.length - 1]?.price
      const values: IndicatorTooltipData['values'] = []
      if (price !== undefined) values.push({ title: '', value: price.toFixed(display?.precision ?? 2) })
      if (display?.message) values.push({ title: '', value: display.message })
      return flowTooltip(VWAP, defaultStyles, indicator.visible, values)
    },
  })
  registerIndicator({
    name: CANDLE_VOLUME_PROFILE, shortName: candleProfileTitle, calcParams: [], figures: [], zLevel: -1, calc: () => [],
    draw: drawCandleVolumeProfile,
    drawForeground: drawCandleVolumeProfileLevels,
    createTooltipDataSource: ({ indicator, defaultStyles }) => {
      const message = (indicator.extendData as CandleProfileDisplay | undefined)?.message
      return flowTooltip(candleProfileTitle, defaultStyles, indicator.visible, message ? [{ title: '', value: message }] : [], true)
    },
  })
  registerIndicator({
    name: VISIBLE_VOLUME_PROFILE, shortName: visibleProfileTitle, calcParams: [], figures: [], calc: () => [],
    draw: drawVisibleVolumeProfile,
    createTooltipDataSource: ({ indicator, defaultStyles }) => {
      const message = (indicator.extendData as VisibleProfileDisplay | undefined)?.message
      return flowTooltip(visibleProfileTitle, defaultStyles, indicator.visible, message ? [{ title: '', value: message }] : [], true)
    },
  })
  registerIndicator({
    name: FOOTPRINT, shortName: footprintTitle, zLevel: -1, calc: () => [], draw: drawFootprint, figures: [],
    drawForeground: drawFootprintText,
    createTooltipDataSource: ({ indicator, defaultStyles }): IndicatorTooltipData => {
      const message = (indicator.extendData as FootprintDisplay | undefined)?.message
      return { name: footprintTitle, calcParamsText: '', icons: defaultStyles.tooltip.icons.filter(icon => icon.id !== (indicator.visible ? 'visible' : 'invisible')),
        values: message ? [{ title: '', value: message }] : [] }
    },
  })
  registerIndicator({
    name: CVD, shortName: cvdTitle, precision: 3,
    figures: [{ key: 'open' }, { key: 'high' }, { key: 'low' }, { key: 'close' }, { key: 'zero' }],
    calc: (candles, indicator) => {
      const display = indicator.extendData as CvdDisplay | undefined
      return candles.map(({ timestamp }) => {
        const candle = display?.values?.get(timestamp)
        if (!candle || !display) return {}
        const { plot, showZero } = display.settings
        const zero = showZero || plot === 'histogram' ? 0 : undefined
        return { ...(plot === 'candlestick' ? candle : { close: candle.close }), zero }
      })
    },
    draw: drawCvd,
    createTooltipDataSource: ({ indicator, crosshair, defaultStyles }): IndicatorTooltipData => {
      const display = indicator.extendData as CvdDisplay | undefined
      const point = indicator.result[crosshair.dataIndex ?? indicator.result.length - 1] as CvdPoint | undefined
      const { open, high, low, close } = point ?? {}
      const values: IndicatorTooltipData['values'] = []
      if (open !== undefined && high !== undefined && low !== undefined && close !== undefined) {
        values.push({ title: '开 ', value: formatFlowAmount(open) }, { title: '高 ', value: formatFlowAmount(high) },
          { title: '低 ', value: formatFlowAmount(low) }, { title: '收 ', value: formatFlowAmount(close) })
      } else if (close !== undefined) values.push({ title: '', value: formatFlowAmount(close) })
      if (display?.message) values.push({ title: '', value: display.message })
      return { name: cvdTitle, calcParamsText: '', icons: defaultStyles.tooltip.icons.filter(icon => icon.id !== (indicator.visible ? 'visible' : 'invisible')),
        values }
    },
  })
}
