import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import {
  DEFAULT_SYMBOL,
  SUPPORTED_PERIODS,
} from '../chart/chart-config'
import { ChartWorkspace } from '../chart/ChartWorkspace'
import type {
  SimulationOverlayState,
  SimulationTradeOverlay,
} from '../chart/pro-chart-adapter'
import {
  ModeSwitch,
  type WorkstationMode,
} from '../components/ModeSwitch'
import { DataManager } from '../components/DataManager'
import { HistoryUploadStatus } from '../components/HistoryUploadStatus'
import { ReplayControls } from '../components/ReplayControls'
import { TimeJumpControl } from '../components/TimeJumpControl'
import { LiveStatus } from '../components/panels'
import { AccountStrip, SimulationOrder, SimulationDock, type TradingTab } from '../components/TradingWorkspace'
import { WorkspaceDialog } from '../components/WorkspaceDialog'
import { PanelToggle } from '../components/PanelToggle'
import { loadWorkspacePreferences, saveWorkspacePreferences, DEFAULT_WORKSPACE_PREFERENCES, type WorkspacePreferences } from '../workspace/preferences'
import type { MarketSelection } from '../market-data/models'
import { readSelectedSymbol, saveSelectedSymbol } from '../market-data/symbol-preferences'
import { nextOpenTime } from '../market-data/intervals'
import {
  INITIAL_LIVE_STATUS,
  type LiveMarketStatus,
} from '../market-data/live-models'
import { createMarketDataRuntime } from '../market-data/runtime'
import type { ReplayContext } from '../replay/models'
import { useReplayController } from '../replay/useReplayController'
import { classifyRiskPrice } from '../simulation/risk-price'
import { useSimulationController } from '../simulation/useSimulationController'
import type { SimulationTrade } from '../simulation/models'
import './app.css'

function tradeOverlay(trade: SimulationTrade): SimulationTradeOverlay {
  const labels: Record<SimulationTrade['action'], string> = {
    open: '开仓',
    add: '加仓',
    reduce: '减仓',
    close: '平仓',
    take_profit: '止盈',
    stop_loss: '止损',
    liquidation: '强平',
  }
  const colors: Record<SimulationTrade['action'], string> = {
    open: trade.positionSide === 'long' ? '#4fd49f' : '#ff7f79',
    add: trade.positionSide === 'long' ? '#4fd49f' : '#ff7f79',
    reduce: '#55b8ff',
    close: '#55b8ff',
    take_profit: '#4fd49f',
    stop_loss: '#ff7f79',
    liquidation: '#f5a65b',
  }
  return {
    id: trade.tradeId,
    timestamp: trade.timestamp,
    price: Number(trade.price),
    label: `${labels[trade.action]} ${trade.quantity} @ ${trade.price}`,
    tooltip: [
      new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'short',
        timeStyle: 'medium',
        hour12: false,
      }).format(trade.timestamp),
      trade.positionSide === 'long' ? '多仓' : '空仓',
      labels[trade.action],
      `${trade.quantity} @ ${trade.price}`,
      `手续费 ${trade.fee}`,
      `原因 ${trade.reason}`,
      `已实现盈亏 ${trade.realizedPnl}`,
    ].join(' · '),
    color: colors[trade.action],
  }
}

function simulationPriceText(price: number, precision: number): string {
  return price.toFixed(Math.min(20, Math.max(0, precision)))
}

export default function App() {
  const [mode, setMode] = useState<WorkstationMode>('history')
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
  const dockDrag = useRef<{ y: number; height: number } | null>(null)
  const mobileOpener = useRef<HTMLElement | null>(null)
  function updateLayout(change: (current: WorkspacePreferences) => WorkspacePreferences): void {
    const next = change(layoutRef.current)
    layoutRef.current = next
    setLayout(next)
    try { saveWorkspacePreferences(next); setLayoutError('') }
    catch (error) { setLayoutError(`保存工作区失败：${error instanceof Error ? error.message : String(error)}`) }
  }
  function setPanel(panel: keyof WorkspacePreferences['panels'], visible: boolean) {
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
  const [marketRuntime] = useState(createMarketDataRuntime)
  const [marketSelection, setMarketSelection] = useState<MarketSelection>(() => ({
    symbol: readSelectedSymbol() ?? DEFAULT_SYMBOL,
    period: SUPPORTED_PERIODS[3],
  }))
  const [marketWarning, setMarketWarning] = useState('')
  const [liveStatus, setLiveStatus] = useState<LiveMarketStatus>({
    ...INITIAL_LIVE_STATUS,
  })
  const [chartReloadKey, setChartReloadKey] = useState(0)
  const [chartRightmostCandleTime, setChartRightmostCandleTime] =
    useState<number | null>(null)
  const [chartJumpRequest, setChartJumpRequest] = useState<{
    id: string
    timestamp: number
  } | null>(null)
  const previousReplayContextRef = useRef<ReplayContext | null>(null)
  const replay = useReplayController(marketRuntime)
  const simulation = useSimulationController(marketRuntime, replay)
  const replaySessionRef = useRef(replay.session)
  replaySessionRef.current = replay.session
  const simulationOverlays = useMemo<SimulationOverlayState>(() => {
    if (mode !== 'history') return { currentTime: null, positions: [], trades: [] }
    const precision = marketSelection.symbol.pricePrecision ?? 8
    return {
      currentTime: replay.session?.currentTime ?? null,
      positions: (simulation.state?.positions ?? []).map(position => {
        const onTakeProfitPriceDrag = simulation.busy ? undefined : (price: number) =>
          simulation.setTakeProfit(position.side, simulationPriceText(price, precision))
        const onStopLossPriceDrag = simulation.busy ? undefined : (price: number) =>
          simulation.setStopLoss(position.side, simulationPriceText(price, precision))
        return {
          side: position.side,
          entryPrice: Number(position.entryPrice),
          takeProfitPrice: position.takeProfitPrice === null ? null : Number(position.takeProfitPrice),
          stopLossPrice: position.stopLossPrice === null ? null : Number(position.stopLossPrice),
          liquidationPrice: Number(position.liquidationPrice),
          onTakeProfitPriceDrag,
          onStopLossPriceDrag,
          onEntryPriceDrag: simulation.busy ? undefined : (price: number) => {
            const target = classifyRiskPrice(position.side, Number(position.lastPrice), price)
            if (target === 'take-profit') onTakeProfitPriceDrag?.(price)
            else if (target === 'stop-loss') onStopLossPriceDrag?.(price)
          },
        }
      }),
      trades: (simulation.state?.trades ?? []).slice(-100).map(tradeOverlay),
    }
  }, [
    marketSelection.symbol.pricePrecision,
    mode,
    replay.session?.currentTime,
    simulation.busy,
    simulation.setStopLoss,
    simulation.setTakeProfit,
    simulation.state,
  ])

  const syncMarketSelection = useCallback((next: MarketSelection): void => {
    const active = replaySessionRef.current
    if (
      active !== null &&
      active.symbol.ticker !== next.symbol.ticker
    ) {
      setMarketWarning('回放会话进行中，不能切换交易对。')
      setChartReloadKey((current) => current + 1)
      return
    }
    setMarketSelection((current) =>
      current.symbol.ticker === next.symbol.ticker &&
      current.period.text === next.period.text
        ? current
        : next,
    )
  }, [])

  const jumpChartToTime = useCallback((timestamp: number): void => {
    setMarketWarning('')
    setChartJumpRequest({
      id: crypto.randomUUID(),
      timestamp,
    })
  }, [])

  const locateLatestChartTime = useCallback((): void => {
    const session = replaySessionRef.current
    const timestamp = mode === 'history' && session !== null
      ? nextOpenTime(session.currentTime, session.period.text) - 1
      : Date.now()
    jumpChartToTime(timestamp)
  }, [jumpChartToTime, mode])

  const completeChartTimeJump = useCallback(
    (timestamp: number | null): void => {
      if (timestamp === null) {
        setMarketWarning('所选时间附近没有可显示的 K 线。')
        return
      }
      setMarketWarning(
        `图表已跳转到 ${new Intl.DateTimeFormat('zh-CN', {
          dateStyle: 'short',
          timeStyle: 'short',
          hour12: false,
        }).format(timestamp)}`,
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
    saveSelectedSymbol(marketSelection.symbol)
  }, [marketSelection.symbol])

  useEffect(() => {
    marketRuntime.replayDatafeed.setSelectionListener(syncMarketSelection)
    marketRuntime.replayDatafeed.setWarningListener(setMarketWarning)
    return () => {
      marketRuntime.replayDatafeed.setSelectionListener()
      marketRuntime.replayDatafeed.setWarningListener()
    }
  }, [marketRuntime, syncMarketSelection])

  useEffect(() => {
    marketRuntime.datafeed.setLiveStatusListener(setLiveStatus)
    return () => marketRuntime.datafeed.setLiveStatusListener()
  }, [marketRuntime])

  useEffect(() => {
    marketRuntime.datafeed.setLiveEnabled(mode === 'live')
    return () => marketRuntime.datafeed.setLiveEnabled(false)
  }, [marketRuntime, mode])

  useEffect(() => {
    if (replay.session !== null) {
      setMarketSelection({
        symbol: replay.session.symbol,
        period: replay.session.period,
      })
    }
  }, [replay.session?.id])

  useLayoutEffect(() => {
    const nextContext: ReplayContext | null =
      mode === 'history' && replay.session !== null
        ? {
            sessionId: replay.session.id,
            symbol: replay.session.symbol.ticker.toUpperCase(),
            timeframe: replay.session.period.text,
            currentTime: replay.session.currentTime,
            endTime: replay.session.endTime,
          }
        : null
    const previous = previousReplayContextRef.current
    marketRuntime.replayDatafeed.setReplayContext(nextContext)
    if (previous !== null && nextContext === null) {
      setMarketWarning('')
    }
    const needsReload =
      (previous === null) !== (nextContext === null) ||
      (previous !== null &&
        nextContext !== null &&
        (previous.sessionId !== nextContext.sessionId ||
          nextContext.currentTime < previous.currentTime))
    if (needsReload) {
      setChartReloadKey((current) => current + 1)
    }
    previousReplayContextRef.current = nextContext
  }, [marketRuntime, mode, replay.session])

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
      void replay.endSession().then(() => setMarketSelection(next))
      return
    }
    setMarketSelection(next)
  }

  const chartHeight = mobile ? layout.mobileChartHeight : layout.chartHeight
  const visible = (panel: keyof WorkspacePreferences['panels']) => !focusMode && layout.panels[panel]
  return (
    <main className={`app-shell workspace-shell${chartHeight === null ? '' : ' fixed-chart-height'}`}>
      <header className="app-header">
        <h1><span className="desktop-brand">加密货币合约回放工作站</span><span className="mobile-brand">合约工作站</span></h1>
        <ModeSwitch mode={mode} onChange={changeMode} />
        <div className="workspace-nav">
          <button type="button" data-testid="open-data-manager" onClick={() => setDataManagerOpen(true)}>数据管理</button>
          <button type="button" aria-expanded={chartSizeOpen} onClick={() => setChartSizeOpen(true)}>图表尺寸</button>
          <button type="button" aria-expanded={workspaceMenu} onClick={() => setWorkspaceMenu(true)}>工作区</button>
          <button type="button" className="focus-mode-button" aria-pressed={focusMode} onClick={() => { setFocusMode(current => !current); setMobilePanel(null) }}>{focusMode ? '退出专注' : '专注看图'}</button>
        </div>
      </header>
      <div
        data-testid={mode === 'history' ? 'simulation-panel' : 'live-workspace'}
        className={`workspace-content${visible('order') ? '' : ' is-order-hidden'}${chartHeight === null ? '' : ' has-fixed-chart'}${focusMode ? ' is-focus-mode' : ''}`}
        style={{ '--workspace-chart-height': chartHeight === null ? undefined : `${chartHeight}px`, '--workspace-dock-height': `${layout.dockHeight}px` } as CSSProperties}
      >
        <div className="workspace-account" hidden={focusMode}>
          <div id="workspace-account-content" hidden={!visible('account')}>
            {mode === 'history' ? <AccountStrip state={simulation.state} onClose={() => setPanel('account', false)} /> : <section className="account-strip" aria-label="实时行情摘要"><span>{marketSelection.symbol.ticker}</span><span>最新价格 <strong>{liveStatus.lastPrice ?? '—'}</strong></span><span>{liveStatus.connection === 'connected' ? '已连接' : '连接中'} · 实时只读</span><PanelToggle label="账户摘要" expanded controls="workspace-account-content" onToggle={() => setPanel('account', false)} className="panel-close" /></section>}
          </div>
          {!visible('account') && <PanelToggle label="账户摘要" expanded={false} showLabel controls="workspace-account-content" onToggle={() => setPanel('account', true)} className="collapsed-panel-handle" />}
        </div>
        <div className="chart-region">
          <ChartWorkspace
            datafeed={marketRuntime.replayDatafeed}
            jumpRequest={chartJumpRequest}
            onJumpComplete={completeChartTimeJump}
            onRightmostCandleTimeChange={setChartRightmostCandleTime}
            onSelectionChange={syncMarketSelection}
            period={marketSelection.period}
            reloadKey={chartReloadKey}
            simulationOverlays={simulationOverlays}
            symbol={marketSelection.symbol}
            layoutSettingsOpen={chartSizeOpen}
            onCloseLayoutSettings={() => setChartSizeOpen(false)}
            chartHeight={chartHeight}
            onChartHeightChange={height => updateLayout(current => ({ ...current, [mobile ? 'mobileChartHeight' : 'chartHeight']: height }))}
          />
          <div className="replay-region" hidden={focusMode}>
            <div id="workspace-replay-content" className="replay-content" hidden={!visible('replay')}>
              <PanelToggle label="回放控制" expanded controls="workspace-replay-content" direction="down" onToggle={() => setPanel('replay', false)} className="replay-close" />
              {mode === 'history' ? <ReplayControls chartStartTime={chartRightmostCandleTime} interactionLocked={simulation.busy} onJumpToTime={jumpChartToTime} onLocateLatest={locateLatestChartTime} replay={replay} selection={marketSelection} /> : <section className="replay-controls live-time-controls"><TimeJumpControl compact onJump={jumpChartToTime} onLocateLatest={locateLatestChartTime} /></section>}
            </div>
            {!visible('replay') && <PanelToggle label="回放控制" expanded={false} controls="workspace-replay-content" direction="down" showLabel onToggle={() => setPanel('replay', true)} className="collapsed-panel-handle" />}
          </div>
        </div>
        <div className="order-expander" hidden={mobile || focusMode || visible('order')}>
          <PanelToggle label="下单面板" expanded={false} controls="workspace-order-content" direction="right" showLabel onToggle={() => setPanel('order', true)} />
        </div>
        <div id="workspace-order-content" className="order-region" hidden={!visible('order')} data-mobile-open={mobile && mobilePanel === 'order' || undefined}>
          {mode === 'history' ? <SimulationOrder session={replay.session} simulation={simulation} onClose={() => mobile ? closeMobilePanel() : setPanel('order', false)} /> : <><header className="panel-heading"><h2>行情状态</h2><PanelToggle label="下单面板" expanded controls="workspace-order-content" direction="right" onToggle={() => mobile ? closeMobilePanel() : setPanel('order', false)} /></header><LiveStatus status={liveStatus} /></>}
        </div>
        <div id="workspace-dock-content" className="dock-region" hidden={mode !== 'history' || !visible('dock')} data-mobile-open={mobile && mobilePanel === 'dock' || undefined}>
          <div className="dock-resize-handle" role="separator" aria-label="持仓面板高度" aria-orientation="horizontal" aria-valuemin={160} aria-valuemax={480} aria-valuenow={layout.dockHeight} tabIndex={0}
            onPointerDown={event => { dockDrag.current = { y: event.clientY, height: layout.dockHeight }; event.currentTarget.setPointerCapture(event.pointerId) }}
            onPointerMove={event => { const drag = dockDrag.current; if (drag) updateLayout(current => ({ ...current, dockHeight: Math.max(160, Math.min(480, Math.round(drag.height + drag.y - event.clientY))) })) }}
            onPointerUp={() => { dockDrag.current = null }} onPointerCancel={() => { dockDrag.current = null }}
            onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); updateLayout(current => ({ ...current, dockHeight: Math.max(160, Math.min(480, current.dockHeight + (event.key === 'ArrowUp' ? 20 : -20))) })) } }}><span /></div>
          <SimulationDock simulation={simulation} tab={dockTab} onTabChange={setDockTab} onClose={() => mobile ? closeMobilePanel() : setPanel('dock', false)} />
        </div>
        <div className="dock-expander" hidden={mobile || mode !== 'history' || focusMode || visible('dock')}>
          <PanelToggle label="持仓面板" expanded={false} controls="workspace-dock-content" direction="down" showLabel onToggle={() => setPanel('dock', true)} className="collapsed-panel-handle" />
        </div>
      </div>
      {mobile && mobilePanel && <div className="mobile-panel-backdrop" onClick={closeMobilePanel} aria-hidden="true" />}
      <footer className="status-footer" hidden={focusMode}>
        <span id="workspace-status-content" hidden={!visible('status')}>{marketSelection.symbol.ticker} · {marketSelection.period.text}{replay.session !== null ? ` · 回放 ${replay.session.currentIndex + 1}/${replay.session.candleCount}` : ''}{marketWarning.length > 0 ? ` · ${marketWarning}` : ''}<HistoryUploadStatus service={marketRuntime.service} onOpen={() => setDataManagerOpen(true)} /></span>
        <span hidden={!visible('status')}>{mode === 'history' ? '历史训练模拟' : '实时只读'}</span><PanelToggle label="底部状态" expanded={visible('status')} controls="workspace-status-content" direction="down" showLabel={!visible('status')} onToggle={() => setPanel('status', !visible('status'))} className="panel-close" />
      </footer>
      <nav className="mobile-workspace-nav" aria-label="工作台快捷操作">
        <button type="button" aria-pressed={mobilePanel === null} onClick={closeMobilePanel}>看图</button>
        <button type="button" aria-pressed={mobilePanel === 'order'} aria-expanded={mobilePanel === 'order'} aria-controls="workspace-order-content" onClick={event => openMobilePanel('order', event.currentTarget)}>{mode === 'history' ? '下单' : '行情状态'}<span aria-hidden="true" className="mobile-panel-chevron">{mobilePanel === 'order' ? '⌄' : '⌃'}</span></button>
        {mode === 'history' && <button type="button" aria-pressed={mobilePanel === 'dock'} aria-expanded={mobilePanel === 'dock'} aria-controls="workspace-dock-content" onClick={event => { setDockTab('positions'); openMobilePanel('dock', event.currentTarget) }}>持仓 ({simulation.state?.positions.length ?? 0})<span aria-hidden="true" className="mobile-panel-chevron">{mobilePanel === 'dock' ? '⌄' : '⌃'}</span></button>}
        <button type="button" onClick={() => setWorkspaceMenu(true)}>更多</button>
      </nav>
      <WorkspaceDialog open={workspaceMenu} title="工作区面板" onClose={() => setWorkspaceMenu(false)}>
        <p className="muted-text">用面板上的箭头展开或收起，收起后原位保留展开入口；桌面和手机分别保存图表高度。</p>
        <div className="workspace-panel-toggles">{([['account', '账户摘要'], ['order', '下单面板'], ['dock', '持仓与复盘'], ['replay', '回放控制'], ['status', '底部状态']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={layout.panels[key]} onChange={event => setPanel(key, event.target.checked)} />{label}</label>)}</div>
        <label className="panel-field">持仓面板高度 · {layout.dockHeight}px<input type="range" min={160} max={480} step={10} aria-label="持仓面板高度" value={layout.dockHeight} onChange={event => updateLayout(current => ({ ...current, dockHeight: Number(event.target.value) }))} /></label>
        <div className="button-row"><button type="button" onClick={() => { setFocusMode(false); updateLayout(current => ({ ...current, panels: { account: true, order: true, dock: true, replay: true, status: true } })) }}>显示全部面板</button><button type="button" onClick={() => { setFocusMode(false); updateLayout(() => structuredClone(DEFAULT_WORKSPACE_PREFERENCES)) }}>恢复默认布局</button></div>
        <button type="button" className="dialog-done" onClick={() => { setWorkspaceMenu(false); setChartSizeOpen(true) }}>调整图表与指标高度</button>
        {layoutError && <p role="alert" className="panel-error">{layoutError}</p>}
      </WorkspaceDialog>
      <DataManager onApplySelection={applyMarketSelection} onClose={() => setDataManagerOpen(false)} open={dataManagerOpen} runtime={marketRuntime} selection={marketSelection} />
    </main>
  )
}
