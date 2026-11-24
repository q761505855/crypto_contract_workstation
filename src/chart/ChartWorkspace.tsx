import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import type { Datafeed, Period, SymbolInfo } from '@klinecharts/pro'
import {
  createChartOptions,
  DEFAULT_CTRADER_SYMBOL,
  DEFAULT_CTRADER_PERIOD,
  CTRADER_PERIODS,
} from './chart-config'
import { DemoDatafeed } from './demo-datafeed'
import {
  loadChartIndicatorPreferences,
  saveChartIndicatorPreferences,
  type ChartIndicatorPreferences,
} from './indicator-preferences'
import type { GitHubContentsClient } from '../github-sync/github-client'
import type { TradeDownloadChoice, TradeDownloadDay } from '../market-data/bybit/combined-source'
import { BYBIT_DAY_MS, bybitDay, bybitDayStart } from '../market-data/bybit/trades'
import { orderFlowLabel, orderFlowMapping } from '../market-data/okx/trades'
import {
  ProChartAdapter,
  type ChartAdapterPort,
  type SimulationOverlayState,
} from './pro-chart-adapter'
import { SymbolPicker } from './SymbolPicker'
import { PeriodSelector } from './PeriodSelector'
import { saveCandleType } from './candle-preferences'
import type { DrawingStore } from './drawings'
import type { DrawingSelection } from './drawing-overlays'
import { DrawingSelectionToolbar } from './DrawingSelectionToolbar'
import { WorkspaceDialog } from '../components/WorkspaceDialog'
import { OrderFlowSettingsDialog } from './OrderFlowSettingsDialog'
import { bubblePreferenceDefaults, type OrderFlowGroup } from './order-flow-preferences'
import { BIG_TRADES } from './order-flow'
import { PREFERENCES_RESTORED } from '../storage/preference-events'
import './chart-size-controls.css'

export interface ChartWorkspaceProps {
  createAdapter?: () => ChartAdapterPort
  datafeed?: Datafeed
  symbol?: SymbolInfo
  symbolLocked?: boolean
  period?: Period
  reloadKey?: number
  onSelectionChange?: (selection: {
    symbol: SymbolInfo
    period: Period
  }, userSelectedSymbol?: boolean) => void
  simulationOverlays?: SimulationOverlayState
  showTradeOverlays?: boolean
  jumpRequest?: {
    id: string
    timestamp: number
    followLatest: boolean
  } | null
  onJumpComplete?: (timestamp: number | null) => void
  onReplayStartTimeChange?: (timestamp: number | null) => void
  viewportRef?: Ref<{ step(direction: -1 | 1): number | null }>
  layoutSettingsOpen?: boolean
  onCloseLayoutSettings?: () => void
  chartHeight?: number | null
  onChartHeightChange?: (height: number | null) => void
  auxiliary?: boolean
  drawingStore?: DrawingStore
  drawingScope?: string | null
  orderFlowCloud?: GitHubContentsClient
  getOrderFlowLotSize?: (ticker: string) => number | undefined
}

const demoDatafeed = new DemoDatafeed()

interface DayDownloadSelection {
  anchor: string
  before: string
  after: string
  error?: string
}

interface DayDownloadReview {
  days: readonly TradeDownloadDay[]
  choose(choice: TradeDownloadChoice): void
}

const tradeDownloadStatus: Record<TradeDownloadDay['status'], string> = {
  unarchived: '平台未归档',
  uncached: 'Git 未缓存',
  cached: 'Git 已缓存',
  loaded: '已加载',
  error: '检查失败',
}

function tradeDownloadDetail(day: TradeDownloadDay, today: string): string | undefined {
  switch (day.status) {
    case 'loaded':
      return day.through === undefined ? day.source : `${day.source} · 已加载至 ${new Date(day.through).toISOString().slice(11, 19)} UTC`
    case 'cached':
      return day.source
    case 'uncached':
      return day.canCache ? 'OKX 日档可下载' : '需要可写的云端缓存连接'
    case 'unarchived': {
      const history = day.canUseHistory ? '可用 OKX 接口补齐' : day.day < today ? '超出 OKX 接口覆盖范围' : '当前暂无可读取的成交'
      return day.bybitFallback ? `${history} · 可尝试 Bybit 日档` : history
    }
    case 'error':
      return day.message
  }
}

function resolveDayDownloadRange({ anchor, before, after }: DayDownloadSelection, today: string) {
  let anchorMs: number
  try { anchorMs = bybitDayStart(anchor) }
  catch { return { error: '请选择有效的锚点日期' } }
  if (anchor > today) return { error: '锚点日期不能晚于当前 UTC 日期' }
  const beforeDays = Number(before)
  const afterDays = Number(after)
  if (!before || !after || ![beforeDays, afterDays].every(days => Number.isSafeInteger(days) && days >= 0)) {
    return { error: '往前和往后天数须为大于或等于 0 的整数' }
  }
  const start = anchorMs - beforeDays * BYBIT_DAY_MS
  if (start < bybitDayStart('0000-01-01')) return { error: '往前天数超出可用日期范围' }
  const todayMs = bybitDayStart(today)
  const daysAvailableAfterAnchor = (todayMs - anchorMs) / BYBIT_DAY_MS
  const clipped = afterDays > daysAvailableAfterAnchor
  const end = clipped ? todayMs : anchorMs + afterDays * BYBIT_DAY_MS
  return { start: bybitDay(start), end: bybitDay(end), clipped }
}

export function ChartWorkspace({
  createAdapter = () => new ProChartAdapter(),
  datafeed = demoDatafeed,
  symbol = DEFAULT_CTRADER_SYMBOL,
  symbolLocked = false,
  period = DEFAULT_CTRADER_PERIOD,
  reloadKey = 0,
  onSelectionChange,
  simulationOverlays,
  showTradeOverlays = true,
  jumpRequest = null,
  onJumpComplete,
  onReplayStartTimeChange,
  viewportRef,
  layoutSettingsOpen = false,
  onCloseLayoutSettings,
  chartHeight = null,
  onChartHeightChange,
  auxiliary = false,
  drawingStore,
  drawingScope = null,
  orderFlowCloud,
  getOrderFlowLotSize,
}: ChartWorkspaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const scrollPortRef = useRef<HTMLDivElement | null>(null)
  const [canExpand, setCanExpand] = useState(false)
  const synchronizeLayoutRef = useRef<(() => void) | null>(null)
  const [periodToolbar, setPeriodToolbar] = useState<HTMLElement | null>(null)
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false)
  const [drawingToolbar, setDrawingToolbar] = useState<HTMLElement | null>(null)
  const [drawingSelection, setDrawingSelection] = useState<DrawingSelection | null>(null)
  const [dayDownloadMessage, setDayDownloadMessage] = useState('')
  const [dayDownloadSelection, setDayDownloadSelection] = useState<DayDownloadSelection | null>(null)
  const [dayDownloadReview, setDayDownloadReview] = useState<DayDownloadReview | 'checking' | null>(null)
  const dayDownloadReviewAbort = useRef<AbortController | null>(null)
  const dayDownloadRequest = useRef(0)
  const symbolLockedRef = useRef(symbolLocked)
  symbolLockedRef.current = symbolLocked
  const [priceRangeAuto, setPriceRangeAuto] = useState(true)
  const [orderFlowDialog, setOrderFlowDialog] = useState<OrderFlowGroup | null>(null)
  const indicatorSavingPaused = useRef(false)
  const [indicatorInfoVisible, setIndicatorInfoVisible] = useState(() => !(window.matchMedia?.('(max-width: 767px), (max-width: 1023px) and (max-height: 520px)').matches ?? false))
  const [paneSizes, setPaneSizes] = useState<{ id: string; label: string; height: number }[]>([])
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeSizeSettingsRef = useRef<HTMLButtonElement | null>(null)
  const onCloseLayoutSettingsRef = useRef(onCloseLayoutSettings)
  onCloseLayoutSettingsRef.current = onCloseLayoutSettings
  const heightDragRef = useRef<{ pointerId: number; startY: number; height: number } | null>(null)
  const adapterRef = useRef<ChartAdapterPort | null>(null)
  const symbolRef = useRef(symbol)
  const periodRef = useRef(period)
  const reloadKeyRef = useRef(reloadKey)
  const mapping = orderFlowCloud && orderFlowMapping(symbol)
  const initialIndicatorPreferencesRef = useRef<
    ChartIndicatorPreferences | null | undefined
  >(undefined)

  if (initialIndicatorPreferencesRef.current === undefined) {
    initialIndicatorPreferencesRef.current = loadChartIndicatorPreferences()
  }

  if (adapterRef.current === null) {
    adapterRef.current = createAdapter()
  }

  useImperativeHandle(viewportRef, () => ({
    step: direction => adapterRef.current?.stepViewport?.(direction) ?? null,
  }), [])

  useEffect(() => {
    if (hostRef.current === null) {
      throw new Error('Chart host was not mounted.')
    }
    const adapter = adapterRef.current
    const initialIndicatorPreferences =
      initialIndicatorPreferencesRef.current ?? null
    adapter?.mount({
      ...createChartOptions(
        hostRef.current,
        datafeed,
        symbol,
        period,
        initialIndicatorPreferences,
      ), orderFlowCloud, getOrderFlowLotSize, onOrderFlowSettings: setOrderFlowDialog,
    })
    if (initialIndicatorPreferences !== null) {
      adapter?.applyIndicatorPreferences?.(
        initialIndicatorPreferences,
      )
    }
    const host = hostRef.current
    const scrollPort = scrollPortRef.current
    const toolbar = host.querySelector<HTMLElement>('.klinecharts-pro-period-bar')
    setPeriodToolbar(toolbar)
    const drawingBar = host.querySelector<HTMLElement>('.klinecharts-pro-drawing-bar')
    const drawingSlot = orderFlowCloud && drawingBar ? document.createElement('div') : null
    if (drawingSlot) {
      drawingSlot.className = 'chart-volume-profile-slot'
      drawingBar?.prepend(drawingSlot)
    }
    setDrawingToolbar(drawingSlot ?? toolbar)
    const priceAxis = adapter?.getPriceAxisContainer?.() ?? null
    priceAxis?.classList.add('chart-price-axis')
    const synchronizePriceControl = () => {
      if (priceAxis === null) return
      const top = priceAxis.getBoundingClientRect().top - host.getBoundingClientRect().top
      host.parentElement?.style.setProperty('--price-axis-top', `${top}px`)
    }
    const measurePeriodMenu = () => {
      const height = scrollPort && toolbar ? scrollPort.clientHeight - toolbar.offsetHeight : 0
      toolbar?.style.setProperty('--period-menu-height', `${Math.max(0, height - 4)}px`)
    }
    const synchronizeLayout = (resized = false) => {
      // Core dimensions are refreshed synchronously by resize; pane sizing
      // must use those dimensions in this observer notification.
      if (resized) adapter?.resize?.()
      const narrow = window.matchMedia?.('(max-width: 767px), (max-width: 1023px) and (max-height: 520px)').matches ?? false
      adapter?.setCompactLayout?.(narrow)
      const budget = narrow ? Math.round(window.innerHeight * 0.22) : undefined
      const fitHeight = (scrollPort?.clientHeight ?? host.clientHeight) - (toolbar?.offsetHeight ?? 0)
      const crowded = adapter?.needsMorePaneSpace?.(fitHeight) ?? false
      setCanExpand(crowded)
      const expanded = scrollPort?.hasAttribute('data-resized') && host.clientHeight > scrollPort.clientHeight
      adapter?.layoutSubPanes?.(narrow ? 60 : 0, expanded ? undefined : budget)
      measurePeriodMenu()
      synchronizePriceControl()
    }
    synchronizeLayoutRef.current = synchronizeLayout
    synchronizeLayout()
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => synchronizeLayout(true))
    resizeObserver?.observe(host)
    if (scrollPort) resizeObserver?.observe(scrollPort)
    if (toolbar) resizeObserver?.observe(toolbar)
    const scrollChart = (event: WheelEvent) => {
      if (!scrollPort?.hasAttribute('data-resized') || host.clientHeight <= scrollPort.clientHeight ||
          event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
          !(event.target instanceof Element) ||
          !event.target.closest('[k-line-chart-id]') ||
          event.target.closest('.chart-price-axis')) return
      // The chart consumes wheel events for zoom. Plain vertical wheel scrolls
      // the expanded surface, while Ctrl+wheel still zooms the time scale.
      event.preventDefault()
      event.stopPropagation()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scrollPort.clientHeight : 1
      scrollPort.scrollTop += event.deltaY * unit
    }
    scrollPort?.addEventListener('wheel', scrollChart, { capture: true, passive: false })
    const axisResizeObserver = priceAxis !== null && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(synchronizePriceControl) : null
    if (priceAxis !== null) axisResizeObserver?.observe(priceAxis)
    const openSymbolPicker = (event: MouseEvent) => {
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('.klinecharts-pro-period-bar .symbol') !== null
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!auxiliary && !symbolLockedRef.current) setSymbolPickerOpen(true)
      }
    }
    host.addEventListener('click', openSymbolPicker, true)
    return () => {
      resizeObserver?.disconnect()
      axisResizeObserver?.disconnect()
      scrollPort?.removeEventListener('wheel', scrollChart, true)
      synchronizeLayoutRef.current = null
      host.removeEventListener('click', openSymbolPicker, true)
      drawingSlot?.remove()
      dayDownloadRequest.current++
      dayDownloadReviewAbort.current?.abort()
      adapter?.dispose?.()
    }
  }, [])

  useEffect(() => {
    if (!layoutSettingsOpen) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeSizeSettingsRef.current?.focus()
    const synchronizePanes = () => {
      const panes = adapterRef.current?.getIndicatorPaneSizes?.() ?? []
      setPaneSizes((current) => JSON.stringify(current) === JSON.stringify(panes) ? current : panes)
    }
    synchronizePanes()
    const interval = window.setInterval(synchronizePanes, 250)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onCloseLayoutSettingsRef.current?.()
      }
      if (event.key === 'Tab') {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')
        const first = controls?.[0]
        const last = controls?.[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('keydown', handleKeyDown, true)
      if (opener?.isConnected) opener.focus()
    }
  }, [layoutSettingsOpen])

  useEffect(() => {
    adapterRef.current?.setIndicatorInfoVisible?.(indicatorInfoVisible)
  }, [indicatorInfoVisible])

  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 767px), (max-width: 1023px) and (max-height: 520px)')
    if (!query) return
    const change = () => setIndicatorInfoVisible(!query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])

  useEffect(() => {
    if (symbolRef.current.ticker !== symbol.ticker ||
        symbolRef.current.pricePrecision !== symbol.pricePrecision || symbolRef.current.volumePrecision !== symbol.volumePrecision) {
      symbolRef.current = symbol
      adapterRef.current?.setSymbol(symbol)
    }
  }, [symbol])

  useEffect(() => {
    const adapter = adapterRef.current
    if (adapter?.getPriceRangeAuto === undefined) return
    const synchronize = () => {
      setPriceRangeAuto(adapter.getPriceRangeAuto?.() ?? true)
      adapter.refreshMarketSessionTimeline?.()
    }
    synchronize()
    const interval = window.setInterval(synchronize, 100)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (periodRef.current.text !== period.text) {
      periodRef.current = period
      adapterRef.current?.setPeriod(period)
    }
  }, [period])

  useEffect(() => {
    if (drawingStore) adapterRef.current?.setDrawingScope?.(drawingStore, drawingScope, setDrawingSelection)
  }, [drawingStore, drawingScope])

  useEffect(() => {
    if (reloadKeyRef.current !== reloadKey) {
      reloadKeyRef.current = reloadKey
      void adapterRef.current?.reloadData()
    }
  }, [period, reloadKey, symbol])

  useEffect(() => {
    if (onSelectionChange === undefined) {
      return
    }
    let lastSymbol = symbol.ticker
    let lastPeriod = period.text
    const synchronize = () => {
      const adapter = adapterRef.current
      if (adapter === null) return
      const currentSymbol = adapter.getSymbol()
      const currentPeriod = adapter.getPeriod()
      if (
        currentSymbol.ticker !== lastSymbol ||
        currentPeriod.text !== lastPeriod
      ) {
        lastSymbol = currentSymbol.ticker
        lastPeriod = currentPeriod.text
        onSelectionChange({
          symbol: currentSymbol,
          period: currentPeriod,
        })
      }
    }
    const interval = window.setInterval(synchronize, 250)
    return () => window.clearInterval(interval)
  }, [onSelectionChange, period.text, symbol.ticker])

  useEffect(() => {
    if (simulationOverlays !== undefined) {
      adapterRef.current?.setSimulationOverlays(showTradeOverlays
        ? simulationOverlays
        : { currentTime: simulationOverlays.currentTime, positions: [], trades: [] })
    }
  }, [period.text, showTradeOverlays, simulationOverlays])

  useEffect(() => {
    if (jumpRequest === null) return
    const jump = adapterRef.current?.jumpToTime
    if (jump === undefined) {
      onJumpComplete?.(null)
      return
    }
    let active = true
    const adapter = adapterRef.current!
    const symbolAtJump = adapter.getSymbol().ticker
    const periodAtJump = adapter.getPeriod().text
    const isCurrent = () => active && adapter.getSymbol().ticker === symbolAtJump && adapter.getPeriod().text === periodAtJump
    void jump
      .call(adapter, jumpRequest.timestamp, jumpRequest.followLatest)
      .then((timestamp) => {
        if (isCurrent()) onJumpComplete?.(timestamp)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (isCurrent()) onJumpComplete?.(null)
      })
    return () => {
      active = false
    }
  }, [jumpRequest?.id, onJumpComplete])

  useEffect(() => {
    if (onReplayStartTimeChange === undefined) return
    const adapter = adapterRef.current
    if (adapter?.getRightmostVisibleCandleTime === undefined) return
    let previous: number | null | undefined
    const synchronize = () => {
      const timestamp = adapter.getRightmostVisibleCandleTime?.() ?? null
      if (timestamp === previous) return
      previous = timestamp
      onReplayStartTimeChange(timestamp)
    }
    synchronize()
    const interval = window.setInterval(synchronize, 250)
    return () => window.clearInterval(interval)
  }, [onReplayStartTimeChange])

  useEffect(() => {
    if (auxiliary) return
    const adapter = adapterRef.current
    if (adapter?.getIndicatorPreferences === undefined) return
    let previous = JSON.stringify(adapter.getIndicatorPreferences())
    const restored = () => { indicatorSavingPaused.current = true }
    const synchronize = () => {
      synchronizeLayoutRef.current?.()
      if (indicatorSavingPaused.current) return
      const preferences = adapter.getIndicatorPreferences?.()
      if (preferences === undefined) return
      const serialized = JSON.stringify(preferences)
      if (serialized === previous) return
      previous = serialized
      saveChartIndicatorPreferences(preferences)
    }
    const interval = window.setInterval(synchronize, 250)
    window.addEventListener('beforeunload', synchronize)
    window.addEventListener(PREFERENCES_RESTORED, restored)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('beforeunload', synchronize)
      window.removeEventListener(PREFERENCES_RESTORED, restored)
    }
  }, [])

  useEffect(() => {
    if (auxiliary) return
    const adapter = adapterRef.current
    if (adapter?.getCandleType === undefined) return
    let previous = adapter.getCandleType()
    const synchronize = () => {
      const current = adapter.getCandleType?.()
      if (current === undefined || current === previous) return
      previous = current
      saveCandleType(current)
    }
    const interval = window.setInterval(synchronize, 100)
    window.addEventListener('beforeunload', synchronize)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('beforeunload', synchronize)
    }
  }, [])

  function selectCompactPeriod(periodText: string): void {
    const nextPeriod = CTRADER_PERIODS.find(
      (candidate) => candidate.text === periodText,
    )
    if (nextPeriod === undefined) return
    periodRef.current = nextPeriod
    adapterRef.current?.setPeriod(nextPeriod)
    onSelectionChange?.({
      symbol: symbolRef.current,
      period: nextPeriod,
    })
  }

  function selectSymbol(nextSymbol: SymbolInfo): void {
    symbolRef.current = nextSymbol
    adapterRef.current?.setSymbol(nextSymbol)
    setSymbolPickerOpen(false)
    onSelectionChange?.({
      symbol: nextSymbol,
      period: periodRef.current,
    }, true)
  }

  function changePriceRangeMode(auto: boolean): void {
    adapterRef.current?.setPriceRangeAuto?.(auto)
    setPriceRangeAuto(auto)
  }

  function toggleIndicatorInfo(): void {
    const visible = !indicatorInfoVisible
    adapterRef.current?.setIndicatorInfoVisible?.(visible)
    setIndicatorInfoVisible(visible)
  }

  function currentChartHeight(): number {
    return chartHeight ?? (scrollPortRef.current?.clientHeight || 600)
  }

  function changeChartHeight(height: number): void {
    onChartHeightChange?.(Math.max(280, Math.min(1600, Math.round(height))))
  }

  function changePaneHeight(paneId: string, height: number): void {
    const adapter = adapterRef.current
    adapter?.setIndicatorPaneHeight?.(paneId, height)
    const preferences = adapter?.getIndicatorPreferences?.()
    if (!auxiliary && !indicatorSavingPaused.current && preferences !== undefined) saveChartIndicatorPreferences(preferences)
    setPaneSizes(adapter?.getIndicatorPaneSizes?.() ?? [])
    synchronizeLayoutRef.current?.()
    adapter?.resize?.()
  }

  function openBybitDownload(): void {
    try {
      const day = adapterRef.current?.getVisibleBybitDay?.() ?? ''
      setDayDownloadSelection({ anchor: day, before: '0', after: '0' })
    } catch (error) {
      setDayDownloadMessage(error instanceof Error ? error.message : '当前图表暂无可见 K 线')
    }
  }

  function downloadBybitDays(): void {
    if (!dayDownloadSelection) return
    const range = resolveDayDownloadRange(dayDownloadSelection, bybitDay(Date.now()))
    if (range.error !== undefined) {
      setDayDownloadSelection({ ...dayDownloadSelection, error: range.error })
      return
    }
    const request = ++dayDownloadRequest.current
    const report = (message: string) => {
      if (dayDownloadRequest.current === request) setDayDownloadMessage(message)
    }
    const abort = mapping && mapping.okx ? new AbortController() : undefined
    try {
      const download = adapterRef.current?.downloadBybitDays?.(range.start, range.end, report, abort && {
        signal: abort.signal,
        choose: days => new Promise<TradeDownloadChoice>(resolve => {
          if (abort.signal.aborted) { resolve('cancel'); return }
          const cancel = () => resolve('cancel')
          abort.signal.addEventListener('abort', cancel, { once: true })
          setDayDownloadReview({ days, choose: choice => {
            abort.signal.removeEventListener('abort', cancel)
            resolve(choice)
          } })
        }),
      })
      if (!download) return
      if (abort) {
        dayDownloadReviewAbort.current = abort
        setDayDownloadReview('checking')
      }
      setDayDownloadSelection(null)
      void download.then(message => { if (message) report(message) }, error => {
        if (abort?.signal.aborted) return
        if (abort && dayDownloadReviewAbort.current === abort) {
          dayDownloadReviewAbort.current = null
          setDayDownloadReview(null)
        }
        report(error instanceof Error ? error.message : '无法加载逐笔成交')
      })
    } catch (error) {
      setDayDownloadSelection({ ...dayDownloadSelection, error: error instanceof Error ? error.message : '无法加载逐笔成交' })
    }
  }

  const reviewedDays = dayDownloadReview && dayDownloadReview !== 'checking' ? dayDownloadReview.days : null
  const canDownloadArchives = reviewedDays?.some(day => day.status === 'cached' ||
    (day.status === 'uncached' && day.canCache) || (day.status === 'unarchived' && day.bybitFallback))
  const canDownloadHistory = reviewedDays?.some(day =>
    (day.status === 'unarchived' && day.canUseHistory) || (day.status === 'loaded' && day.canExtendHistory))

  function finishDayDownloadReview(choice: TradeDownloadChoice): void {
    if (dayDownloadReview && dayDownloadReview !== 'checking') {
      dayDownloadReview.choose(choice)
    } else {
      dayDownloadReviewAbort.current?.abort()
    }
    dayDownloadReviewAbort.current = null
    setDayDownloadReview(null)
    setDayDownloadSelection(null)
  }

  const today = bybitDay(Date.now())
  const downloadPreview = dayDownloadSelection && resolveDayDownloadRange(dayDownloadSelection, today)
  const dayDownload = (
    <>
      <button className="chart-day-download" type="button" disabled={!mapping}
        title={mapping ? `选择 ${orderFlowLabel(mapping)} 逐笔成交的下载日期` : '当前品种暂无成交量'}
        onClick={openBybitDownload}>
        下载成交数据
      </button>
      {dayDownloadMessage && (
        <div className="chart-day-download-status">
          <span role="status">{dayDownloadMessage}</span>
          <button type="button" aria-label="关闭下载提示" onClick={() => {
            dayDownloadRequest.current++
            setDayDownloadMessage('')
          }}>×</button>
        </div>
      )}
    </>
  )

  const indicatorInfoToggle = (
    <button
      aria-label={indicatorInfoVisible ? '隐藏主图指标信息' : '显示主图指标信息'}
      aria-expanded={indicatorInfoVisible}
      className="indicator-info-toggle"
      onClick={toggleIndicatorInfo}
      title={indicatorInfoVisible ? '隐藏主图指标信息' : '显示主图指标信息'}
      type="button"
    >
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
        <path d={indicatorInfoVisible ? 'M2 8 L6 4 L10 8' : 'M2 4 L6 8 L10 4'} />
      </svg>
    </button>
  )

  // Keep controls outside the native gesture surface; measure the candle axis boundary.
  const priceRangeMode = (
    <div
      className="price-range-mode"
      role="group"
      aria-label="价格范围模式"
      onMouseDown={event => event.stopPropagation()}
      onTouchStart={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()}
    >
      <span className="price-axis-unit" aria-label="计价单位">{symbol.priceCurrency?.toUpperCase() ?? '—'}</span>
      <button
        aria-label="自动价格范围"
        aria-pressed={priceRangeAuto}
        onClick={() => changePriceRangeMode(!(adapterRef.current?.getPriceRangeAuto?.() ?? priceRangeAuto))}
        title={priceRangeAuto ? '自动适配已开启 · 点击切换手动' : '手动模式 · 点击恢复自动适配'}
        type="button"
      ><span aria-hidden="true">A</span></button>
    </div>
  )

  const periodSelector = <PeriodSelector value={period.text} onChange={selectCompactPeriod} allowPinning={!auxiliary} />
  const expanded = chartHeight !== null && canExpand
  const settingsSnapshot = orderFlowDialog ? adapterRef.current?.getIndicatorPreferences?.() : undefined
  const bubble = settingsSnapshot?.main.find(setting => setting.name === BIG_TRADES)
  const orderFlowSettings = bubble ? {
    ...settingsSnapshot?.orderFlow,
    bubbles: { ...settingsSnapshot?.orderFlow?.bubbles, ...bubblePreferenceDefaults(bubble.calcParams, bubble.styles) },
  } : settingsSnapshot?.orderFlow

  return (
    <section className="chart-workspace" aria-label="行情图表" data-price-range-auto={priceRangeAuto}>
      <div className="chart-scroll-port" data-resized={expanded || undefined} ref={scrollPortRef}>
        <div className="chart-surface" style={{ height: expanded ? `${chartHeight}px` : undefined }}>
          <div className="chart-host" data-testid="chart-host" ref={hostRef} />
          {periodToolbar === null ? indicatorInfoToggle : createPortal(indicatorInfoToggle, periodToolbar)}
          {priceRangeMode}
          {drawingSelection && <DrawingSelectionToolbar selection={drawingSelection}
            onChange={change => adapterRef.current?.changeSelectedDrawing?.(drawingSelection.id, change)}
            onDelete={() => adapterRef.current?.deleteSelectedDrawing?.(drawingSelection.id)} />}
          {orderFlowCloud && periodToolbar && createPortal(dayDownload, periodToolbar)}
          {periodToolbar === null ? periodSelector : createPortal(periodSelector, periodToolbar)}
        </div>
      </div>
      {symbolPickerOpen && !symbolLocked ? (
        <SymbolPicker
          currentSymbol={symbolRef.current}
          datafeed={datafeed}
          orderFlowAvailable={!!orderFlowCloud}
          onClose={() => setSymbolPickerOpen(false)}
          onSelect={selectSymbol}
        />
      ) : null}
      {orderFlowDialog && <OrderFlowSettingsDialog key={orderFlowDialog} group={orderFlowDialog}
        preferences={orderFlowSettings}
        onClose={() => setOrderFlowDialog(null)} onSave={preferences => {
          const adapter = adapterRef.current
          adapter?.setOrderFlowPreferences?.(preferences)
          const snapshot = adapter?.getIndicatorPreferences?.()
          if (!auxiliary && !indicatorSavingPaused.current && snapshot) saveChartIndicatorPreferences(snapshot)
          setOrderFlowDialog(null)
        }} />}
      {orderFlowCloud && drawingToolbar && createPortal(
        <button type="button" className="chart-volume-profile-tool" aria-label="框选成交分布"
          title={mapping ? `框选成交分布 · ${orderFlowLabel(mapping)}` : '当前品种暂无成交量'} disabled={!mapping}
          onClick={() => adapterRef.current?.startVolumeProfile?.()}>
          <span aria-hidden="true"><i /><i /><i /></span>
        </button>, drawingToolbar,
      )}
      <WorkspaceDialog open={dayDownloadSelection !== null || dayDownloadReview !== null} title="下载成交数据"
        onClose={() => finishDayDownloadReview(canDownloadHistory ? 'archives' : 'cancel')}
        className="bybit-download-dialog">
        {dayDownloadSelection && <form className="bybit-download-form" noValidate onSubmit={event => {
          event.preventDefault()
          downloadBybitDays()
        }}>
          <p>{mapping && orderFlowLabel(mapping)} · UTC 日期</p>
          <label>锚点日期<input type="date" value={dayDownloadSelection.anchor} max={today} required
            onChange={event => setDayDownloadSelection({ ...dayDownloadSelection, anchor: event.target.value, error: undefined })} /></label>
          <div>
            <label>往前天数<input type="number" min="0" step="1" value={dayDownloadSelection.before} required
              onChange={event => setDayDownloadSelection({ ...dayDownloadSelection, before: event.target.value, error: undefined })} /></label>
            <label>往后天数<input type="number" min="0" step="1" value={dayDownloadSelection.after} required
              onChange={event => setDayDownloadSelection({ ...dayDownloadSelection, after: event.target.value, error: undefined })} /></label>
          </div>
          {downloadPreview?.start && <p>下载范围 <strong>{downloadPreview.start === downloadPreview.end
            ? downloadPreview.start : `${downloadPreview.start} 至 ${downloadPreview.end}`}</strong>
            {downloadPreview.clipped && ' · 未来日期已跳过'}</p>}
          {mapping && mapping.okx && <p>选择范围后可查看逐日归档状态。</p>}
          {dayDownloadSelection.error && <p role="alert">{dayDownloadSelection.error}</p>}
          <button type="submit">下载</button>
        </form>}
        {dayDownloadReview === 'checking' && <p role="status">正在检查日期状态…</p>}
        {reviewedDays && (
          <div className="bybit-download-form day-download-review">
            <div className="day-download-table" tabIndex={0}>
              <table aria-label="成交数据日期状态">
                <thead><tr><th scope="col">UTC 日期</th><th scope="col">状态</th></tr></thead>
                <tbody>{reviewedDays.map(day => (
                  <tr key={day.day}>
                    <th scope="row">{day.day}</th>
                    <td>
                      <span data-download-status={day.status}>{tradeDownloadStatus[day.status]}</span>
                      <small>{tradeDownloadDetail(day, today)}</small>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="day-download-actions">
              {canDownloadArchives || canDownloadHistory ? (
                <button type="button" autoFocus onClick={() => finishDayDownloadReview('archives')}>只下载归档</button>
              ) : <button type="button" autoFocus onClick={() => finishDayDownloadReview('cancel')}>完成</button>}
              {canDownloadHistory && (
                <button type="button" onClick={() => finishDayDownloadReview('includeHistory')}>下载归档并补齐近期数据</button>
              )}
            </div>
          </div>
        )}
      </WorkspaceDialog>
      {onChartHeightChange !== undefined ? (
        <div
          aria-label="图表高度"
          aria-orientation="horizontal"
          aria-valuemin={280}
          aria-valuemax={1600}
          aria-valuenow={Math.max(280, Math.min(1600, Math.round(currentChartHeight())))}
          aria-disabled={!canExpand}
          className="chart-height-handle"
          role="separator"
          tabIndex={canExpand ? 0 : -1}
          onPointerDown={(event) => {
            if (!canExpand || event.button !== 0 || heightDragRef.current !== null) return
            event.preventDefault()
            event.currentTarget.focus()
            heightDragRef.current = { pointerId: event.pointerId, startY: event.clientY, height: currentChartHeight() }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const drag = heightDragRef.current
            if (drag?.pointerId === event.pointerId) changeChartHeight(drag.height + event.clientY - drag.startY)
          }}
          onPointerUp={(event) => {
            if (heightDragRef.current?.pointerId !== event.pointerId) return
            heightDragRef.current = null
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => { heightDragRef.current = null }}
          onLostPointerCapture={() => { heightDragRef.current = null }}
          onKeyDown={(event) => {
            if (!canExpand) return
            const delta = event.shiftKey ? 100 : 20
            const next = event.key === 'ArrowUp' ? currentChartHeight() - delta
              : event.key === 'ArrowDown' ? currentChartHeight() + delta
              : event.key === 'Home' ? 280 : event.key === 'End' ? 1600 : null
            if (next === null) return
            event.preventDefault()
            changeChartHeight(next)
          }}
        ><span aria-hidden="true" /></div>
      ) : null}
      {layoutSettingsOpen ? createPortal(
        <div className="chart-size-backdrop" onPointerDown={(event) => {
          if (event.target === event.currentTarget) onCloseLayoutSettings?.()
        }}>
          <div aria-label="图表尺寸设置" aria-modal="true" className="chart-size-dialog" ref={dialogRef} role="dialog">
            <header><strong>图表尺寸设置</strong><button aria-label="关闭图表尺寸设置" onClick={onCloseLayoutSettings} ref={closeSizeSettingsRef} type="button">×</button></header>
            <div className="chart-size-fields">
              <label>
                <span>图表区域高度 <output>{expanded ? `${chartHeight} px` : '自动适配'}</output></span>
                <input aria-label="图表区域高度" disabled={onChartHeightChange === undefined || !canExpand} max={1600} min={280} onChange={(event) => changeChartHeight(Number(event.target.value))} step={1} type="range" value={Math.round(currentChartHeight())} />
              </label>
              <button disabled={onChartHeightChange === undefined} onClick={() => onChartHeightChange?.(null)} type="button">自动适配</button>
              <p>图表默认填满可用空间。副图放不下时，可拖动图表底边增高，并在图表区域内滚动。各副图高度随指标设置保存。</p>
              {paneSizes.length === 0 ? <p>当前没有副图指标。</p> : paneSizes.map((pane) => (
                <label key={pane.id}>
                  <span>{pane.label}<output>{pane.height} px</output></span>
                  <input aria-label={`${pane.label} 高度`} max={600} min={60} onChange={(event) => changePaneHeight(pane.id, Number(event.target.value))} step={1} type="range" value={pane.height} />
                </label>
              ))}
            </div>
            <footer><button onClick={onCloseLayoutSettings} type="button">完成</button></footer>
          </div>
        </div>, document.body,
      ) : null}
    </section>
  )
}
