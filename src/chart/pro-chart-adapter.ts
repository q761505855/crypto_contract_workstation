import {
  type Datafeed,
  KLineChartPro,
  type ChartPro,
  type ChartProOptions,
  type Period,
  type SymbolInfo,
} from '@klinecharts/pro'
import { DomPosition, YAxisPosition, type KLineData } from 'klinecharts'
import type {
  ActionType,
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
  nextOpenTime,
  shiftOpenTime,
  usesNativeKlines,
} from '../market-data/intervals'
import { registerSupertrendIndicator } from './supertrend'
import { registerKeltnerIndicator } from './keltner'
import { registerTtmSqueezeIndicator } from './ttm-squeeze'
import { registerTtmWaveIndicators } from './ttm-wave'
import { registerPivotsIndicator } from './pivots-indicator'
import { registerMarketSessionsIndicator } from './market-sessions-indicator'
import { CombinedBybitSource } from '../market-data/bybit/combined-source'
import { bybitDay } from '../market-data/bybit/trades'
import type { GitHubContentsClient } from '../github-sync/github-client'
import { OrderFlowChart } from './order-flow-chart'
import { registerOrderFlow } from './order-flow-renderers'
import { MARKET_SESSIONS, isMarketSessionTimeframe, marketSessionForecast, marketSessionReference } from './market-session-times'
import { marketSessionStyles } from './market-session-styles'
import { readChartHistory } from '../market-data/indicator-history'
import { replayConfirmedUntil, replayVisibleUntil, type ReplayContext } from '../replay/models'
import { validateCandleType, type ChartCandleType } from './candle-preferences'
import {
  registerSimulationPriceLine, SIMULATION_BUY_COLOR, SIMULATION_SELL_COLOR,
  SIMULATION_PRICE_LINE, SIMULATION_TRADE_LABEL, type SimulationTradeLabel,
} from './simulation-price-line'
import { SimulationPriceLabels, type PriceLabel, type PriceLabelText } from './simulation-price-labels'
import { DrawingOverlays } from './drawing-overlays'
import type { DrawingStore } from './drawings'
import { CandleReadout } from './candle-readout'
import { formatDisplayTime } from '../format-display-time'

const DASHED_LINE = 'dashed' as LineType
const ON_DATA_READY = 'onDataReady' as ActionType
const ON_PANE_DRAG = 'onPaneDrag' as ActionType

export interface SimulationPositionOverlay {
  side: 'long' | 'short'
  entryPrice: number
  takeProfitPrice: number | null
  stopLossPrice: number | null
  liquidationPrice: number
  unrealizedPnl: string
  estimateRiskPnl: (price: number) => number
  previewEntryRisk?: (price: number) => 'take-profit' | 'stop-loss' | null
  onEntryPriceDrag?: (price: number) => void
  onTakeProfitPriceDrag?: (price: number) => void
  onStopLossPriceDrag?: (price: number) => void
}

export interface SimulationOverlayState {
  /** Latest revealed timestamp before alignment to each chart's period. */
  currentTime: number | null
  positions: readonly SimulationPositionOverlay[]
  trades: readonly SimulationTradeLabel[]
}

const formatPnl = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
})

export interface ChartAdapterPort {
  dispose?(): void
  mount(options: ChartProOptions & { orderFlowCloud?: GitHubContentsClient }): void
  startVolumeProfile?(): boolean
  getVisibleBybitDay?(): string
  downloadBybitDays?(start: string, end: string, report: (message: string) => void): Promise<string>
  getPeriod(): Period
  getSymbol(): SymbolInfo
  setPeriod(period: Period): void
  setSymbol(symbol: SymbolInfo): void
  reloadData(): Promise<void>
  resize?(): void
  refreshMarketSessionTimeline?(): void
  needsMorePaneSpace?(height: number): boolean
  layoutSubPanes?(minimumHeight: number, compactBudget?: number): number
  setCompactLayout?(compact: boolean): void
  getIndicatorPaneSizes?(): { id: string; label: string; height: number }[]
  setIndicatorPaneHeight?(paneId: string, height: number): void
  setPriceRangeAuto?(auto: boolean): void
  getPriceRangeAuto?(): boolean
  getPriceAxisContainer?(): HTMLElement | null
  setIndicatorInfoVisible?(visible: boolean): void
  setTheme(theme: string): void
  setTimezone(timezone: string): void
  getCandleType?(): ChartCandleType
  getIndicatorPreferences?(): ChartIndicatorPreferences
  applyIndicatorPreferences?(preferences: ChartIndicatorPreferences): void
  getRightmostVisibleCandleTime?(): number | null
  jumpToTime?(timestamp: number, followLatest?: boolean): Promise<number | null>
  stepViewport?(direction: -1 | 1): number | null
  setSimulationOverlays(state: SimulationOverlayState): void
  setDrawingScope?(store: DrawingStore, scope: string | null): void
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
  registerSimulationPriceLine()
  registerSupertrendIndicator()
  registerKeltnerIndicator()
  registerTtmSqueezeIndicator()
  registerTtmWaveIndicators()
  registerOrderFlow()
  let chart: ChartPro | undefined
  const indicatorContext = () => {
    const replay = (options.datafeed as Datafeed & {
      getReplayContext?: () => ReplayContext | null
    }).getReplayContext?.()
    return {
      symbol: chart?.getSymbol() ?? options.symbol,
      period: chart?.getPeriod() ?? options.period,
      confirmedUntil: replay ? replayConfirmedUntil(replay) : Date.now(),
      sessionKey: replay?.sessionId ?? 'live',
    }
  }
  const resetPivotHistory = registerPivotsIndicator(options.datafeed, indicatorContext)
  registerMarketSessionsIndicator(() => {
    const { period, confirmedUntil } = indicatorContext()
    return { timeframe: period.text, confirmedUntil }
  })
  chart = new KLineChartPro({ watermark: '', ...options })
  chart.getChart().setXAxisAfterCandle()
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
  private priceLabels?: SimulationPriceLabels
  private candleReadout?: CandleReadout
  private drawings?: DrawingOverlays
  private orderFlow?: OrderFlowChart
  private source?: CombinedBybitSource
  private stopCursor?: () => void
  private tradeMarkerGap = 0.08
  private readonly responsivePaneHeights = new Map<string, number>()
  private readonly responsiveDisplayHeights = new Map<string, number>()
  private subPaneMinimumHeight = 0
  private subPaneBudget: number | undefined
  private compactLayout: boolean | undefined

  constructor(private readonly factory: ChartProFactory = createProChart) {}

  dispose(): void {
    this.candleReadout?.dispose()
    this.candleReadout = undefined
    this.drawings?.dispose()
    this.drawings = undefined
    this.orderFlow?.dispose()
    this.orderFlow = undefined
    this.source?.release()
    this.source = undefined
    this.stopCursor?.()
    this.stopCursor = undefined
    this.cancelHistoryWork()
    this.clearPosition()
    this.priceLabels?.dispose()
    this.priceLabels = undefined
    this.tradeMarkerGap = 0.08
    this.chart?.dispose?.()
    this.chart = null
    this.coreChart = null
    this.datafeed = null
  }

  mount({ orderFlowCloud, ...options }: ChartProOptions & { orderFlowCloud?: GitHubContentsClient }): void {
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
        if ((property === 'getOlderHistory' || property === 'getNewerHistory') && typeof value === 'function') {
          return async (symbol: SymbolInfo, period: Period, edge: number) => {
            const page = await value.call(target, symbol, period, edge, this.historyAbort.signal)
            if (page) this.ownLastCandle(page.candles, symbol, period)
            return page
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const combinedOptions = { ...options, datafeed, orderFlowEnabled: !!orderFlowCloud }
    this.chart = this.factory(combinedOptions)
    this.coreChart = this.chart.getChart()
    if (orderFlowCloud) {
      const feed = options.datafeed as Datafeed & {
        getReplayContext?(): ReplayContext | null
        subscribeReplayCursor?(listener: (context: ReplayContext | null) => void): () => void
      }
      this.source = new CombinedBybitSource(orderFlowCloud, (reset, affected) => this.orderFlow?.refresh(reset, affected))
      this.orderFlow = new OrderFlowChart(this.coreChart, this.source, () => this.getPeriod().text, () => this.hasCurrentCandles())
      this.source.select(options.symbol, feed.getReplayContext?.() ?? null)
      this.stopCursor = feed.subscribeReplayCursor?.(context => this.source?.select(this.getSymbol(), context))
    }
    // Allow a time jump to place even the first available candle at the right edge.
    this.coreChart.setRightMinVisibleBarCount?.(0)
    this.coreChart.setCustomApi?.({
      formatDate: (formatter, timestamp) => formatDisplayTime(timestamp, formatter.resolvedOptions().timeZone),
    })
    const candlePane = this.coreChart.getDom?.('candle_pane', DomPosition.Main)
    if (candlePane) this.candleReadout = new CandleReadout(this.coreChart, candlePane)
    if (typeof this.coreChart.setFutureTimeAxis === 'function') {
      this.coreChart.subscribeAction?.(ON_DATA_READY, () => this.refreshMarketSessionTimeline())
    }
    this.coreChart.subscribeAction?.(ON_PANE_DRAG, () => {
      // Only an explicit separator drag changes the archived height. Responsive
      // enlargement must not overwrite a user's desktop layout in their backup.
      let changed = false
      for (const paneId of this.responsivePaneHeights.keys()) {
        const height = this.coreChart?.getSize(paneId)?.height
        const displayed = this.responsiveDisplayHeights.get(paneId)
        if (height !== undefined && Number.isFinite(height) && height !== displayed) {
          // The core permits zero-height drags while responsive minHeight is
          // zero. Archive only the same integer range supported by sliders.
          this.responsivePaneHeights.set(paneId, Math.max(60, Math.min(600, Math.round(height))))
          changed = true
        }
      }
      if (changed) this.layoutSubPanes(this.subPaneMinimumHeight, this.subPaneBudget)
    })
  }

  setTheme(theme: string): void {
    this.requireChart().setTheme(theme)
  }

  setDrawingScope(store: DrawingStore, scope: string | null): void {
    if (!this.coreChart) return
    this.drawings ??= new DrawingOverlays(this.coreChart, store, () => this.getPeriod().text, this.orderFlow)
    this.drawings.setScope(scope)
  }

  startVolumeProfile(): boolean {
    return this.drawings?.startVolumeProfile() ?? false
  }

  getVisibleBybitDay(): string {
    if (!this.source?.mapping) throw new Error('当前品种暂无成交量')
    if (!this.hasCurrentCandles()) throw new Error('当前图表暂无可见 K 线')
    const { from, to } = this.requireCoreChart().getVisibleRange()
    const timestamp = this.getRightmostVisibleCandleTime()
    if (to <= from || timestamp === null) throw new Error('当前图表暂无可见 K 线')
    return bybitDay(timestamp)
  }

  downloadBybitDays(start: string, end: string, report: (message: string) => void): Promise<string> {
    if (!this.source) throw new Error('当前品种暂无成交量')
    return this.source.downloadDays(start, end, report)
  }

  private hasCurrentCandles(): boolean {
    const last = this.requireCoreChart().getDataList().at(-1)
    return !!last && this.candleOwners.get(last) === this.selectionKey(this.getSymbol(), this.getPeriod())
  }

  resize(): void {
    this.coreChart?.resize()
  }

  refreshMarketSessionTimeline(): void {
    const chart = this.coreChart
    if (!chart?.setFutureTimeAxis) return
    const indicator = chart.getIndicatorByPaneId?.('candle_pane', MARKET_SESSIONS) as Indicator | null
    const { sessionVisibility } = marketSessionStyles(indicator?.styles)
    const timeframe = this.getPeriod().text
    const last = chart.getDataList().at(-1)
    if (!indicator?.visible || !sessionVisibility.some(Boolean) || !isMarketSessionTimeframe(timeframe) || !last) {
      chart.setFutureTimeAxis(0, 0)
      return
    }
    const replayEnd = this.replayHistoryEnd()
    const reference = marketSessionReference(last.timestamp, replayEnd === undefined ? Date.now() : replayEnd + 1, timeframe)
    chart.setFutureTimeAxis(nextOpenTime(last.timestamp, timeframe) - last.timestamp, marketSessionForecast(reference, sessionVisibility).end)
  }

  needsMorePaneSpace(height: number): boolean {
    const panes = this.getIndicatorPaneSizes()
    const available = this.availablePaneHeight(height, panes.length)
    const desired = panes.reduce((sum, pane) => sum + pane.height, 0)
    return desired > available
  }

  private availablePaneHeight(chartHeight: number, paneCount: number): number {
    const axisHeight = this.requireCoreChart().getSize('x_axis_pane')?.height ?? 30
    return Math.max(0, chartHeight - axisHeight - 180 - paneCount * 2)
  }

  layoutSubPanes(minimumHeight: number, compactBudget?: number): number {
    this.subPaneMinimumHeight = minimumHeight
    this.subPaneBudget = compactBudget
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
    const subPanes: { id: string; current: number; desired: number }[] = []
    for (const [paneId, indicators] of panes) {
      if (paneId === 'candle_pane' || !(indicators instanceof Map) || indicators.size === 0) continue
      const currentHeight = chart.getSize(paneId)?.height ?? 100
      // Keep desired sizes even on desktop: the core chart clips later panes
      // when their combined height exceeds the fixed chart viewport.
      const savedHeight = this.responsivePaneHeights.get(paneId) ?? (currentHeight || 100)
      this.responsivePaneHeights.set(paneId, savedHeight)
      subPanes.push({ id: paneId, current: currentHeight, desired: Math.max(savedHeight, minimumHeight) })
    }
    const viewportHeight = chart.getSize()?.height ?? 0
    const desiredTotal = subPanes.reduce((sum, pane) => sum + pane.desired, 0)
    const available = viewportHeight > 0 ? this.availablePaneHeight(viewportHeight, subPanes.length) : desiredTotal
    // In automatic mode, keep the indicator panes compact on small screens.
    const budget = compactBudget === undefined ? available : Math.min(available, compactBudget)
    const scale = desiredTotal > budget ? budget / desiredTotal : 1
    for (const pane of subPanes) {
      // A zero minHeight lets constrained displays preserve the candle pane;
      // sliders and archives still hold the user's full desired height.
      const height = Math.max(1, Math.floor(pane.desired * scale))
      if (pane.current !== height) chart.setPaneOptions({ id: pane.id, height, minHeight: 0 })
      this.responsiveDisplayHeights.set(pane.id, height)
      totalHeight += height + 2
    }
    return totalHeight
  }

  getIndicatorPaneSizes(): { id: string; label: string; height: number }[] {
    const chart = this.requireCoreChart()
    const panes = chart.getIndicatorByPaneId()
    if (!(panes instanceof Map)) return []
    return [...panes].flatMap(([id, indicators]) => {
      if (id === 'candle_pane' || !(indicators instanceof Map) || indicators.size === 0) return []
      return [{
        id,
        label: [...indicators.values()].map((indicator: Indicator) => indicator.name).join(' / '),
        height: this.responsivePaneHeights.get(id) ?? chart.getSize(id)?.height ?? 100,
      }]
    })
  }

  setIndicatorPaneHeight(paneId: string, height: number): void {
    if (!Number.isInteger(height) || height < 60 || height > 600) {
      throw new Error('Indicator pane height must be an integer between 60 and 600.')
    }
    if (!this.getIndicatorPaneSizes().some(({ id }) => id === paneId)) return
    this.responsivePaneHeights.set(paneId, height)
    this.responsiveDisplayHeights.set(paneId, height)
    this.requireCoreChart().setPaneOptions({ id: paneId, height })
  }

  setCompactLayout(compact: boolean): void {
    if (this.compactLayout === compact) return
    this.compactLayout = compact
    this.requireCoreChart().setStyles({
      yAxis: { inside: compact, position: YAxisPosition.Right, size: compact ? 64 : 'auto', tickText: { size: compact ? 10 : 12, marginStart: compact ? 3 : 4, marginEnd: compact ? 3 : 4 } },
      xAxis: { tickText: { size: compact ? 10 : 12 } },
      candle: {
        touchVerticalDrag: compact,
        tooltip: { offsetLeft: compact ? 4 : 24, text: { size: compact ? 10 : 12, marginLeft: compact ? 0 : 8, marginRight: compact ? 6 : 8, marginTop: compact ? 2 : 4, marginBottom: compact ? 2 : 4 } },
        priceMark: { last: { text: { size: compact ? 10 : 12, paddingLeft: compact ? 3 : 4, paddingRight: compact ? 3 : 4 } } },
      },
      indicator: { tooltip: { offsetLeft: compact ? 4 : 24, text: { size: compact ? 10 : 12, marginLeft: compact ? 0 : 8, marginRight: compact ? 6 : 8, marginTop: compact ? 2 : 4, marginBottom: compact ? 2 : 4 } } },
      crosshair: { horizontal: { text: { size: compact ? 10 : 12, paddingLeft: compact ? 3 : 4, paddingRight: compact ? 3 : 4 } } },
    })
  }

  getPriceAxisContainer(): HTMLElement | null {
    return this.requireCoreChart().getDom('candle_pane', DomPosition.YAxis)
  }

  setPriceRangeAuto(auto: boolean): void {
    this.requireCoreChart().setPriceRangeAuto(auto)
  }

  getPriceRangeAuto(): boolean {
    return this.requireCoreChart().getPriceRangeAuto()
  }

  setIndicatorInfoVisible(visible: boolean): void {
    this.requireCoreChart().setStyles({
      candle: { tooltip: { showIndicator: visible } },
    })
  }

  setTimezone(timezone: string): void {
    this.requireChart().setTimezone(timezone)
    this.candleReadout?.refresh()
  }

  getCandleType(): ChartCandleType {
    return validateCandleType(this.requireCoreChart().getStyles().candle.type)
  }

  setSymbol(symbol: SymbolInfo): void {
    this.candleReadout?.clearSelection()
    this.cancelHistoryWork()
    this.reloadSequence += 1
    this.clearPosition()
    this.viewportAnchor = null
    this.requireChart().setSymbol(symbol)
    const feed = this.datafeed as (Datafeed & { getReplayContext?(): ReplayContext | null }) | null
    this.source?.select(symbol, feed?.getReplayContext?.() ?? null)
  }

  setPeriod(period: Period): void {
    if (this.getPeriod().text === period.text) return
    this.candleReadout?.clearSelection()
    const current = this.getRightmostVisibleCandleTime()
    const anchor = this.viewportAnchor
    const followingLive = current !== null && anchor === null && this.hasLiveTail() &&
      current === this.requireCoreChart().getDataList().at(-1)?.timestamp
    const timestamp = this.viewportRestore?.timestamp ??
      (anchor !== null && current === anchor.visibleTime ? anchor.timestamp : followingLive ? null : current)
    const sequence = ++this.reloadSequence
    this.cancelHistoryWork()
    this.clearPosition()
    if (timestamp !== null) this.viewportRestore = {
      timestamp, sequence, symbol: this.getSymbol().ticker,
      timeframe: period.text, started: false,
    }
    this.requireChart().setPeriod(period)
    this.setPriceRangeAuto(true)
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

  private replayHistoryEnd(): number | undefined {
    const context = (this.datafeed as Datafeed & {
      getReplayContext?: () => ReplayContext | null
    } | null)?.getReplayContext?.()
    return context ? replayVisibleUntil(context) - 1 : undefined
  }

  private hasLiveTail(): boolean {
    const feed = this.datafeed as (Datafeed & {
      hasLiveTail?: (symbol: SymbolInfo, period: Period) => boolean
    }) | null
    return feed?.hasLiveTail?.(this.getSymbol(), this.getPeriod()) ?? false
  }

  private timeWindow(timestamp: number, period: Period, includeAdjacentMonths = false): { target: number; from: number; to: number } {
    const replayEnd = this.replayHistoryEnd()
    const latest = replayEnd ?? Date.now()
    const target = alignOpenTime(Math.min(timestamp, latest), period.text, 'floor')
    const chartStart = shiftOpenTime(target, period.text, -249)
    const chartEnd = shiftOpenTime(target, period.text, 249)
    if (replayEnd === undefined && includeAdjacentMonths) {
      return { target, from: Math.max(0, chartStart), to: Math.min(chartEnd, latest) }
    }
    const monthStart = alignOpenTime(target, '1M', 'floor')
    return {
      target,
      from: Math.max(0, chartStart, replayEnd !== undefined && usesNativeKlines(period.text) ? 0 : monthStart),
      to: Math.min(chartEnd, nextOpenTime(monthStart, '1M') - 1, latest),
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

  private positionWhenReady(candles: ReturnType<Chart['getDataList']>, timestamp: number, period: Period, sequence: number, followLatest = false): number | null {
    if (candles.length === 0) {
      this.clearPosition()
      return null
    }
    const target = this.timeWindow(timestamp, period).target
    const nearest = candles.reduce((closest, candle) => Math.abs(candle.timestamp - target) < Math.abs(closest.timestamp - target) ? candle : closest)
    const actual = nearest.timestamp
    const core = this.requireCoreChart()
    this.cancelPosition?.()
    const position = () => {
      if (sequence !== this.reloadSequence) { cleanup(); return }
      // Ignore unrelated indicator/live readiness while the replacement loads.
      if (!core.getDataList().includes(candles[0])) return
      cleanup()
      this.viewportRestore = null
      if (followLatest && this.replayHistoryEnd() === undefined) {
        this.viewportAnchor = null
        core.scrollToRealTime(0)
        return
      }
      core.scrollToTimestamp(actual, 0)
      core.scrollByDistance(core.getBarSpace(), 0)
      this.viewportAnchor = {
        timestamp: actual === target ? timestamp : actual,
        visibleTime: actual,
      }
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
    this.viewportAnchor = null
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

  stepViewport(direction: -1 | 1): number | null {
    const chart = this.requireCoreChart()
    const count = chart.getDataList().length
    if (this.replayHistoryEnd() !== undefined || count === 0) return null
    this.viewportAnchor = null
    const { to, realTo } = chart.getVisibleRange()
    const barSpace = chart.getBarSpace()
    const liveTail = this.hasLiveTail()
    if (direction === 1 && to === count) {
      if (!liveTail) {
        // Trigger forward paging at a distant time jump without advancing into the empty margin.
        if (realTo > to) chart.scrollByDistance((realTo - to) * barSpace, 0)
        chart.scrollByDistance(-barSpace, 0)
        chart.scrollByDistance(barSpace, 0)
      }
    } else {
      // Skip any empty margin or future session markers when stepping backwards.
      const bars = direction === -1 ? 1 + Math.max(0, realTo - to) : -1
      chart.scrollByDistance(bars * barSpace, 0)
    }
    if (direction === 1 && liveTail && chart.getVisibleRange().realTo === count) {
      // Restore the live margin once so later WebSocket bars extend the visible chart.
      chart.scrollToRealTime(0)
    }
    return this.getRightmostVisibleCandleTime()
  }

  async jumpToTime(timestamp: number, followLatest = false): Promise<number | null> {
    if (!Number.isFinite(timestamp)) return null
    const chart = this.requireChart()
    const coreChart = this.requireCoreChart()
    const datafeed = this.datafeed
    if (datafeed === null) return null
    const period = chart.getPeriod()
    const { from, to } = this.timeWindow(timestamp, period, true)
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
    const actual = this.positionWhenReady(candles, timestamp, period, sequence, followLatest)
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
            this.responsivePaneHeights.set(paneId, pane.height)
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
    this.priceLabels?.clear()
    if (state.positions.length > 0 && !this.priceLabels) {
      const pane = chart.getDom?.('candle_pane', DomPosition.Main)
      if (pane) this.priceLabels = new SimulationPriceLabels(chart, pane)
    }
    const overlays: OverlayCreate[] = []
    const timeframe = this.getPeriod().text
    const counts = new Map<number, number>()
    let maxTradesPerBar = 0
    for (const trade of state.trades) {
      const open = alignOpenTime(trade.timestamp, timeframe, 'floor')
      const count = (counts.get(open) ?? 0) + 1
      counts.set(open, count)
      maxTradesPerBar = Math.max(maxTradesPerBar, count)
    }
    const topGap = maxTradesPerBar === 0 ? 0.08 : Math.min(0.9, 0.24 + 0.15 * maxTradesPerBar)
    if (this.tradeMarkerGap !== topGap) {
      this.tradeMarkerGap = topGap
      chart.setPaneOptions({ id: 'candle_pane', gap: { top: topGap, bottom: 0.08 } })
    }
    const line = (label: PriceLabel) => {
      if (!Number.isFinite(label.price)) return
      overlays.push({
        id: label.id,
        groupId: 'simulation',
        name: SIMULATION_PRICE_LINE,
        extendData: this.priceLabels?.add(label) ?? { color: label.color, active: false },
        lock: true,
        points: [{ value: label.price }],
      })
    }

    if (state.currentTime !== null) {
      for (const position of state.positions) {
        const name = position.side === 'long' ? '多仓' : '空仓'
        const id = `simulation-${position.side}`
        const riskText = (target: 'take-profit' | 'stop-loss', price: number): PriceLabelText => {
          const pnl = position.estimateRiskPnl(price)
          return {
            name: `${name}${target === 'take-profit' ? '止盈' : '止损'}`,
            pnl: formatPnl.format(pnl),
            color: pnl >= 0 ? SIMULATION_BUY_COLOR : SIMULATION_SELL_COLOR,
          }
        }
        const entryText = {
          name, pnl: formatPnl.format(Number(position.unrealizedPnl)),
          color: position.side === 'long' ? SIMULATION_BUY_COLOR : SIMULATION_SELL_COLOR,
        }
        line({
          ...entryText, id: `${id}-entry`, side: 'left', price: position.entryPrice,
          preview: price => {
            const target = position.previewEntryRisk?.(price)
            return target ? riskText(target, price) : entryText
          },
          commit: position.onEntryPriceDrag,
        })
        for (const [target, price, commit] of [
          ['take-profit', position.takeProfitPrice, position.onTakeProfitPriceDrag],
          ['stop-loss', position.stopLossPrice, position.onStopLossPriceDrag],
        ] as const) {
          if (price === null) continue
          line({
            ...riskText(target, price), id: `${id}-${target}`, side: 'right', price, commit,
            preview: value => riskText(target, value),
          })
        }
        if (position.liquidationPrice > 0) {
          line({ id: `${id}-liquidation`, side: 'left', price: position.liquidationPrice, name: `${name}预估强平价`, color: '#f5a65b' })
        }
      }
      overlays.push({
        id: 'simulation-replay-time',
        groupId: 'simulation',
        name: 'verticalStraightLine',
        lock: true,
        points: [{ timestamp: alignOpenTime(state.currentTime, timeframe, 'floor') }],
        styles: {
          line: {
            color: '#8290a3',
            size: 1,
            style: DASHED_LINE,
          },
        },
      })
    }

    if (state.trades.length > 0) {
      const trades = [...state.trades].sort((first, second) => first.timestamp - second.timestamp)
      const displayCandle = (index: number, candle: KLineData): KLineData => {
        if (chart.getStyles().candle.type !== 'heikin_ashi') return candle
        // The patched renderer caches the same Heikin Ashi series used by the axis.
        const core = chart as Chart & { getChartStore(): { getHeikinAshiData(index: number): KLineData } }
        return core.getChartStore().getHeikinAshiData(index)
      }
      overlays.push({
        id: 'simulation-trade-markers',
        groupId: 'simulation',
        name: SIMULATION_TRADE_LABEL,
        lock: true,
        points: [{ dataIndex: 0 }],
        extendData: { chart, trades, displayCandle, timeframe },
      })
    }
    if (overlays.length > 0) {
      chart.createOverlay(overlays, 'candle_pane')
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
