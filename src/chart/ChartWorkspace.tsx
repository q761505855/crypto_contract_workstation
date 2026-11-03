import { useEffect, useRef, useState } from 'react'
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
}: ChartWorkspaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false)
  const [priceRangeAuto, setPriceRangeAuto] = useState(true)
  const [indicatorInfoVisible, setIndicatorInfoVisible] = useState(true)
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
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => adapter?.resize?.())
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
      host.removeEventListener('click', openSymbolPicker, true)
    }
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
    void jump
      .call(adapterRef.current, jumpRequest.timestamp)
      .then((timestamp) => {
        if (active) onJumpComplete?.(timestamp)
      })
      .catch(() => {
        if (active) onJumpComplete?.(null)
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
      <label className="compact-period-selector">
        <span>周期</span>
        <select
          aria-label="图表周期"
          onChange={(event) => selectCompactPeriod(event.target.value)}
          value={period.text}
        >
          {SUPPORTED_PERIODS.map((candidate) => (
            <option key={candidate.text} value={candidate.text}>
              {candidate.text}
            </option>
          ))}
        </select>
      </label>
      {symbolPickerOpen ? (
        <SymbolPicker
          currentSymbol={symbolRef.current}
          datafeed={datafeed}
          onClose={() => setSymbolPickerOpen(false)}
          onSelect={selectSymbol}
        />
      ) : null}
    </section>
  )
}
