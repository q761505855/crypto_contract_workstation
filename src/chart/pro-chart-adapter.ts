import {
  type Datafeed,
  KLineChartPro,
  type ChartPro,
  type ChartProOptions,
  type Period,
  type SymbolInfo,
} from '@klinecharts/pro'
import type {
  Chart,
  Indicator,
  IndicatorCreate,
  LineType,
  OverlayCreate,
} from 'klinecharts'
import type {
  ChartIndicatorPreferences,
  ChartIndicatorSetting,
  JsonValue,
} from './indicator-preferences'
import {
  alignOpenTime,
  shiftOpenTime,
} from '../market-data/intervals'

const DASHED_LINE = 'dashed' as LineType

export interface SimulationTradeOverlay {
  id: string
  timestamp: number
  price: number
  label: string
  tooltip: string
  color: string
}

export interface SimulationOverlayState {
  currentTime: number | null
  entryPrice: number | null
  takeProfitPrice: number | null
  stopLossPrice: number | null
  liquidationPrice: number | null
  trades: SimulationTradeOverlay[]
  onEntryPriceDrag?: (price: number) => void
  onTakeProfitPriceDrag?: (price: number) => void
  onStopLossPriceDrag?: (price: number) => void
}

export interface ChartAdapterPort {
  mount(options: ChartProOptions): void
  getPeriod(): Period
  getSymbol(): SymbolInfo
  setPeriod(period: Period): void
  setSymbol(symbol: SymbolInfo): void
  reloadData(): Promise<void>
  setTheme(theme: string): void
  setTimezone(timezone: string): void
  getIndicatorPreferences?(): ChartIndicatorPreferences
  applyIndicatorPreferences?(preferences: ChartIndicatorPreferences): void
  getRightmostVisibleCandleTime?(): number | null
  jumpToTime?(timestamp: number): Promise<number | null>
  setSimulationOverlays(state: SimulationOverlayState): void
}

export type ChartProFactory = (options: ChartProOptions) => ChartPro

const createProChart: ChartProFactory = (options) => new KLineChartPro(options)

export class ProChartAdapter implements ChartAdapterPort {
  private chart: ChartPro | null = null
  private coreChart: Chart | null = null
  private datafeed: Datafeed | null = null
  private reloadSequence = 0
  private tooltipElement: HTMLDivElement | null = null

  constructor(private readonly factory: ChartProFactory = createProChart) {}

  mount(options: ChartProOptions): void {
    if (this.chart !== null) {
      throw new Error('KLineChart Pro is already mounted.')
    }
    this.chart = this.factory(options)
    this.coreChart = this.chart.getChart()
    this.datafeed = options.datafeed
  }

  setTheme(theme: string): void {
    this.requireChart().setTheme(theme)
  }

  setTimezone(timezone: string): void {
    this.requireChart().setTimezone(timezone)
  }

  setSymbol(symbol: SymbolInfo): void {
    this.reloadSequence += 1
    this.requireChart().setSymbol(symbol)
  }

  setPeriod(period: Period): void {
    this.reloadSequence += 1
    this.requireChart().setPeriod(period)
  }

  async reloadData(): Promise<void> {
    const chart = this.requireChart()
    const coreChart = this.coreChart
    const datafeed = this.datafeed
    if (coreChart === null || datafeed === null) return
    const sequence = ++this.reloadSequence
    const candles = await datafeed.getHistoryKLineData(
      chart.getSymbol(),
      chart.getPeriod(),
      Number.MIN_SAFE_INTEGER,
      Date.now(),
    )
    if (sequence !== this.reloadSequence) return
    coreChart.applyNewData(candles, candles.length > 0)
  }

  getSymbol(): SymbolInfo {
    return this.requireChart().getSymbol()
  }

  getPeriod(): Period {
    return this.requireChart().getPeriod()
  }

  getRightmostVisibleCandleTime(): number | null {
    const chart = this.requireCoreChart()
    const data = chart.getDataList()
    if (data.length === 0) return null
    const visible = chart.getVisibleRange()
    const index = Math.min(
      data.length - 1,
      Math.max(0, Math.ceil(visible.to) - 1),
    )
    return data[index]?.timestamp ?? data.at(-1)?.timestamp ?? null
  }

  async jumpToTime(timestamp: number): Promise<number | null> {
    if (!Number.isFinite(timestamp)) return null
    const chart = this.requireChart()
    const coreChart = this.requireCoreChart()
    const datafeed = this.datafeed
    if (datafeed === null) return null
    const period = chart.getPeriod()
    const latest = alignOpenTime(Date.now(), period.text, 'floor')
    const target = Math.min(
      alignOpenTime(timestamp, period.text, 'floor'),
      latest,
    )
    const from = shiftOpenTime(target, period.text, -249)
    const to = Math.min(
      shiftOpenTime(target, period.text, 250),
      Date.now(),
    )
    const sequence = ++this.reloadSequence
    const candles = await datafeed.getHistoryKLineData(
      chart.getSymbol(),
      period,
      from,
      to,
    )
    if (sequence !== this.reloadSequence || candles.length === 0) {
      return null
    }
    const actual = candles.reduce((nearest, candle) =>
      Math.abs(candle.timestamp - target) <
      Math.abs(nearest.timestamp - target)
        ? candle
        : nearest,
    ).timestamp
    coreChart.applyNewData(candles, true, () => {
      coreChart.scrollToTimestamp(actual, 0)
      // KLineCharts treats `visible.to` as an exclusive boundary and its
      // timestamp positioning leaves one bar visible after the target.
      coreChart.scrollByDistance(coreChart.getBarSpace(), 0)
    })
    return actual
  }

  getIndicatorPreferences(): ChartIndicatorPreferences {
    const chart = this.requireCoreChart()
    const panes = chart.getIndicatorByPaneId()
    if (!(panes instanceof Map)) {
      return { schemaVersion: 1, main: [], sub: [] }
    }
    const main = panes.get('candle_pane')
    const sub: ChartIndicatorPreferences['sub'] = []
    for (const [paneId, indicators] of panes.entries()) {
      if (
        paneId === 'candle_pane' ||
        !(indicators instanceof Map)
      ) {
        continue
      }
      sub.push({
        ...(chart.getSize(paneId)?.height === undefined
          ? {}
          : { height: chart.getSize(paneId)!.height }),
        indicators: [...indicators.values()].map((indicator) =>
          this.indicatorSetting(indicator),
        ),
      })
    }
    return {
      schemaVersion: 1,
      main:
        main instanceof Map
          ? [...main.values()].map((indicator) =>
              this.indicatorSetting(indicator),
            )
          : [],
      sub: sub.filter((pane) => pane.indicators.length > 0),
    }
  }

  applyIndicatorPreferences(
    preferences: ChartIndicatorPreferences,
  ): void {
    const chart = this.requireCoreChart()
    const panes = chart.getIndicatorByPaneId()
    if (!(panes instanceof Map)) return
    const apply = (
      setting: ChartIndicatorSetting,
      paneId: string,
    ): void => {
      chart.overrideIndicator(
        {
          name: setting.name,
          calcParams: structuredClone(setting.calcParams),
          visible: setting.visible,
          styles: structuredClone(setting.styles),
        } as IndicatorCreate,
        paneId,
      )
    }
    const main = panes.get('candle_pane')
    if (main instanceof Map) {
      for (const setting of preferences.main) {
        if (main.has(setting.name)) apply(setting, 'candle_pane')
      }
    }
    for (const pane of preferences.sub) {
      let heightApplied = false
      for (const setting of pane.indicators) {
        for (const [paneId, indicators] of panes) {
          if (
            paneId === 'candle_pane' ||
            !(indicators instanceof Map) ||
            !indicators.has(setting.name)
          ) {
            continue
          }
          apply(setting, paneId)
          if (!heightApplied && pane.height !== undefined) {
            chart.setPaneOptions({ id: paneId, height: pane.height })
            heightApplied = true
          }
          break
        }
      }
    }
  }

  setSimulationOverlays(state: SimulationOverlayState): void {
    const chart = this.coreChart
    if (chart === null) return
    chart.removeOverlay({ groupId: 'simulation' })
    const overlays: OverlayCreate[] = []
    const line = (
      id: string,
      value: number | null,
      color: string,
      onDrag?: (price: number) => void,
    ) => {
      if (value === null || state.currentTime === null) return
      overlays.push({
        id: `simulation-${id}`,
        groupId: 'simulation',
        name: 'priceLine',
        lock: onDrag === undefined,
        points: [{ timestamp: state.currentTime, value }],
        onPressedMoveEnd:
          onDrag === undefined
            ? undefined
            : (event) => {
                const price = event.overlay.points[0]?.value
                if (
                  typeof price === 'number' &&
                  Number.isFinite(price) &&
                  price > 0
                ) {
                  onDrag(price)
                }
                this.setSimulationOverlays(state)
                return true
              },
        styles: {
          line: { color, size: 1, style: DASHED_LINE },
          text: { color },
        },
      })
    }
    line(
      'entry',
      state.entryPrice,
      '#55b8ff',
      state.onEntryPriceDrag,
    )
    line(
      'take-profit',
      state.takeProfitPrice,
      '#4fd49f',
      state.onTakeProfitPriceDrag,
    )
    line(
      'stop-loss',
      state.stopLossPrice,
      '#ff7f79',
      state.onStopLossPriceDrag,
    )
    line('liquidation', state.liquidationPrice, '#f5a65b')

    if (state.currentTime !== null) {
      overlays.push({
        id: 'simulation-replay-time',
        groupId: 'simulation',
        name: 'verticalStraightLine',
        lock: true,
        points: [{ timestamp: state.currentTime }],
        styles: {
          line: {
            color: '#8290a3',
            size: 1,
            style: DASHED_LINE,
          },
        },
      })
    }

    for (const trade of state.trades) {
      overlays.push({
        id: `simulation-trade-${trade.id}`,
        groupId: 'simulation',
        name: 'simpleAnnotation',
        lock: true,
        points: [{ timestamp: trade.timestamp, value: trade.price }],
        extendData: trade.label,
        onMouseEnter: (event) => {
          this.showTradeTooltip(
            trade.tooltip,
            event.pageX ?? 0,
            event.pageY ?? 0,
          )
          return true
        },
        onMouseLeave: () => {
          this.hideTradeTooltip()
          return true
        },
        styles: {
          line: { color: trade.color, style: DASHED_LINE },
          text: { color: trade.color },
          polygon: { color: trade.color },
        },
      })
    }
    if (overlays.length > 0) {
      chart.createOverlay(overlays, 'candle_pane')
    }
  }

  private showTradeTooltip(
    content: string,
    pageX: number,
    pageY: number,
  ): void {
    if (this.tooltipElement === null) {
      const element = document.createElement('div')
      element.className = 'simulation-chart-tooltip'
      element.setAttribute('role', 'tooltip')
      document.body.append(element)
      this.tooltipElement = element
    }
    this.tooltipElement.textContent = content
    this.tooltipElement.style.left = `${pageX - window.scrollX + 12}px`
    this.tooltipElement.style.top = `${pageY - window.scrollY + 12}px`
    this.tooltipElement.hidden = false
  }

  private hideTradeTooltip(): void {
    if (this.tooltipElement !== null) {
      this.tooltipElement.hidden = true
    }
  }

  private requireChart(): ChartPro {
    if (this.chart === null) {
      throw new Error('KLineChart Pro is not mounted.')
    }
    return this.chart
  }

  private requireCoreChart(): Chart {
    if (this.coreChart === null) {
      throw new Error('KLineChart core is not mounted.')
    }
    return this.coreChart
  }

  private indicatorSetting(indicator: Indicator): ChartIndicatorSetting {
    return {
      name: indicator.name,
      calcParams: this.cloneJson(indicator.calcParams) as JsonValue[],
      visible: indicator.visible,
      styles: this.cloneJson(indicator.styles),
    }
  }

  private cloneJson(value: unknown): JsonValue {
    if (value === undefined) return null
    return JSON.parse(JSON.stringify(value)) as JsonValue
  }
}
