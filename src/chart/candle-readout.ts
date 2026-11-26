import { ActionType, type Chart, type Crosshair, type KLineData } from 'klinecharts'
import { formatDisplayTime } from '../format-display-time'

const percent = new Intl.NumberFormat('zh-CN', {
  style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2,
})
const signedPercent = new Intl.NumberFormat('zh-CN', {
  style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero',
})

export class CandleReadout {
  private readonly summary = document.createElement('div')
  private readonly details = document.createElement('div')
  private readonly latestTime = document.createElement('span')
  private readonly latestPrice = document.createElement('strong')
  private readonly selectedTime = document.createElement('strong')
  private readonly volumeLabel: HTMLElement
  private readonly values: HTMLElement[] = []
  private hoverDetailsVisible = true
  private selected?: KLineData
  private previous?: KLineData

  constructor(private readonly chart: Chart, pane: HTMLElement) {
    this.summary.className = 'candle-summary'
    this.summary.setAttribute('aria-label', '最新 K 线')
    this.summary.append(this.latestTime, this.latestPrice)
    this.details.className = 'candle-details'
    this.details.setAttribute('aria-label', '选中 K 线')
    const rows = document.createElement('dl')
    for (const label of ['开盘', '最高', '最低', '收盘', '成交量', '振幅', '涨跌']) {
      const title = document.createElement('dt')
      const value = document.createElement('dd')
      title.textContent = label
      rows.append(title, value)
      this.values.push(value)
    }
    this.volumeLabel = rows.querySelectorAll('dt')[4]
    this.details.append(this.selectedTime, rows)
    pane.append(this.summary, this.details)
    this.clearSelection()
    this.updateLatest()
    chart.subscribeAction(ActionType.OnDataReady, this.updateLatest)
    chart.subscribeAction(ActionType.OnCrosshairChange, this.updateSelection)
  }

  dispose(): void {
    this.chart.unsubscribeAction(ActionType.OnDataReady, this.updateLatest)
    this.chart.unsubscribeAction(ActionType.OnCrosshairChange, this.updateSelection)
    this.summary.remove()
    this.details.remove()
  }

  clearSelection(): void {
    this.details.hidden = true
    this.selected = undefined
    this.previous = undefined
  }

  setHoverDetailsVisible(visible: boolean): void {
    this.hoverDetailsVisible = visible
    if (!visible) this.clearSelection()
  }

  refresh(): void {
    this.updateLatest()
    if (this.selected) this.renderSelection(this.selected, this.previous)
  }

  private readonly updateLatest = (): void => {
    const candle = this.chart.getDataList().at(-1)
    this.summary.hidden = candle === undefined
    if (!candle) {
      this.clearSelection()
      return
    }
    this.latestTime.textContent = formatDisplayTime(candle.timestamp, this.chart.getTimezone())
    this.latestPrice.textContent = this.number(candle.close, this.chart.getPriceVolumePrecision().price)
  }

  private readonly updateSelection = (crosshair?: Crosshair): void => {
    if (!this.hoverDetailsVisible) return
    const index = crosshair?.dataIndex
    const candle = crosshair?.kLineData
    if (!crosshair?.paneId || index === undefined || index !== crosshair.realDataIndex || !candle) {
      this.clearSelection()
      return
    }
    const previous = this.chart.getDataList()[index - 1]
    if (candle !== this.selected || previous !== this.previous) {
      this.renderSelection(candle, previous)
      this.selected = candle
      this.previous = previous
    }
    const width = this.chart.getSize(crosshair.paneId)?.width ?? 0
    this.details.dataset.side = (crosshair.x ?? 0) < width / 2 ? 'right' : 'left'
    this.details.hidden = false
  }

  private renderSelection(candle: KLineData, previous?: KLineData): void {
    const { price, volume } = this.chart.getPriceVolumePrecision()
    this.volumeLabel.textContent = candle.volumeKind === 'quotes' ? '报价量' : '成交量'
    const base = previous?.close ?? 0
    const change = candle.close - base
    const values = [
      this.number(candle.open, price), this.number(candle.high, price),
      this.number(candle.low, price), this.number(candle.close, price),
      candle.volume === undefined ? '—' : this.number(candle.volume, volume),
      base > 0 ? percent.format((candle.high - candle.low) / base) : '—',
      base > 0 ? `${this.number(change, price, true)} (${signedPercent.format(change / base)})` : '—',
    ]
    this.selectedTime.textContent = formatDisplayTime(candle.timestamp, this.chart.getTimezone())
    values.forEach((value, index) => { this.values[index].textContent = value })
  }

  private number(value: number, digits: number, signed = false): string {
    return value.toLocaleString('zh-CN', {
      minimumFractionDigits: digits, maximumFractionDigits: digits,
      signDisplay: signed ? 'exceptZero' : 'auto',
    })
  }
}
