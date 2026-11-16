import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Datafeed, Period, SymbolInfo } from '@klinecharts/pro'
import {
  createChartOptions,
  DEFAULT_SYMBOL,
  SUPPORTED_PERIODS,
} from './chart-config'
import { DemoDatafeed } from './demo-datafeed'
import {
  loadChartIndicatorPreferences,
  saveChartIndicatorPreferences,
  type ChartIndicatorPreferences,
} from './indicator-preferences'
import {
  ProChartAdapter,
  type ChartAdapterPort,
  type SimulationOverlayState,
} from './pro-chart-adapter'
import { SymbolPicker } from './SymbolPicker'
import { PeriodSelector } from './PeriodSelector'
import { saveCandleType } from './candle-preferences'
import type { DrawingStore } from './drawings'
import './chart-size-controls.css'

export interface ChartWorkspaceProps {
  createAdapter?: () => ChartAdapterPort
  datafeed?: Datafeed
  symbol?: SymbolInfo
  period?: Period
  reloadKey?: number
  onSelectionChange?: (selection: {
    symbol: SymbolInfo
    period: Period
  }) => void
  simulationOverlays?: SimulationOverlayState
  showTradeOverlays?: boolean
  jumpRequest?: {
    id: string
    timestamp: number
  } | null
  onJumpComplete?: (timestamp: number | null) => void
  onRightmostCandleTimeChange?: (timestamp: number | null) => void
  layoutSettingsOpen?: boolean
  onCloseLayoutSettings?: () => void
  chartHeight?: number | null
  onChartHeightChange?: (height: number | null) => void
  auxiliary?: boolean
  drawingStore?: DrawingStore
  drawingScope?: string | null
}

const demoDatafeed = new DemoDatafeed()

export function ChartWorkspace({
  createAdapter = () => new ProChartAdapter(),
  datafeed = demoDatafeed,
  symbol = DEFAULT_SYMBOL,
  period = SUPPORTED_PERIODS[3],
  reloadKey = 0,
  onSelectionChange,
  simulationOverlays,
  showTradeOverlays = true,
  jumpRequest = null,
  onJumpComplete,
  onRightmostCandleTimeChange,
  layoutSettingsOpen = false,
  onCloseLayoutSettings,
  chartHeight = null,
  onChartHeightChange,
  auxiliary = false,
  drawingStore,
  drawingScope = null,
}: ChartWorkspaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const scrollPortRef = useRef<HTMLDivElement | null>(null)
  const [canExpand, setCanExpand] = useState(false)
  const synchronizeLayoutRef = useRef<(() => void) | null>(null)
  const [periodToolbar, setPeriodToolbar] = useState<HTMLElement | null>(null)
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false)
  const [priceRangeAuto, setPriceRangeAuto] = useState(true)
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
  const initialIndicatorPreferencesRef = useRef<
    ChartIndicatorPreferences | null | undefined
  >(undefined)

  if (initialIndicatorPreferencesRef.current === undefined) {
    initialIndicatorPreferencesRef.current =
      loadChartIndicatorPreferences()
  }

  if (adapterRef.current === null) {
    adapterRef.current = createAdapter()
  }

  useEffect(() => {
    if (hostRef.current === null) {
      throw new Error('Chart host was not mounted.')
    }
    const adapter = adapterRef.current
    const initialIndicatorPreferences =
      initialIndicatorPreferencesRef.current ?? null
    adapter?.mount(
      createChartOptions(
        hostRef.current,
        datafeed,
        symbol,
        period,
        initialIndicatorPreferences,
      ),
    )
    if (initialIndicatorPreferences !== null) {
      adapter?.applyIndicatorPreferences?.(
        initialIndicatorPreferences,
      )
    }
    const host = hostRef.current
    const scrollPort = scrollPortRef.current
    const toolbar = host.querySelector<HTMLElement>('.klinecharts-pro-period-bar')
    setPeriodToolbar(toolbar)
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
        if (!auxiliary) setSymbolPickerOpen(true)
      }
    }
    host.addEventListener('click', openSymbolPicker, true)
    return () => {
      resizeObserver?.disconnect()
      axisResizeObserver?.disconnect()
      scrollPort?.removeEventListener('wheel', scrollChart, true)
      synchronizeLayoutRef.current = null
      host.removeEventListener('click', openSymbolPicker, true)
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
    if (symbolRef.current.ticker !== symbol.ticker) {
      symbolRef.current = symbol
      adapterRef.current?.setSymbol(symbol)
    }
  }, [symbol])

  useEffect(() => {
    const adapter = adapterRef.current
    if (adapter?.getPriceRangeAuto === undefined) return
    const synchronize = () => setPriceRangeAuto(adapter.getPriceRangeAuto?.() ?? true)
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
    if (drawingStore) adapterRef.current?.setDrawingScope?.(drawingStore, drawingScope)
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
      .call(adapterRef.current, jumpRequest.timestamp)
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
    if (onRightmostCandleTimeChange === undefined) return
    const adapter = adapterRef.current
    if (adapter?.getRightmostVisibleCandleTime === undefined) return
    let previous: number | null | undefined
    const synchronize = () => {
      const timestamp = adapter.getRightmostVisibleCandleTime?.() ?? null
      if (timestamp === previous) return
      previous = timestamp
      onRightmostCandleTimeChange(timestamp)
    }
    synchronize()
    const interval = window.setInterval(synchronize, 250)
    return () => window.clearInterval(interval)
  }, [onRightmostCandleTimeChange])

  useEffect(() => {
    if (auxiliary) return
    const adapter = adapterRef.current
    if (adapter?.getIndicatorPreferences === undefined) return
    let previous = JSON.stringify(adapter.getIndicatorPreferences())
    const synchronize = () => {
      synchronizeLayoutRef.current?.()
      const preferences = adapter.getIndicatorPreferences?.()
      if (preferences === undefined) return
      const serialized = JSON.stringify(preferences)
      if (serialized === previous) return
      previous = serialized
      saveChartIndicatorPreferences(preferences)
    }
    const interval = window.setInterval(synchronize, 250)
    window.addEventListener('beforeunload', synchronize)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('beforeunload', synchronize)
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
    const nextPeriod = SUPPORTED_PERIODS.find(
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
    })
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
    if (!auxiliary && preferences !== undefined) saveChartIndicatorPreferences(preferences)
    setPaneSizes(adapter?.getIndicatorPaneSizes?.() ?? [])
    synchronizeLayoutRef.current?.()
    adapter?.resize?.()
  }

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
      <span className="price-axis-unit" aria-label="计价单位">{symbol.priceCurrency?.toUpperCase() ?? 'USDT'}</span>
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

  return (
    <section className="chart-workspace" aria-label="行情图表" data-price-range-auto={priceRangeAuto}>
      <div className="chart-scroll-port" data-resized={expanded || undefined} ref={scrollPortRef}>
        <div className="chart-surface" style={{ height: expanded ? `${chartHeight}px` : undefined }}>
          <div className="chart-host" data-testid="chart-host" ref={hostRef} />
          {periodToolbar === null ? indicatorInfoToggle : createPortal(indicatorInfoToggle, periodToolbar)}
          {priceRangeMode}
          {periodToolbar === null ? periodSelector : createPortal(periodSelector, periodToolbar)}
        </div>
      </div>
      {symbolPickerOpen ? (
        <SymbolPicker
          currentSymbol={symbolRef.current}
          datafeed={datafeed}
          onClose={() => setSymbolPickerOpen(false)}
          onSelect={selectSymbol}
        />
      ) : null}
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
