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
  jumpRequest = null,
  onJumpComplete,
  onRightmostCandleTimeChange,
  layoutSettingsOpen = false,
  onCloseLayoutSettings,
  chartHeight = null,
  onChartHeightChange,
}: ChartWorkspaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
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
    setPeriodToolbar(host.querySelector('.klinecharts-pro-period-bar'))
    const synchronizeLayout = (resized = false) => {
      // Core dimensions are refreshed synchronously by resize; pane sizing
      // must use those dimensions in this observer notification.
      if (resized) adapter?.resize?.()
      const narrow = window.matchMedia?.('(max-width: 1023px)').matches ?? false
      const subPaneHeight = adapter?.layoutSubPanes?.(narrow ? 80 : 0)
      if (narrow && subPaneHeight !== undefined) {
        const style = host.parentElement?.style
        const next = `${subPaneHeight}px`
        if (style?.getPropertyValue('--chart-subpanes-height') !== next) {
          style?.setProperty('--chart-subpanes-height', next)
          adapter?.resize?.()
          adapter?.layoutSubPanes?.(80)
        }
      }
    }
    synchronizeLayoutRef.current = synchronizeLayout
    synchronizeLayout()
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => synchronizeLayout(true))
    resizeObserver?.observe(host)
    const openSymbolPicker = (event: MouseEvent) => {
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('.klinecharts-pro-period-bar .symbol') !== null
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        setSymbolPickerOpen(true)
      }
    }
    host.addEventListener('click', openSymbolPicker, true)
    return () => {
      resizeObserver?.disconnect()
      synchronizeLayoutRef.current = null
      host.removeEventListener('click', openSymbolPicker, true)
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
      adapterRef.current?.setSimulationOverlays(simulationOverlays)
    }
  }, [simulationOverlays])

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
    return chartHeight ?? (hostRef.current?.parentElement?.getBoundingClientRect().height || 600)
  }

  function changeChartHeight(height: number): void {
    onChartHeightChange?.(Math.max(280, Math.min(1600, Math.round(height))))
  }

  function changePaneHeight(paneId: string, height: number): void {
    const adapter = adapterRef.current
    adapter?.setIndicatorPaneHeight?.(paneId, height)
    const preferences = adapter?.getIndicatorPreferences?.()
    if (preferences !== undefined) saveChartIndicatorPreferences(preferences)
    setPaneSizes(adapter?.getIndicatorPaneSizes?.() ?? [])
    synchronizeLayoutRef.current?.()
    adapter?.resize?.()
  }

  return (
    <section className="chart-workspace" aria-label="行情图表">
      <div className="chart-host" data-testid="chart-host" ref={hostRef} />
      <button
        aria-label={indicatorInfoVisible ? '隐藏指标信息' : '显示指标信息'}
        aria-expanded={indicatorInfoVisible}
        className="indicator-info-toggle"
        onClick={toggleIndicatorInfo}
        title={indicatorInfoVisible ? '隐藏指标信息' : '显示指标信息'}
        type="button"
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
          <path d={indicatorInfoVisible ? 'M2 8 L6 4 L10 8' : 'M2 4 L6 8 L10 4'} />
        </svg>
      </button>
      <div className="price-range-mode" role="group" aria-label="价格范围模式">
        <button
          aria-pressed={priceRangeAuto}
          onClick={() => changePriceRangeMode(true)}
          title="自动锁定价格范围"
          type="button"
        >自动</button>
        <button
          aria-pressed={!priceRangeAuto}
          onClick={() => changePriceRangeMode(false)}
          title="手动缩放价格范围"
          type="button"
        >手动</button>
      </div>
      {periodToolbar === null
        ? <PeriodSelector value={period.text} onChange={selectCompactPeriod} />
        : createPortal(<PeriodSelector value={period.text} onChange={selectCompactPeriod} />, periodToolbar)}
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
          aria-valuenow={Math.round(currentChartHeight())}
          className="chart-height-handle"
          role="separator"
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0 || heightDragRef.current !== null) return
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
                <span>图表区域高度 <output>{chartHeight === null ? '自动适配' : `${chartHeight} px`}</output></span>
                <input aria-label="图表区域高度" disabled={onChartHeightChange === undefined} max={1600} min={280} onChange={(event) => changeChartHeight(Number(event.target.value))} step={1} type="range" value={Math.round(currentChartHeight())} />
              </label>
              <button disabled={onChartHeightChange === undefined} onClick={() => onChartHeightChange?.(null)} type="button">自动适配</button>
              <p>拖动图表底边也可调整高度。副图尺寸与指标设置一起保存；空间不足时自动缩小显示，可增加图表区域高度查看完整副图。</p>
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
