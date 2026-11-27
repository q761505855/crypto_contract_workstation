import { LineType, registerOverlay, utils, type OverlayCreateFiguresCallback, type OverlayFigure } from 'klinecharts'

export const RISK_REWARD_TOOLS = { long: 'riskRewardLong', short: 'riskRewardShort' } as const
export type RiskRewardSide = keyof typeof RISK_REWARD_TOOLS

export function riskRewardSide(name?: string): RiskRewardSide | undefined {
  if (name === RISK_REWARD_TOOLS.long) return 'long'
  if (name === RISK_REWARD_TOOLS.short) return 'short'
}

export function riskRewardMetrics(side: RiskRewardSide, points: readonly { value?: number }[]) {
  if (points.length !== 3) return
  const [entry, stop, target] = points.map(point => point.value)
  if (entry === undefined || stop === undefined || target === undefined) return
  const direction = side === 'long' ? 1 : -1
  const loss = (entry - stop) * direction
  const profit = (target - entry) * direction
  const ratio = profit / loss
  if (loss <= 0 || profit <= 0 || !Number.isFinite(loss) || !Number.isFinite(profit) || !Number.isFinite(ratio) || ratio === 0) return
  return { loss, profit, ratio }
}

const profitStyle = { color: '#60dfad', fill: 'rgba(38, 166, 128, 0.23)' }
const lossStyle = { color: '#ff8e8b', fill: 'rgba(229, 86, 90, 0.22)' }
const entryColor = '#b7c9e1'
const ratioFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

export const drawRiskReward: OverlayCreateFiguresCallback = ({ overlay, coordinates, bounding, precision, defaultStyles, barSpace }) => {
  const [entry, stop, target] = coordinates
  const [entryPrice, stopPrice, targetPrice] = overlay.points.map(point => point.value)
  const side = riskRewardSide(overlay.name)
  if (!entry || entryPrice === undefined || !side) return []

  const left = Math.min(...coordinates.map(point => point.x))
  const right = Math.max(left + Math.max(24, barSpace.bar), ...coordinates.map(point => point.x))
  if (right < 0 || left > bounding.width) return []
  const direction = side === 'long' ? 1 : -1
  const figures: OverlayFigure[] = []
  const line = (y: number): OverlayFigure => ({
    type: 'line', attrs: { coordinates: [{ x: left, y }, { x: right, y }] },
  })
  const label = (y: number, text: string, color: string, offset = 0) => {
    if (y < 0 || y > bounding.height) return
    const { family } = defaultStyles.text
    const width = utils.calcTextWidth(text, 11, 600, family) + 10
    const x = Math.max(2, Math.min(left + 4, bounding.width - width - 2))
    figures.push({ type: 'text', ignoreEvent: true,
      attrs: { x, y: Math.max(10, Math.min(y + offset, bounding.height - 10)), text, baseline: 'middle' },
      styles: { style: 'fill', color, backgroundColor: '#162335', size: 11, weight: 600, family,
        borderRadius: 3, paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 3 },
    })
  }
  const price = (value: number) => value.toFixed(precision.price)
  const percent = (change: number) => {
    const value = change / Math.abs(entryPrice) * 100
    return Number.isFinite(value) ? ` (${value > 0 ? '+' : ''}${value.toFixed(2)}%)` : ''
  }
  const zone = (y: number, style: typeof profitStyle) => {
    figures.push({ type: 'rect', attrs: { x: left, y: Math.min(y, entry.y), width: right - left, height: Math.abs(y - entry.y) },
      styles: { style: 'fill', color: style.fill } })
    const boundary = line(y)
    boundary.styles = { color: style.color }
    figures.push(boundary)
  }

  const loss = stopPrice === undefined ? 0 : (entryPrice - stopPrice) * direction
  const profit = targetPrice === undefined ? 0 : (targetPrice - entryPrice) * direction
  if (stop && loss > 0) zone(stop.y, lossStyle)
  if (target && profit > 0) zone(target.y, profitStyle)
  figures.push(line(entry.y))
  if (stop && stopPrice !== undefined && loss > 0) label(stop.y, `止损 ${price(stopPrice)}${percent(-loss)}`, lossStyle.color, 13 * direction)
  if (target && targetPrice !== undefined && profit > 0) label(target.y, `止盈 ${price(targetPrice)}${percent(profit)}`, profitStyle.color, -13 * direction)
  const metrics = riskRewardMetrics(side, overlay.points)
  const ratio = metrics ? ` · 盈亏比 ${metrics.ratio < 0.01 ? '<0.01' : ratioFormat.format(metrics.ratio)} : 1` : ''
  label(entry.y, `${side === 'long' ? '做多' : '做空'} ${price(entryPrice)}${ratio}`, entryColor)
  return figures
}

export function registerRiskRewardOverlays(): void {
  for (const name of Object.values(RISK_REWARD_TOOLS)) {
    registerOverlay({ name, totalStep: 4, needDefaultPointFigure: true,
      styles: { line: { color: entryColor, style: LineType.Solid, size: 1 } },
      createPointFigures: drawRiskReward,
    })
  }
}
