import { registerIndicator, type IndicatorDrawParams, type IndicatorTooltipData } from 'klinecharts'
import type { FootprintRow } from './order-flow-metrics'
import { CVD, FOOTPRINT, orderFlowSettings, type FootprintType } from './order-flow-preferences'

export const footprintTitle = '足迹图（Footprint）'
export const cvdTitle = '累计成交量差（CVD）'

export interface FootprintDisplay {
  rows?: ReadonlyMap<number, readonly FootprintRow[]>
  settings: ReturnType<typeof orderFlowSettings<'footprint'>>
  message?: string
}

export interface CvdDisplay {
  values?: ReadonlyMap<number, number>
  settings: ReturnType<typeof orderFlowSettings<'cvd'>>
  message?: string
}

const amount = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 })
export const formatFlowAmount = (value: number): string => amount.format(value)

type DrawFootprintCell = (value: number, maximum: number, left: number, size: number, color: string, imbalance: boolean) => void

function paintFootprint({ ctx, barSpace, bounding, indicator, kLineDataList, visibleRange, xAxis, yAxis }: IndicatorDrawParams, foreground: boolean): void {
  const display = indicator.extendData as FootprintDisplay | undefined
  if (!display?.rows || barSpace.bar < 18 || (foreground && !display.settings.showText)) return
  const { settings } = display
  const plotType = settings.plotType === 'matchText' ? settings.type : settings.plotType
  const width = barSpace.bar - 14
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

function drawCvd({ ctx, barSpace, indicator, visibleRange, xAxis, yAxis, bounding }: IndicatorDrawParams<{ delta?: number; zero?: number }>): boolean {
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
    const delta = indicator.result[index]?.delta
    if (delta === undefined) { previous = undefined; continue }
    const x = xAxis.convertToPixel(index)
    const y = yAxis.convertToPixel(delta)
    const color = delta >= 0 ? settings.positiveColor : settings.negativeColor
    if (settings.plot === 'histogram') {
      ctx.fillStyle = color
      const width = Math.min(18, barSpace.gapBar)
      ctx.fillRect(x - width / 2, Math.min(y, zero), width, Math.max(1, Math.abs(y - zero)))
    } else {
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

export function registerOrderFlowIndicators(): void {
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
    name: CVD, shortName: cvdTitle, precision: 3, figures: [{ key: 'delta' }, { key: 'zero' }],
    calc: (candles, indicator) => {
      const display = indicator.extendData as CvdDisplay | undefined
      return candles.map(({ timestamp }) => {
        const delta = display?.values?.get(timestamp)
        return delta === undefined ? {} : { delta, zero: display?.settings.showZero || display?.settings.plot === 'histogram' ? 0 : undefined }
      })
    },
    draw: drawCvd,
    createTooltipDataSource: ({ indicator, crosshair, defaultStyles }): IndicatorTooltipData => {
      const display = indicator.extendData as CvdDisplay | undefined
      const delta = indicator.result[crosshair.dataIndex ?? indicator.result.length - 1]?.delta
      const values: IndicatorTooltipData['values'] = []
      if (delta !== undefined) values.push({ title: '', value: formatFlowAmount(delta) })
      if (display?.message) values.push({ title: '', value: display.message })
      return { name: cvdTitle, calcParamsText: '', icons: defaultStyles.tooltip.icons.filter(icon => icon.id !== (indicator.visible ? 'visible' : 'invisible')),
        values }
    },
  })
}
