import {
  type Datafeed,
  KLineChartPro,
  type ChartPro,
  type ChartProOptions,
  type Period,
  type SymbolInfo,
} from '@klinecharts/pro'
import type {
  ActionType,
  Chart,
  Indicator,
  IndicatorCreate,
  LineType,
  OverlayCreate,
} from 'klinecharts'
import { TooltipShowRule } from 'klinecharts'
import type {
  ChartIndicatorPreferences,
  ChartIndicatorSetting,
  JsonValue,
} from './indicator-preferences'
import {
  alignOpenTime,
  nextOpenTime,
  shiftOpenTime,
} from '../market-data/intervals'
import { registerSupertrendIndicator } from './supertrend'
import { registerKeltnerIndicator } from './keltner'
import { registerTtmSqueezeIndicator } from './ttm-squeeze'
import { registerTtmWaveIndicators } from './ttm-wave'
import { registerPivotsIndicator } from './pivots-indicator'
import { readChartHistory } from '../market-data/indicator-history'

const DASHED_LINE = 'dashed' as LineType
const ON_DATA_READY = 'onDataReady' as ActionType
const ON_PANE_DRAG = 'onPaneDrag' as ActionType

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
  resize?(): void
  layoutSubPanes?(minimumHeight: number): number
  setPriceRangeAuto?(auto: boolean): void
  getPriceRangeAuto?(): boolean
  setIndicatorInfoVisible?(visible: boolean): void
  setTheme(theme: string): void
  setTimezone(timezone: string): void
  getIndicatorPreferences?(): ChartIndicatorPreferences
  applyIndicatorPreferences?(preferences: ChartIndicatorPreferences): void
  getRightmostVisibleCandleTime?(): number | null
  jumpToTime?(timestamp: number): Promise<number | null>
  setSimulationOverlays(state: SimulationOverlayState): void
}

export type ChartProFactory = (options: ChartProOptions) => ChartPro

interface ViewportRestore {
  timestamp: number
  symbol: string
  timeframe: string
  sequence: number
  started: boolean
}

const pivotHistoryReset = new WeakMap<ChartPro, () => void>()

const createProChart: ChartProFactory = (options) => {
  registerSupertrendIndicator()
  registerKeltnerIndicator()
  registerTtmSqueezeIndicator()
  registerTtmWaveIndicators()
  let chart: ChartPro | undefined
  const resetPivotHistory = registerPivotsIndicator(options.datafeed, () => {
    const replay = (options.datafeed as Datafeed & {
      getReplayContext?: () => { sessionId: string; currentTime: number; timeframe: string } | null
    }).getReplayContext?.()
    return {
      symbol: chart?.getSymbol() ?? options.symbol,
      period: chart?.getPeriod() ?? options.period,
      confirmedUntil: replay ? shiftOpenTime(replay.currentTime, replay.timeframe, 1) : Date.now(),
      sessionKey: replay?.sessionId ?? 'live',
    }
  })
  chart = new KLineChartPro(options)
  chart.getChart().setPaneOptions({
    id: 'candle_pane',
    gap: { top: 0.08, bottom: 0.08 },
  })
  pivotHistoryReset.set(chart, resetPivotHistory)
  return chart
}

export class ProChartAdapter implements ChartAdapterPort {
  private chart: ChartPro | null = null
  private coreChart: Chart | null = null
  private datafeed: Datafeed | null = null
  private reloadSequence = 0
  private viewportRestore: ViewportRestore | null = null
  private viewportAnchor: { timestamp: number; visibleTime: number } | null = null
  private cancelPosition: (() => void) | null = null
  private historyAbort = new AbortController()
  private readonly candleOwners = new WeakMap<object, string>()
  private tooltipElement: HTMLDivElement | null = null
  private readonly responsivePaneHeights = new Map<string, number>()
  private readonly responsiveDisplayHeights = new Map<string, number>()

  constructor(private readonly factory: ChartProFactory = createProChart) {}

  mount(options: ChartProOptions): void {
    if (this.chart !== null) {
      throw new Error('KLineChart Pro is already mounted.')
    }
    this.datafeed = options.datafeed
    // Preserve optional replay/indicator APIs and their original receiver.
    const datafeed = new Proxy(options.datafeed, {
      get: (target, property) => {
        if (property === 'getHistoryKLineData') return this.loadChartHistory.bind(this)
        if (property === 'subscribe') return this.subscribeChart.bind(this)
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    this.chart = this.factory({ ...options, datafeed })
    this.coreChart = this.chart.getChart()
    this.coreChart.subscribeAction?.(ON_PANE_DRAG, () => {
      // Only an explicit separator drag changes the archived height. Responsive
      // enlargement must not overwrite a user's desktop layout in their backup.
      for (const paneId of this.responsivePaneHeights.keys()) {
        const height = this.coreChart?.getSize(paneId)?.height
        const displayed = this.responsiveDisplayHeights.get(paneId)
        if (height !== undefined && height !== displayed) {
          this.responsivePaneHeights.set(paneId, height)
          this.responsiveDisplayHeights.set(paneId, height)
        }
      }
    })
  }

  setTheme(theme: string): void {
    this.requireChart().setTheme(theme)
  }

  resize(): void {
    this.coreChart?.resize()
  }

  layoutSubPanes(minimumHeight: number): number {
    if (minimumHeight === 0 && this.responsivePaneHeights.size === 0) return 0
    const chart = this.requireCoreChart()
    const panes = chart.getIndicatorByPaneId()
    if (!(panes instanceof Map)) return 0
    let totalHeight = 0
    for (const paneId of this.responsivePaneHeights.keys()) {
      if (!panes.has(paneId)) {
        this.responsivePaneHeights.delete(paneId)
        this.responsiveDisplayHeights.delete(paneId)
      }
    }
    for (const [paneId, indicators] of panes) {
      if (paneId === 'candle_pane' || !(indicators instanceof Map) || indicators.size === 0) continue
      const currentHeight = chart.getSize(paneId)?.height ?? 100
      if (minimumHeight > 0 && !this.responsivePaneHeights.has(paneId)) {
        this.responsivePaneHeights.set(paneId, currentHeight)
      }
      const savedHeight = this.responsivePaneHeights.get(paneId) ?? currentHeight
      const height = Math.max(savedHeight, minimumHeight)
      if (minimumHeight === 0) {
        this.responsivePaneHeights.delete(paneId)
        this.responsiveDisplayHeights.delete(paneId)
      } else {
        this.responsiveDisplayHeights.set(paneId, height)
      }
      if (Math.abs(currentHeight - height) > 1) chart.setPaneOptions({ id: paneId, height })
      totalHeight += height + 2
    }
    return totalHeight
  }

  setPriceRangeAuto(auto: boolean): void {
    this.requireCoreChart().setPriceRangeAuto(auto)
  }

  getPriceRangeAuto(): boolean {
    return this.requireCoreChart().getPriceRangeAuto()
  }

  setIndicatorInfoVisible(visible: boolean): void {
    this.requireCoreChart().setStyles({
      indicator: { tooltip: { showRule: visible ? TooltipShowRule.Always : TooltipShowRule.None } },
    })
  }

  setTimezone(timezone: string): void {
    this.requireChart().setTimezone(timezone)
  }

  setSymbol(symbol: SymbolInfo): void {
    this.cancelHistoryWork()
    this.reloadSequence += 1
    this.clearPosition()
    this.viewportAnchor = null
    this.requireChart().setSymbol(symbol)
  }

  setPeriod(period: Period): void {
    if (this.getPeriod().text === period.text) return
    const current = this.getRightmostVisibleCandleTime()
    const timestamp = this.viewportRestore?.timestamp ??
      (current === this.viewportAnchor?.visibleTime ? this.viewportAnchor.timestamp : current)
    const sequence = ++this.reloadSequence
    this.cancelHistoryWork()
    this.clearPosition()
    if (timestamp !== null) this.viewportRestore = {
      timestamp, sequence, symbol: this.getSymbol().ticker,
      timeframe: period.text, started: false,
    }
    this.requireChart().setPeriod(period)
  }

  private clearPosition(): void {
    this.cancelPosition?.()
    this.cancelPosition = null
    this.viewportRestore = null
  }

  private cancelHistoryWork(): void {
    this.historyAbort.abort()
    this.historyAbort = new AbortController()
  }

  private selectionKey(symbol: SymbolInfo, period: Period): string {
    return `${symbol.ticker.toUpperCase()}:${period.text}`
  }

  private ownLastCandle(candles: ReturnType<Chart['getDataList']>, symbol: SymbolInfo, period: Period): void {
    const last = candles.at(-1)
    if (last) this.candleOwners.set(last, this.selectionKey(symbol, period))
  }

  private subscribeChart(symbol: SymbolInfo, period: Period, callback: Parameters<Datafeed['subscribe']>[2]): void {
    this.datafeed!.subscribe(symbol, period, candle => {
      this.candleOwners.set(candle, this.selectionKey(symbol, period))
      callback(candle)
    })
  }

  private latestVisibleTime(): number {
    const context = (this.datafeed as Datafeed & {
      getReplayContext?: () => { currentTime: number; timeframe: string } | null
    } | null)?.getReplayContext?.()
    return context ? nextOpenTime(context.currentTime, context.timeframe) - 1 : Date.now()
  }

  private timeWindow(timestamp: number, period: Period): { target: number; from: number; to: number } {
    const latest = this.latestVisibleTime()
    const target = alignOpenTime(Math.min(timestamp, latest), period.text, 'floor')
    return {
      target,
      from: Math.max(0, alignOpenTime(target, '1M', 'floor'), shiftOpenTime(target, period.text, -249)),
      to: Math.min(shiftOpenTime(target, period.text, 249), nextOpenTime(alignOpenTime(target, '1M', 'floor'), '1M') - 1, latest),
    }
  }

  private async loadChartHistory(symbol: SymbolInfo, period: Period, from: number, to: number, notifySelection?: boolean) {
    const restore = this.viewportRestore
    const anchored = notifySelection !== false && restore !== null && !restore.started &&
      restore.symbol === symbol.ticker && restore.timeframe === period.text
    if (anchored) {
      restore.started = true
      const range = this.timeWindow(restore.timestamp, period)
      from = range.from
      to = range.to
    }
    const signal = notifySelection === false ? undefined : this.historyAbort.signal
    let candles: ReturnType<Chart['getDataList']>
    try {
      candles = await readChartHistory(this.datafeed!, symbol, period, from, to, notifySelection !== false, signal)
      signal?.throwIfAborted()
    } catch (error) {
      if (signal?.aborted) return []
      throw error
    }
    if (anchored && restore.sequence === this.reloadSequence) {
      this.positionWhenReady(candles, restore.timestamp, period, restore.sequence)
    }
    this.ownLastCandle(candles, symbol, period)
    return candles
  }

  private positionWhenReady(candles: ReturnType<Chart['getDataList']>, timestamp: number, period: Period, sequence: number): number | null {
    if (candles.length === 0) {
      this.clearPosition()
      return null
    }
    const target = this.timeWindow(timestamp, period).target
    const actual = candles.reduce((nearest, candle) => Math.abs(candle.timestamp - target) < Math.abs(nearest.timestamp - target) ? candle : nearest).timestamp
    const core = this.requireCoreChart()
    this.cancelPosition?.()
    const position = () => {
      if (sequence !== this.reloadSequence) { cleanup(); return }
      // Ignore unrelated indicator/live readiness while the replacement loads.
      if (!core.getDataList().includes(candles[0])) return
      cleanup()
      this.viewportRestore = null
      this.viewportAnchor = { timestamp: actual === target ? timestamp : actual, visibleTime: actual }
      core.scrollToTimestamp(actual, 0)
      core.scrollByDistance(core.getBarSpace(), 0)
    }
    const cleanup = () => {
      core.unsubscribeAction(ON_DATA_READY, position)
      if (this.cancelPosition === cleanup) this.cancelPosition = null
    }
    this.cancelPosition = cleanup
    core.subscribeAction(ON_DATA_READY, position)
    return actual
  }

  async reloadData(): Promise<void> {
    const chart = this.requireChart()
    const coreChart = this.coreChart
    const datafeed = this.datafeed
    if (coreChart === null || datafeed === null) return
    const sequence = ++this.reloadSequence
    this.cancelHistoryWork()
    const signal = this.historyAbort.signal
    this.clearPosition()
    chart.cancelHistoryRequests?.()
    pivotHistoryReset.get(chart)?.()
    const replay = (datafeed as Datafeed & { getReplayContext?: () => unknown }).getReplayContext?.()
    if (replay) coreChart.applyNewData([], false)
    let candles: ReturnType<Chart['getDataList']>
    try {
      candles = await readChartHistory(datafeed, chart.getSymbol(), chart.getPeriod(), Number.MIN_SAFE_INTEGER, Date.now(), true, signal)
    } catch (error) {
      if (signal.aborted) return
      throw error
    }
    if (sequence !== this.reloadSequence) return
    this.ownLastCandle(candles, chart.getSymbol(), chart.getPeriod())
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
    const data = chart.getDataList?.() ?? []
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
    const { from, to } = this.timeWindow(timestamp, period)
    const sequence = ++this.reloadSequence
    this.cancelHistoryWork()
    const signal = this.historyAbort.signal
    this.clearPosition()
    chart.cancelHistoryRequests?.()
    let candles: ReturnType<Chart['getDataList']>
    try {
      candles = await readChartHistory(datafeed, chart.getSymbol(), period, from, to, true, signal)
    } catch (error) {
      signal.throwIfAborted()
      throw error
    }
    signal.throwIfAborted()
    if (sequence !== this.reloadSequence || candles.length === 0) {
      return null
    }
    const replay = (datafeed as Datafeed & { getReplayContext?: () => unknown }).getReplayContext?.()
    const liveCandle = coreChart.getDataList().at(-1)
    // Minute history contains closed minutes. Keep the current websocket bar
    // when locating live data instead of replacing it with the previous close.
    if (!replay && liveCandle && this.candleOwners.get(liveCandle) === this.selectionKey(chart.getSymbol(), period) &&
        liveCandle.timestamp === alignOpenTime(Date.now(), period.text, 'floor') &&
        liveCandle.timestamp >= from && liveCandle.timestamp <= to) {
      const index = candles.findIndex(candle => candle.timestamp === liveCandle.timestamp)
      if (index >= 0) candles[index] = liveCandle
      else if (liveCandle.timestamp > candles.at(-1)!.timestamp) candles.push(liveCandle)
    }
    const actual = this.positionWhenReady(candles, timestamp, period, sequence)
    this.ownLastCandle(candles, chart.getSymbol(), period)
    pivotHistoryReset.get(chart)?.()
    coreChart.applyNewData(candles, true)
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
          : { height: this.responsivePaneHeights.get(paneId) ?? chart.getSize(paneId)!.height }),
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
