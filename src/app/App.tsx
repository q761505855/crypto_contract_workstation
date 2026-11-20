import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Decimal from 'decimal.js'
import { formatDisplayTime } from '../format-display-time'
import {
  DEFAULT_CTRADER_SYMBOL,
  DEFAULT_CTRADER_PERIOD,
} from '../chart/chart-config'
import { ChartWorkspace } from '../chart/ChartWorkspace'
import { ChartWindowHost, openChartWindow } from '../chart/chart-window'
import { drawingScope } from '../chart/drawings'
import { readShowTradeOverlays, saveShowTradeOverlays } from '../chart/trade-overlay-preferences'
import type { SimulationOverlayState } from '../chart/pro-chart-adapter'
import { SIMULATION_BUY_COLOR, SIMULATION_SELL_COLOR, type SimulationTradeLabel } from '../chart/simulation-price-line'
import {
  ModeSwitch,
  type WorkstationMode,
} from '../components/ModeSwitch'
import { DataManager } from '../components/DataManager'
import { CTraderAccountPicker } from '../components/CTraderAccountPicker'
import { ConfigSyncStatus } from '../components/ConfigSyncStatus'
import { PREFERENCES_RESTORED } from '../storage/preference-events'
import { ReplayControls } from '../components/ReplayControls'
import { TimeJumpControl } from '../components/TimeJumpControl'
import { LiveStatus } from '../components/panels'
import { AccountStrip, SimulationOrder, SimulationDock, type TradingTab } from '../components/TradingWorkspace'
import { WorkspaceDialog } from '../components/WorkspaceDialog'
import { WorkspaceTools } from '../components/WorkspaceTools'
import { PanelToggle } from '../components/PanelToggle'
import { loadWorkspacePreferences, saveWorkspacePreferences, DEFAULT_WORKSPACE_PREFERENCES, type WorkspacePreferences } from '../workspace/preferences'
import type { MarketSelection } from '../market-data/models'
import { readSelectedSymbol, saveSelectedSymbol } from '../market-data/symbol-preferences'
import {
  INITIAL_LIVE_STATUS,
  type LiveMarketStatus,
} from '../market-data/live-models'
import { createMarketDataRuntime, type MarketDataRuntime } from '../market-data/runtime'
import { replaySourceTimeframe, replayVisibleUntil, sessionVisibleUntil, type ReplayContext } from '../replay/models'
import { useCTraderReplayController } from '../replay/useCTraderReplayController'
import { readReplayStepPeriod, saveReplayStepPeriod } from '../replay/step-preferences'
import { ctraderReplayChartNeedsReload } from '../replay/ctrader-replay-datafeed'
import { CTRADER_TIMEFRAMES } from '../market-data/intervals'
import { classifyRiskPrice, estimateRiskPnl } from '../simulation/risk-price'
import { useSimulationController } from '../simulation/useSimulationController'
import type { SimulationTrade } from '../simulation/models'
import './app.css'

function tradeOverlay(trade: SimulationTrade): SimulationTradeLabel {
  const direction = trade.positionSide === 'long' ? '多' : '空'
  const labels: Record<SimulationTrade['action'], string> = {
    open: `开${direction}`,
    add: `加${direction}`,
    reduce: `减${direction}`,
    close: `平${direction}`,
    take_profit: `${direction}仓止盈`,
    stop_loss: `${direction}仓止损`,
    liquidation: `${direction}仓强平`,
  }
  return {
    timestamp: trade.timestamp,
    label: labels[trade.action],
    color: trade.side === 'buy' ? SIMULATION_BUY_COLOR : SIMULATION_SELL_COLOR,
  }
}

function simulationPriceText(price: number, precision: number): string {
  return price.toFixed(Math.min(20, Math.max(0, precision)))
}

function activeSymbol(): MarketSelection['symbol'] {
  const saved = readSelectedSymbol()
  return saved?.exchange === 'CTRADER' ? saved : DEFAULT_CTRADER_SYMBOL
}

function activeStepPeriod(): ReturnType<typeof readReplayStepPeriod> {
  const saved = readReplayStepPeriod()
  return CTRADER_TIMEFRAMES.find(period => period === saved) ?? '1m'
}

const connectionLabels: Record<LiveMarketStatus['connection'], string> = {
  connected: '已连接', connecting: '连接中', reconnecting: '正在重连', disconnected: '已断开',
}

export default function App({ runtime }: { runtime?: MarketDataRuntime } = {}) {
  const [mode, setMode] = useState<WorkstationMode>('history')
  const shellRef = useRef<HTMLElement | null>(null)
  const [layout, setLayout] = useState(loadWorkspacePreferences)
  const [workspaceMenu, setWorkspaceMenu] = useState(false)
  const [chartSizeOpen, setChartSizeOpen] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [mobile, setMobile] = useState(() => (window.matchMedia?.('(max-width: 767px), (max-width: 1023px) and (max-height: 520px)')?.matches ?? false))
  const [mobilePanel, setMobilePanel] = useState<'order' | 'dock' | null>(null)
  const [dockTab, setDockTab] = useState<TradingTab>('positions')
  const [layoutError, setLayoutError] = useState('')
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const mobileOpener = useRef<HTMLElement | null>(null)
  function updateLayout(change: (current: WorkspacePreferences) => WorkspacePreferences): void {
    const next = change(layoutRef.current)
    layoutRef.current = next
    setLayout(next)
    try { saveWorkspacePreferences(next); setLayoutError('') }
    catch (error) { setLayoutError(`保存工作区失败：${error instanceof Error ? error.message : String(error)}`) }
  }
  function setPanel(panel: 'account' | 'order' | 'dock', visible: boolean) {
    setFocusMode(false)
    updateLayout(current => ({ ...current, panels: { ...current.panels, [panel]: visible } }))
  }
  function openMobilePanel(panel: 'order' | 'dock', opener?: HTMLElement) {
    if (mobilePanel === panel) { closeMobilePanel(); return }
    mobileOpener.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setPanel(panel, true)
    setMobilePanel(panel)
  }
  function closeMobilePanel() { setMobilePanel(null); mobileOpener.current?.focus() }
  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 767px), (max-width: 1023px) and (max-height: 520px)')
    if (!query) return
    const change = () => { setMobile(query.matches); setMobilePanel(null) }
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    if (!mobile || mobilePanel === null) return
    const panel = document.querySelector<HTMLElement>('[data-mobile-open="true"]')
    panel?.querySelector<HTMLElement>('button, input, select')?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMobilePanel(null); mobileOpener.current?.focus() }
      if (event.key === 'Tab') {
        const buttons = [...(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [href]') ?? [])]
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus() }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [mobile, mobilePanel])
  const [dataManagerOpen, setDataManagerOpen] = useState(false)
  const [marketRuntime] = useState(() => runtime ?? createMarketDataRuntime())
  const [chartWindows] = useState(() => new ChartWindowHost(marketRuntime))
  const [popupBlocked, setPopupBlocked] = useState(false)
  const [configEpoch, setConfigEpoch] = useState(0)
  const [marketSelection, setMarketSelection] = useState<MarketSelection>(() => ({
    symbol: activeSymbol(),
    period: DEFAULT_CTRADER_PERIOD,
  }))
  const [marketWarning, setMarketWarning] = useState('')
  const [replayHistoryStatus, setReplayHistoryStatus] = useState('')
  const [liveStatus, setLiveStatus] = useState<LiveMarketStatus>({
    ...INITIAL_LIVE_STATUS,
  })
  const [chartReloadKey, setChartReloadKey] = useState(0)
  const [chartReplayStartTime, setChartReplayStartTime] =
    useState<number | null>(null)
  const [chartJumpRequest, setChartJumpRequest] = useState<{
    id: string
    timestamp: number
    previewReplay: boolean
  } | null>(null)
  const previousReplayContextRef = useRef<ReplayContext | null>(null)
  const [stepPeriod, setStepPeriod] = useState(activeStepPeriod)
  const [showTradeOverlays, setShowTradeOverlays] = useState(readShowTradeOverlays)
  const replay = useCTraderReplayController(marketRuntime, stepPeriod)
  const chartWindowsReady = useRef(false)
  const simulationController = useSimulationController(marketRuntime, replay)
  const simulation = { ...simulationController, busy: simulationController.busy || replay.busy }
  const replaySessionRef = useRef(replay.session)
  const deferredCloudSymbolRef = useRef<MarketSelection['symbol'] | null>(null)
  replaySessionRef.current = replay.session
  useEffect(() => {
    const restored = (event: Event) => {
      setStepPeriod(activeStepPeriod())
      setShowTradeOverlays(readShowTradeOverlays())
      if ((event as CustomEvent<{ source: string }>).detail?.source !== 'cloud') return
      const nextLayout = loadWorkspacePreferences()
      layoutRef.current = nextLayout
      setLayout(nextLayout)
      setFocusMode(false)
      const symbol = activeSymbol()
      if (replaySessionRef.current !== null) deferredCloudSymbolRef.current = symbol
      else setMarketSelection(current => ({ ...current, symbol }))
      setConfigEpoch(current => current + 1)
    }
    window.addEventListener(PREFERENCES_RESTORED, restored)
    return () => window.removeEventListener(PREFERENCES_RESTORED, restored)
  }, [marketRuntime])
  const simulationOverlays = useMemo<SimulationOverlayState>(() => {
    const currentTime = mode === 'history' && replay.session
      ? sessionVisibleUntil(replay.session) - 1
      : null
    const state = simulation.state
    if (currentTime === null || state === null || state.sessionId !== replay.session?.id) {
      return { currentTime, positions: [], trades: [] }
    }
    const precision = marketSelection.symbol.pricePrecision ?? 8
    const feeRate = state.config.feeRate
    return {
      currentTime,
      positions: state.positions.map(position => {
        const priceText = (price: number) => simulationPriceText(price, precision)
        const previewEntryRisk = (price: number) =>
          classifyRiskPrice(position.side, Number(position.lastPrice), Number(priceText(price)))
        const onTakeProfitPriceDrag = simulation.busy ? undefined : (price: number) =>
          simulation.setTakeProfit(position.side, priceText(price))
        const onStopLossPriceDrag = simulation.busy ? undefined : (price: number) =>
          simulation.setStopLoss(position.side, priceText(price))
        return {
          side: position.side,
          entryPrice: Number(position.entryPrice),
          takeProfitPrice: position.takeProfitPrice === null ? null : Number(position.takeProfitPrice),
          stopLossPrice: position.stopLossPrice === null ? null : Number(position.stopLossPrice),
          liquidationPrice: Number(position.liquidationPrice),
          unrealizedPnl: position.unrealizedPnl,
          estimateRiskPnl: (price: number) => estimateRiskPnl(position, new Decimal(priceText(price)), feeRate).toNumber(),
          previewEntryRisk,
          onTakeProfitPriceDrag,
          onStopLossPriceDrag,
          onEntryPriceDrag: simulation.busy ? undefined : (price: number) => {
            const target = previewEntryRisk(price)
            if (target === 'take-profit') onTakeProfitPriceDrag?.(price)
            else if (target === 'stop-loss') onStopLossPriceDrag?.(price)
          },
        }
      }),
      trades: state.trades.slice(-100).map(tradeOverlay),
    }
  }, [
    marketSelection.symbol.pricePrecision,
    mode,
    replay.session,
    simulation.busy,
    simulation.setStopLoss,
    simulation.setTakeProfit,
    simulation.state,
  ])

  const syncMarketSelection = useCallback((next: MarketSelection, userSelectedSymbol = false): void => {
    const active = replaySessionRef.current
    if (
      active !== null &&
      active.symbol.ticker !== next.symbol.ticker
    ) {
      setMarketWarning('回放会话进行中，不能切换交易对。')
      setChartReloadKey((current) => current + 1)
      return
    }
    if (userSelectedSymbol && active === null) saveSelectedSymbol(next.symbol)
    setMarketSelection((current) =>
      !userSelectedSymbol && current.symbol.ticker === next.symbol.ticker &&
      current.period.text === next.period.text
        ? current
        : next,
    )
  }, [])

  const jumpChartToTime = useCallback((timestamp: number, previewReplay = false): void => {
    setMarketWarning('')
    setChartJumpRequest({
      id: crypto.randomUUID(),
      timestamp,
      previewReplay,
    })
  }, [])

  const locateLatestChartTime = useCallback((): void => {
    const session = replaySessionRef.current
    const timestamp = mode === 'history' && session !== null
      ? sessionVisibleUntil(session) - 1
      : Date.now()
    jumpChartToTime(timestamp)
  }, [jumpChartToTime, mode])

  const completeChartTimeJump = useCallback(
    (timestamp: number | null): void => {
      if (timestamp === null) {
        setMarketWarning('所选时间附近没有可显示的 K 线。')
        return
      }
      setChartReplayStartTime(timestamp)
      setMarketWarning(
        `图表已跳转到 ${formatDisplayTime(timestamp)}`,
      )
    },
    [],
  )

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const update = () => {
      document.documentElement.style.setProperty('--workspace-viewport-height', `${viewport.height}px`)
      document.documentElement.style.setProperty('--workspace-viewport-top', `${viewport.offsetTop}px`)
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      document.documentElement.style.removeProperty('--workspace-viewport-height')
      document.documentElement.style.removeProperty('--workspace-viewport-top')
    }
  }, [])

  useEffect(() => {
    marketRuntime.replayDatafeed.setSelectionListener(syncMarketSelection)
    marketRuntime.replayDatafeed.setWarningListener(setMarketWarning)
    marketRuntime.replayDatafeed.setHistoryStatusListener(setReplayHistoryStatus)
    return () => {
      marketRuntime.replayDatafeed.setSelectionListener()
      marketRuntime.replayDatafeed.setWarningListener()
      marketRuntime.replayDatafeed.setHistoryStatusListener()
    }
  }, [marketRuntime, syncMarketSelection])

  useEffect(() => {
    marketRuntime.datafeed.setLiveStatusListener(setLiveStatus)
    marketRuntime.datafeed.setReconnectListener(() => setChartReloadKey(current => current + 1))
    return () => {
      marketRuntime.datafeed.setLiveStatusListener()
      marketRuntime.datafeed.setReconnectListener()
    }
  }, [marketRuntime])

  useEffect(() => {
    marketRuntime.datafeed.setLiveEnabled(mode === 'live')
    return () => marketRuntime.datafeed.setLiveEnabled(false)
  }, [marketRuntime, mode])

  useEffect(() => {
    if (replay.session !== null) {
      const preferred = activeSymbol()
      if (preferred && preferred.ticker !== replay.session.symbol.ticker) deferredCloudSymbolRef.current = preferred
      setMarketSelection({
        symbol: replay.session.symbol,
        period: replay.session.period,
      })
    } else if (deferredCloudSymbolRef.current !== null) {
      const symbol = deferredCloudSymbolRef.current
      deferredCloudSymbolRef.current = null
      setMarketSelection(current => ({ ...current, symbol }))
    }
  }, [replay.session?.id])

  useLayoutEffect(() => chartWindows.listen(), [chartWindows])

  useLayoutEffect(() => {
    const activeReplay = mode === 'history' ? replay.session : null
    const nextContext: ReplayContext | null =
      activeReplay !== null
        ? {
            sessionId: activeReplay.id,
            symbol: activeReplay.symbol.ticker.toUpperCase(),
            timeframe: replaySourceTimeframe(activeReplay),
            currentTime: activeReplay.currentTime,
            visibleUntil: activeReplay.visibleUntil,
            endTime: activeReplay.endTime,
          }
        : null
    const previous = previousReplayContextRef.current
    const reloadAfterStep = previous !== null && nextContext !== null &&
      previous.sessionId === nextContext.sessionId && ctraderReplayChartNeedsReload(previous, nextContext, marketSelection.period.text)
    marketRuntime.replayDatafeed.setReplayContext(nextContext, reloadAfterStep)
    if (!replay.busy) chartWindowsReady.current = true
    if (chartWindowsReady.current) {
      chartWindows.publish({
        symbol: activeReplay?.symbol ?? marketSelection.symbol,
        period: marketSelection.period,
        mode,
        replay: nextContext,
        simulationOverlays,
        configRevision: configEpoch,
      })
    }
    if (previous !== null && nextContext === null) {
      setMarketWarning('')
    }
    const needsReload =
      reloadAfterStep || (previous === null) !== (nextContext === null) ||
      (previous !== null &&
        nextContext !== null &&
        (previous.sessionId !== nextContext.sessionId ||
          replayVisibleUntil(nextContext) < replayVisibleUntil(previous)))
    if (needsReload) {
      setChartReloadKey((current) => current + 1)
    }
    previousReplayContextRef.current = nextContext
  }, [chartWindows, configEpoch, marketRuntime, marketSelection, mode, replay.busy, replay.session, simulationOverlays])

  function changeMode(nextMode: WorkstationMode): void {
    if (nextMode === 'live') {
      replay.pause()
    }
    setMode(nextMode)
    setMobilePanel(null)
  }

  function applyMarketSelection(next: MarketSelection): void {
    if (
      replay.session !== null &&
      replay.session.symbol.ticker !== next.symbol.ticker
    ) {
      if (!window.confirm('切换交易对需要结束当前回放会话，是否继续？')) {
        return
      }
      deferredCloudSymbolRef.current = null
      void replay.endSession().then(() => {
        saveSelectedSymbol(next.symbol)
        setMarketSelection(next)
      })
      return
    }
    if (replay.session === null) saveSelectedSymbol(next.symbol)
    setMarketSelection(next)
  }

  useLayoutEffect(() => {
    const shell = shellRef.current
    if (shell === null) return
    const regions = [
      ['.status-footer', '--workspace-status-height'],
      ['.mobile-workspace-nav', '--workspace-nav-height'],
      ['.replay-region', '--workspace-replay-height'],
    ] as const
    const measure = () => {
      for (const [selector, property] of regions) {
        const height = shell.querySelector<HTMLElement>(selector)?.getBoundingClientRect().height ?? 0
        if (height > 0) shell.style.setProperty(property, `${Math.ceil(height)}px`)
      }
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    for (const [selector] of regions) {
      const region = shell.querySelector(selector)
      if (region) observer?.observe(region)
    }
    return () => observer?.disconnect()
  }, [])

  const chartHeight = mobile ? layout.mobileChartHeight : layout.chartHeight
  const simulationCurrency = replay.session?.symbol.priceCurrency ?? ''
  const visible = (panel: keyof WorkspacePreferences['panels']) => !focusMode && layout.panels[panel]
  return (
    <main ref={shellRef} className="app-shell workspace-shell">
      <header className="app-header">
        <h1><span className="desktop-brand">cTrader 行情回放工作站</span><span className="mobile-brand">cTrader 工作站</span></h1>
        <ModeSwitch mode={mode} onChange={changeMode} />
        <WorkspaceTools>
          {!mobile && <button type="button" onClick={() => setPopupBlocked(openChartWindow() === null)}>打开副图</button>}
          <button type="button" aria-expanded={chartSizeOpen} onClick={() => setChartSizeOpen(true)}>图表尺寸</button>
          <button type="button" className="focus-mode-button" aria-pressed={focusMode} onClick={() => { setFocusMode(current => !current); setMobilePanel(null) }}>{focusMode ? '退出专注' : '专注看图'}</button>
          <hr />
          <button type="button" aria-expanded={workspaceMenu} onClick={() => setWorkspaceMenu(true)}>工作区</button>
          <button type="button" data-testid="open-data-manager" onClick={() => setDataManagerOpen(true)}>数据管理</button>
          {marketRuntime.accountSelection && <CTraderAccountPicker selection={marketRuntime.accountSelection} busy={simulation.busy} />}
        </WorkspaceTools>
      </header>
      {popupBlocked && !mobile && <div className="chart-popup-warning" role="alert">浏览器拦截了副图窗口，请允许此站点弹出窗口后重试。</div>}
      {marketRuntime.configSync && <ConfigSyncStatus service={marketRuntime.configSync} />}
      <div
        data-testid={mode === 'history' ? 'simulation-panel' : 'live-workspace'}
        className={`workspace-content${visible('order') ? '' : ' is-order-hidden'}${focusMode ? ' is-focus-mode' : ''}`}
      >
        <div className="workspace-account" hidden={focusMode}>
          <div id="workspace-account-content" hidden={!visible('account')}>
            {mode === 'history' ? <AccountStrip state={simulation.state} currency={simulationCurrency} onClose={() => setPanel('account', false)} /> : <section className="account-strip" aria-label="实时行情摘要"><span>{marketSelection.symbol.ticker}</span><span>最新价格 <strong>{liveStatus.lastPrice ?? '—'}</strong></span><span>{connectionLabels[liveStatus.connection]} · 实时只读</span><PanelToggle label="账户摘要" expanded controls="workspace-account-content" onToggle={() => setPanel('account', false)} className="panel-close" /></section>}
          </div>
          {!visible('account') && <PanelToggle label="账户摘要" expanded={false} showLabel controls="workspace-account-content" onToggle={() => setPanel('account', true)} className="collapsed-panel-handle" />}
        </div>
        <div className="chart-region">
          <ChartWorkspace
            key={configEpoch}
            datafeed={marketRuntime.replayDatafeed}
            jumpRequest={chartJumpRequest}
            onJumpComplete={completeChartTimeJump}
            onReplayStartTimeChange={setChartReplayStartTime}
            onSelectionChange={syncMarketSelection}
            period={marketSelection.period}
            reloadKey={chartReloadKey}
            simulationOverlays={simulationOverlays}
            showTradeOverlays={showTradeOverlays}
            drawingStore={marketRuntime.drawings}
            drawingScope={drawingScope(mode, marketSelection.symbol.ticker, replay.session?.id ?? null, marketSelection.symbol.exchange)}
            symbol={marketSelection.symbol}
            layoutSettingsOpen={chartSizeOpen}
            onCloseLayoutSettings={() => setChartSizeOpen(false)}
            chartHeight={chartHeight}
            onChartHeightChange={height => updateLayout(current => ({ ...current, [mobile ? 'mobileChartHeight' : 'chartHeight']: height }))}
          />
          <div className="replay-region">
            <div id="workspace-replay-content" className="replay-content">
              {mode === 'history' ? <ReplayControls
                chartStartTime={chartReplayStartTime}
                interactionLocked={simulation.busy}
                onJumpToTime={timestamp => jumpChartToTime(timestamp, replay.session === null)}
                onLocateLatest={locateLatestChartTime}
                replay={replay}
                selection={marketSelection}
                stepPeriod={stepPeriod}
                onStepPeriodChange={period => { saveReplayStepPeriod(period); setStepPeriod(period) }}
                showTradeOverlays={showTradeOverlays}
                onTradeOverlaysChange={visible => { saveShowTradeOverlays(visible); setShowTradeOverlays(visible) }}
              /> : <section className="replay-controls live-time-controls"><TimeJumpControl compact onJump={jumpChartToTime} onLocateLatest={locateLatestChartTime} /></section>}
            </div>
          </div>
        </div>
        <div className="order-expander" hidden={mobile || focusMode || visible('order')}>
          <PanelToggle label="下单面板" expanded={false} controls="workspace-order-content" direction="right" showLabel onToggle={() => setPanel('order', true)} />
        </div>
        <div id="workspace-order-content" className="order-region" hidden={!visible('order')} data-mobile-open={mobile && mobilePanel === 'order' || undefined}>
          {mode === 'history' ? <SimulationOrder session={replay.session} simulation={simulation} onClose={() => mobile ? closeMobilePanel() : setPanel('order', false)} /> : <><header className="panel-heading"><h2>行情状态</h2><PanelToggle label="下单面板" expanded controls="workspace-order-content" direction="right" onToggle={() => mobile ? closeMobilePanel() : setPanel('order', false)} /></header><LiveStatus status={liveStatus} /></>}
        </div>
        <div id="workspace-dock-content" className="dock-region" hidden={mode !== 'history' || !visible('dock')} data-mobile-open={mobile && mobilePanel === 'dock' || undefined}>
          <SimulationDock simulation={simulation} currency={simulationCurrency} pricePrecision={replay.session?.symbol.pricePrecision} tab={dockTab} onTabChange={setDockTab} onClose={() => mobile ? closeMobilePanel() : setPanel('dock', false)} />
        </div>
        <div className="dock-expander" hidden={mobile || mode !== 'history' || focusMode || visible('dock')}>
          <PanelToggle label="持仓面板" expanded={false} controls="workspace-dock-content" direction="down" showLabel onToggle={() => setPanel('dock', true)} className="collapsed-panel-handle" />
        </div>
      </div>
      {mobile && mobilePanel && <div className="mobile-panel-backdrop" onClick={closeMobilePanel} aria-hidden="true" />}
      <footer className="status-footer" role="contentinfo">
        <span id="workspace-status-content">{marketSelection.symbol.ticker} · {marketSelection.period.text}{replay.session !== null ? ` · 回放第 ${replay.session.currentIndex + 1} 步` : ''}<span role="status">{[replayHistoryStatus, marketWarning, mode === 'live' ? liveStatus.warning : ''].filter(Boolean).map(message => ` · ${message}`).join('')}</span></span>
        <span>{mode === 'history' ? '历史训练模拟' : '实时只读'}</span>
      </footer>
      <nav className="mobile-workspace-nav" aria-label="工作台快捷操作">
        <button type="button" aria-pressed={mobilePanel === null} onClick={closeMobilePanel}>看图</button>
        <button type="button" aria-pressed={mobilePanel === 'order'} aria-expanded={mobilePanel === 'order'} aria-controls="workspace-order-content" onClick={event => openMobilePanel('order', event.currentTarget)}>{mode === 'history' ? '下单' : '行情状态'}<span aria-hidden="true" className="mobile-panel-chevron">{mobilePanel === 'order' ? '⌄' : '⌃'}</span></button>
        {mode === 'history' && <button type="button" aria-pressed={mobilePanel === 'dock'} aria-expanded={mobilePanel === 'dock'} aria-controls="workspace-dock-content" onClick={event => { setDockTab('positions'); openMobilePanel('dock', event.currentTarget) }}>持仓 ({simulation.state?.positions.length ?? 0})<span aria-hidden="true" className="mobile-panel-chevron">{mobilePanel === 'dock' ? '⌄' : '⌃'}</span></button>}
        <button type="button" onClick={() => setWorkspaceMenu(true)}>更多</button>
      </nav>
      <WorkspaceDialog open={workspaceMenu} title="工作区面板" onClose={() => setWorkspaceMenu(false)}>
        <p className="muted-text">账户、下单和持仓面板可展开或收起；回放控制和底部状态常驻。桌面和手机分别保存图表高度。</p>
        <div className="workspace-panel-toggles">{([['account', '账户摘要'], ['order', '下单面板'], ['dock', '持仓与复盘']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={layout.panels[key]} onChange={event => setPanel(key, event.target.checked)} />{label}</label>)}</div>
        <div className="button-row"><button type="button" onClick={() => { setFocusMode(false); updateLayout(current => ({ ...current, panels: { ...current.panels, account: true, order: true, dock: true } })) }}>显示全部面板</button><button type="button" onClick={() => { setFocusMode(false); updateLayout(() => structuredClone(DEFAULT_WORKSPACE_PREFERENCES)) }}>恢复默认布局</button></div>
        <button type="button" className="dialog-done" onClick={() => { setWorkspaceMenu(false); setChartSizeOpen(true) }}>调整图表与指标高度</button>
        {layoutError && <p role="alert" className="panel-error">{layoutError}</p>}
      </WorkspaceDialog>
      <DataManager configurationRevision={configEpoch} onApplySelection={applyMarketSelection} onClose={() => setDataManagerOpen(false)} open={dataManagerOpen} runtime={marketRuntime} selection={marketSelection} />
    </main>
  )
}
