import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import Decimal from 'decimal.js'
import { formatDisplayTime } from '../format-display-time'
import {
  DEFAULT_CTRADER_SYMBOL,
  DEFAULT_CTRADER_PERIOD,
  DEFAULT_OKX_SYMBOL,
  DEFAULT_CHART_TIMEZONE,
} from '../chart/chart-config'
import { ChartWorkspace, type ChartJumpRequest, type ChartViewportActions } from '../chart/ChartWorkspace'
import { ChartWindowHost, openChartWindow } from '../chart/chart-window'
import { drawingScope } from '../chart/drawings'
import { readShowTradeOverlays, saveShowTradeOverlays } from '../chart/trade-overlay-preferences'
import type { LoadedArchiveRange, SimulationOverlayState } from '../chart/pro-chart-adapter'
import { SIMULATION_BUY_COLOR, SIMULATION_SELL_COLOR, type SimulationTradeLabel } from '../chart/simulation-price-line'
import { DataManager } from '../components/DataManager'
import { OkxLocalDataDialog } from '../components/OkxLocalDataDialog'
import { DatabentoDataDialog } from '../components/DatabentoDataDialog'
import { CTraderAccountPicker } from '../components/CTraderAccountPicker'
import { ConfigSyncStatus } from '../components/ConfigSyncStatus'
import { PREFERENCES_RESTORED } from '../storage/preference-events'
import { ReplayControls } from '../components/ReplayControls'
import { LiveStatus } from '../components/panels'
import { AccountStrip, SimulationOrder, SimulationDock, type TradingTab } from '../components/TradingWorkspace'
import { WorkspaceDialog } from '../components/WorkspaceDialog'
import { WorkspaceTools } from '../components/WorkspaceTools'
import { PanelToggle } from '../components/PanelToggle'
import { loadWorkspacePreferences, saveWorkspacePreferences, DEFAULT_WORKSPACE_PREFERENCES, type WorkspacePreferences } from '../workspace/preferences'
import type { MarketSelection } from '../market-data/models'
import { BYBIT_DAY_MS } from '../market-data/bybit/trades'
import { OkxLocalDownloads } from '../market-data/okx/local-downloads'
import { readSelectedDatabentoSymbol, readSelectedOkxSymbol, readSelectedSymbol, saveSelectedSymbol } from '../market-data/symbol-preferences'
import { isOkxPriceSource, priceSourceLabel, readPriceSource, savePriceSource, validatePriceSource, type PriceSource } from '../market-data/price-source-preferences'
import { DATABENTO_PRICE_PRECISION, toSymbolInfo } from '../market-data/models'
import {
  INITIAL_LIVE_STATUS,
  type LiveMarketStatus,
} from '../market-data/live-models'
import { createMarketDataRuntime, type MarketDataRuntime } from '../market-data/runtime'
import { compareReplayPositions, replaySourceTimeframe, replayVisibleUntil, sessionVisibleUntil, type ReplayContext } from '../replay/models'
import { useCTraderReplayController } from '../replay/useCTraderReplayController'
import { readReplayStepPeriod, saveReplayStepPeriod } from '../replay/step-preferences'
import { ctraderReplayChartNeedsReload } from '../replay/ctrader-replay-datafeed'
import { isCTraderReplayStepPeriod } from '../replay/step-periods'
import { classifyRiskPrice, estimateRiskPnl } from '../simulation/risk-price'
import { useSimulationController } from '../simulation/useSimulationController'
import type { SimulationTrade } from '../simulation/models'
import './app.css'

function formatLoadedArchiveRange({ first, last, timeZone }: LoadedArchiveRange): string {
  const start = formatDisplayTime(first, timeZone).slice(0, 16)
  const end = formatDisplayTime(last, timeZone).slice(0, 16)
  const endLabel = start.slice(0, 10) === end.slice(0, 10) ? end.slice(11) : end
  const clock = timeZone === DEFAULT_CHART_TIMEZONE ? '北京时间' : timeZone
  return `${clock} ${start}${start === end ? '' : ` 至 ${endLabel}`}`
}

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

function activeSymbol(source: PriceSource): MarketSelection['symbol'] {
  if (isOkxPriceSource(source)) return readSelectedOkxSymbol() ?? DEFAULT_OKX_SYMBOL
  if (source === 'databento-cme') return { ticker: readSelectedDatabentoSymbol() ?? '', exchange: 'CME', type: 'FUTURES', market: 'Databento-CME', volumePrecision: 0, pricePrecision: DATABENTO_PRICE_PRECISION }
  const saved = readSelectedSymbol()
  return saved?.exchange === 'CTRADER' ? saved : DEFAULT_CTRADER_SYMBOL
}

function activeStepPeriod(source: PriceSource): ReturnType<typeof readReplayStepPeriod> {
  const saved = readReplayStepPeriod()
  return isCTraderReplayStepPeriod(saved) && (saved !== 'tick' || source === 'ctrader') ? saved : '1m'
}

const connectionLabels: Record<LiveMarketStatus['connection'], string> = {
  connected: '已连接', connecting: '连接中', reconnecting: '正在重连', disconnected: '已断开',
}

export default function App({ runtime }: { runtime?: MarketDataRuntime } = {}) {
  const [rootRuntime] = useState(() => runtime ?? createMarketDataRuntime())
  const [source, setSource] = useState(readPriceSource)
  const [sourceError, setSourceError] = useState('')
  const marketRuntime = useMemo(() => source === 'ctrader' ? rootRuntime : rootRuntime.forPriceSource(source), [rootRuntime, source])
  useEffect(() => { document.title = `${priceSourceLabel(source)} 行情回放工作站` }, [source])
  useEffect(() => {
    const restored = (event: Event) => {
      if ((event as CustomEvent<{ source: string }>).detail?.source === 'cloud') setSource(readPriceSource())
    }
    window.addEventListener(PREFERENCES_RESTORED, restored)
    return () => window.removeEventListener(PREFERENCES_RESTORED, restored)
  }, [])

  const changeSource = (next: PriceSource) => {
    try {
      savePriceSource(next)
      setSource(next)
      setSourceError('')
    } catch { setSourceError('无法保存行情来源，请检查浏览器存储。') }
  }
  return <MarketWorkspace key={source} marketRuntime={marketRuntime} source={source}
    onSourceChange={changeSource} sourceError={sourceError} />
}

function MarketWorkspace({ marketRuntime, source, onSourceChange, sourceError }: {
  marketRuntime: MarketDataRuntime
  source: PriceSource
  onSourceChange: (next: PriceSource) => void
  sourceError: string
}) {
  const sourceLabel = priceSourceLabel(source)
  const okxLocalMarket = source === 'okx-local' && marketRuntime.service.source === 'okx-local' ? marketRuntime.service : undefined
  const databento = source === 'databento-cme' && marketRuntime.service.source === 'databento-cme' ? marketRuntime.service : undefined
  const localMarket = okxLocalMarket ?? databento
  const subscribeArchives = useCallback((listener: () => void) => localMarket?.subscribeArchives(listener) ?? (() => {}), [localMarket])
  const localDataRevision = useSyncExternalStore(subscribeArchives, () => localMarket?.historyRevision)
  const localDownloads = useMemo(() => okxLocalMarket && new OkxLocalDownloads(okxLocalMarket.files), [okxLocalMarket])
  useEffect(() => {
    void localMarket?.files.restore().catch(() => undefined)
    return () => localDownloads?.stop()
  }, [localMarket, localDownloads])
  const shellRef = useRef<HTMLElement | null>(null)
  const [layout, setLayout] = useState(loadWorkspacePreferences)
  const [workspaceMenu, setWorkspaceMenu] = useState(false)
  const [accountSwitchOpen, setAccountSwitchOpen] = useState(false)
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
        const controls = [...(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex="0"]') ?? [])]
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [mobile, mobilePanel])
  const [dataManagerOpen, setDataManagerOpen] = useState(false)
  const [localDataOpen, setLocalDataOpen] = useState(false)
  const [chartWindows] = useState(() => new ChartWindowHost(marketRuntime))
  const [popupBlocked, setPopupBlocked] = useState(false)
  const [configEpoch, setConfigEpoch] = useState(0)
  const [liveSelection, setLiveSelection] = useState<MarketSelection>(() => ({
    symbol: activeSymbol(source),
    period: DEFAULT_CTRADER_PERIOD,
  }))
  const [replayPeriod, setReplayPeriod] = useState<{ sessionId: string; period: MarketSelection['period'] } | null>(null)
  const [marketWarning, setMarketWarning] = useState('')
  const [localLoadStatus, setLocalLoadStatus] = useState<{ symbol: string; message: string }>()
  const [replayHistoryStatus, setReplayHistoryStatus] = useState('')
  const [databentoContract, setDatabentoContract] = useState('')
  const [liveStatus, setLiveStatus] = useState<LiveMarketStatus>({
    ...INITIAL_LIVE_STATUS,
  })
  const [chartReloadKey, setChartReloadKey] = useState(0)
  const [chartReplayStartTime, setChartReplayStartTime] =
    useState<number | null>(null)
  const viewportRef = useRef<ChartViewportActions>(null)
  const [chartJumpRequest, setChartJumpRequest] = useState<ChartJumpRequest | null>(null)
  const previousReplayContextRef = useRef<ReplayContext | null>(null)
  const [stepPeriod, setStepPeriod] = useState(() => activeStepPeriod(source))
  const [showTradeOverlays, setShowTradeOverlays] = useState(readShowTradeOverlays)
  const replay = useCTraderReplayController(marketRuntime, stepPeriod)
  const mode = replay.session === null ? 'live' : 'history'
  const sessionId = replay.session?.id
  const sessionSymbol = replay.session?.symbol
  const sessionPeriod = replay.session?.period
  const marketSelection = useMemo<MarketSelection>(() => {
    if (sessionSymbol === undefined || sessionPeriod === undefined) return liveSelection
    return { symbol: sessionSymbol, period: replayPeriod && replayPeriod.sessionId === sessionId ? replayPeriod.period : sessionPeriod }
  }, [liveSelection, replayPeriod, sessionId, sessionPeriod, sessionSymbol])
  const databentoRevision = databento?.files.revision
  const databentoTime = replay.session ? sessionVisibleUntil(replay.session) - 1 : chartReplayStartTime
  useEffect(() => {
    if (!databento || databentoTime === null || !marketSelection.symbol.ticker) { setDatabentoContract(''); return }
    const request = new AbortController()
    const ticker = marketSelection.symbol.ticker
    void databento.contractAt(ticker, databentoTime, request.signal).then(contract => {
      if (!request.signal.aborted) setDatabentoContract(contract && contract !== ticker ? contract : '')
    }).catch(() => { if (!request.signal.aborted) setDatabentoContract('') })
    return () => request.abort()
  }, [databento, databentoRevision, databentoTime, marketSelection.symbol.ticker])
  const chartWindowsReady = useRef(false)
  const simulationController = useSimulationController(marketRuntime, replay)
  const simulation = { ...simulationController, busy: simulationController.busy || replay.busy }
  const replaySessionRef = useRef(replay.session)
  replaySessionRef.current = replay.session
  const loadLocalArchives = useCallback(async (symbol: string, days: readonly string[], append: boolean, report = true) => {
    if (!localMarket) return
    const previous = localMarket.activeDays(symbol)
    const directoryRevision = databento?.files.revision
    const toLoad = databento ? [...days].filter(day => !append || !previous.includes(day)).sort() : days
    const changed = localMarket.setActiveDays(symbol, days, append)
    setMarketWarning('')
    setLocalLoadStatus(undefined)
    try {
      const datafeed = marketRuntime.replayDatafeed
      const context = datafeed.getReplayContext()
      const replaySession = replaySessionRef.current
      const replaying = context !== null || replaySession !== null
      let loadedRange: LoadedArchiveRange | undefined
      if (replaying) {
        if (changed) {
          if (databento && toLoad.length && report) {
            const first = databento.archiveDayStart(toLoad[0])
            const last = databento.archiveDayStart(toLoad.at(-1)!) + BYBIT_DAY_MS - 1
            const bars = await databento.loadCandles('trade', symbol, '1m', first, last)
            if (!bars.length) throw new Error('所选日档中没有此品种的可用成交。')
            const visibleUntil = context ? replayVisibleUntil(context) : sessionVisibleUntil(replaySession!)
            const visible = bars.filter(bar => bar.closeTime < visibleUntil)
            if (visible.length) loadedRange = {
              first: visible[0].openTime, last: visible.at(-1)!.openTime, timeZone: DEFAULT_CHART_TIMEZONE,
            }
          }
          datafeed.setReplayContext(context, true)
          setChartReloadKey(current => current + 1)
        }
      } else {
        const viewport = viewportRef.current
        if (databento && report && !viewport) throw new Error('图表尚未就绪，请重试。')
        if (toLoad.length || !append) {
          const range = await viewport?.loadLocalArchives(symbol, toLoad, append)
          if (databento && report && range === undefined) throw new Error('加载时图表或品种已变化，请重试。')
          if (databento && report && toLoad.length && range === null) throw new Error('所选日档中没有此品种的可用成交。')
          loadedRange = range ?? undefined
        }
      }
      if (databento && report) {
        let message = append ? '所选日档已加载' : '已清空加载的日档'
        if (toLoad.length) {
          const span = toLoad.length === 1 ? toLoad[0] : `${toLoad[0]} 至 ${toLoad.at(-1)}`
          message = `${append ? '已追加' : '已加载'} ${toLoad.length} 个日档（UTC ${span}）`
          if (loadedRange) message += ` · ${formatLoadedArchiveRange(loadedRange)}`
          else if (replaying) message += ' · 随回放进度显示'
        }
        setLocalLoadStatus({ symbol, message })
      }
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError'
      const message = aborted ? '加载已中断，请重试。'
        : error instanceof Error ? error.message : '无法加载所选的本地成交'
      if (!aborted || databento && report) setMarketWarning(message)
      if (databento) {
        if (changed && directoryRevision === databento.files.revision) localMarket.setActiveDays(symbol, previous)
        if (report) throw new Error(message)
      }
    }
  }, [databento, localMarket, marketRuntime])
  const refreshLocalFolder = useCallback((replaced: boolean) => {
    if (replaced) localMarket?.clearActiveDays()
    const symbol = marketSelection.symbol.ticker
    void loadLocalArchives(symbol, localMarket?.activeDays(symbol) ?? [], false, false)
  }, [loadLocalArchives, localMarket, marketSelection.symbol.ticker])
  useEffect(() => {
    const restored = (event: Event) => {
      setStepPeriod(activeStepPeriod(source))
      setShowTradeOverlays(readShowTradeOverlays())
      if ((event as CustomEvent<{ source: string }>).detail?.source !== 'cloud') return
      const nextLayout = loadWorkspacePreferences()
      layoutRef.current = nextLayout
      setLayout(nextLayout)
      setFocusMode(false)
      setLiveSelection(current => ({ ...current, symbol: activeSymbol(source) }))
      setConfigEpoch(current => current + 1)
    }
    window.addEventListener(PREFERENCES_RESTORED, restored)
    return () => window.removeEventListener(PREFERENCES_RESTORED, restored)
  }, [source])
  useEffect(() => {
    if (source !== 'okx' && source !== 'databento-cme') return
    const request = new AbortController()
    void marketRuntime.service.getSymbols({ signal: request.signal }).then(symbols => {
      if (request.signal.aborted) return
      setLiveSelection(current => {
        const instrument = symbols.find(item => item.symbol === current.symbol.ticker)
          ?? (source === 'okx' ? symbols.find(item => item.symbol === DEFAULT_OKX_SYMBOL.ticker) : undefined) ?? symbols[0]
        return instrument ? { ...current, symbol: toSymbolInfo(instrument) }
          : source === 'databento-cme' ? { ...current, symbol: { ...current.symbol, ticker: '' } } : current
      })
    }).catch(reason => {
      if (!request.signal.aborted) setMarketWarning(reason instanceof Error ? reason.message : '无法读取本地品种')
    })
    return () => request.abort()
  }, [marketRuntime, source, configEpoch, databentoRevision])
  const simulationOverlays = useMemo<SimulationOverlayState>(() => {
    const currentTime = replay.session
      ? sessionVisibleUntil(replay.session) - 1
      : null
    const state = simulation.state
    if (currentTime === null || state === null || state.sessionId !== replay.session?.id) {
      return { currentTime, positions: [], trades: [] }
    }
    const precision = marketSelection.symbol.pricePrecision ?? 8
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
          isolatedMargin: Number(position.isolatedMargin),
          unrealizedPnl: position.unrealizedPnl,
          estimateRiskPnl: (price: number) => estimateRiskPnl(position, new Decimal(priceText(price)), state.config).toNumber(),
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
    replay.session,
    simulation.busy,
    simulation.setStopLoss,
    simulation.setTakeProfit,
    simulation.state,
  ])

  const syncMarketSelection = useCallback((next: MarketSelection, userSelectedSymbol = false): void => {
    const active = replaySessionRef.current
    if (active !== null) {
      if (active.symbol.ticker !== next.symbol.ticker) return
      setReplayPeriod(current =>
        current?.sessionId === active.id && current.period.text === next.period.text
          ? current : { sessionId: active.id, period: next.period },
      )
      return
    }
    if (userSelectedSymbol) saveSelectedSymbol(next.symbol)
    setLiveSelection((current) =>
      !userSelectedSymbol && current.symbol.ticker === next.symbol.ticker &&
      current.period.text === next.period.text
        ? current
        : next,
    )
  }, [])

  const jumpChartToTime = useCallback((timestamp: number, followLatest = false): void => {
    setMarketWarning('')
    setChartJumpRequest({
      id: crypto.randomUUID(),
      timestamp,
      followLatest,
    })
  }, [])

  const locateLatestChartTime = useCallback((): void => {
    const session = replaySessionRef.current
    const timestamp = session !== null
      ? sessionVisibleUntil(session) - 1
      : Date.now()
    jumpChartToTime(timestamp, session === null)
  }, [jumpChartToTime])

  const stepChart = useCallback((direction: -1 | 1): void => {
    const timestamp = viewportRef.current?.step(direction)
    if (timestamp != null) setChartReplayStartTime(timestamp)
    setMarketWarning(current => current.startsWith('图表已跳转到 ') ? '' : current)
  }, [])

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

  useEffect(() => () => marketRuntime.datafeed.setLiveEnabled(false), [marketRuntime])

  useLayoutEffect(() => {
    if (sessionId === undefined) setReplayPeriod(null)
    setMobilePanel(null)
    setChartJumpRequest(null)
  }, [sessionId])

  useLayoutEffect(() => chartWindows.listen(), [chartWindows])

  useLayoutEffect(() => {
    const activeReplay = replay.session
    const nextContext: ReplayContext | null =
      activeReplay !== null
        ? {
            sessionId: activeReplay.id,
            symbol: activeReplay.symbol.ticker.toUpperCase(),
            timeframe: replaySourceTimeframe(activeReplay),
            currentTime: activeReplay.currentTime,
            visibleUntil: activeReplay.visibleUntil,
            cursorTickIndex: activeReplay.cursorTickIndex,
            tradeUntilUs: replay.tradeUntilUs,
            endTime: activeReplay.endTime,
          }
        : null
    const previous = previousReplayContextRef.current
    const reloadAfterStep = previous !== null && nextContext !== null &&
      previous.sessionId === nextContext.sessionId && ctraderReplayChartNeedsReload(previous, nextContext, marketSelection.period.text)
    const liveEnabled = !localMarket && nextContext === null && replay.preparationStatus === ''
    if (!liveEnabled) marketRuntime.datafeed.setLiveEnabled(false)
    marketRuntime.replayDatafeed.setReplayContext(nextContext, reloadAfterStep)
    if (liveEnabled) marketRuntime.datafeed.setLiveEnabled(true)
    if (!replay.busy) chartWindowsReady.current = true
    if (chartWindowsReady.current) {
      chartWindows.publish({
        symbol: activeReplay?.symbol ?? marketSelection.symbol,
        period: marketSelection.period,
        liveEnabled,
        replay: nextContext,
        simulationOverlays,
        configRevision: configEpoch,
        dataRevision: localDataRevision,
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
          compareReplayPositions(nextContext, previous) < 0))
    if (needsReload) {
      setChartReloadKey((current) => current + 1)
    }
    previousReplayContextRef.current = nextContext
  }, [chartReloadKey, chartWindows, configEpoch, localDataRevision, localMarket, marketRuntime, marketSelection, replay.busy, replay.preparationStatus, replay.session, replay.tradeUntilUs, simulationOverlays])

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
  const accounts = marketRuntime.accountSelection?.getSnapshot()
  const canSwitchAccount = source === 'ctrader' && liveStatus.connection === 'disconnected' && !simulation.busy &&
    accounts?.selectedKey !== undefined && accounts.accounts.length > 1
  const simulationCurrency = replay.session?.tradingConfig.cmeFeePerContractSide !== undefined
    ? 'USD' : replay.session?.tradingConfig.ctrader?.accountCurrency ?? replay.session?.symbol.priceCurrency ?? ''
  const visible = (panel: keyof WorkspacePreferences['panels']) => !focusMode && layout.panels[panel]
  const currentLocalLoad = localLoadStatus?.symbol === marketSelection.symbol.ticker ? localLoadStatus : undefined
  const statusMessages = [replayHistoryStatus, marketWarning, currentLocalLoad?.message,
    mode === 'live' ? liveStatus.warning : simulation.state?.warning].filter(Boolean)

  return (
    <main ref={shellRef} className="app-shell workspace-shell">
      <header className="app-header">
        <h1><span className="desktop-brand">{sourceLabel} 行情回放工作站</span><span className="mobile-brand">{sourceLabel} 工作站</span></h1>
        <div className="market-source-actions">
          <div className="price-source-control">
            <select className="price-source-select" aria-label="行情来源" value={source}
              onChange={event => onSourceChange(validatePriceSource(event.target.value))}>
              <option value="ctrader">cTrader</option>
              <option value="okx">OKX</option>
              <option value="okx-local">OKX-本地</option>
              <option value="databento-cme">Databento-CME</option>
            </select>
          </div>
          {localMarket && <button className="market-local-data-button" type="button" onClick={() => setLocalDataOpen(true)}>本地数据管理</button>}
        </div>
        <WorkspaceTools>
          {!mobile && <button type="button" onClick={() => setPopupBlocked(openChartWindow() === null)}>打开副图</button>}
          <button type="button" aria-expanded={chartSizeOpen} onClick={() => setChartSizeOpen(true)}>图表尺寸</button>
          <button type="button" className="focus-mode-button" aria-pressed={focusMode} onClick={() => { setFocusMode(current => !current); setMobilePanel(null) }}>{focusMode ? '退出专注' : '专注看图'}</button>
          <hr />
          <button type="button" aria-expanded={workspaceMenu} onClick={() => setWorkspaceMenu(true)}>工作区</button>
          <button type="button" data-testid="open-data-manager" onClick={() => setDataManagerOpen(true)}>数据管理</button>
          {source === 'ctrader' && marketRuntime.accountSelection && <CTraderAccountPicker selection={marketRuntime.accountSelection} busy={simulation.busy}
            switching={accountSwitchOpen} onSwitchingChange={setAccountSwitchOpen} />}
        </WorkspaceTools>
      </header>
      {sourceError && <p className="panel-error" role="alert">{sourceError}</p>}
      {popupBlocked && !mobile && <div className="chart-popup-warning" role="alert">浏览器拦截了副图窗口，请允许此站点弹出窗口后重试。</div>}
      {marketRuntime.configSync && <ConfigSyncStatus service={marketRuntime.configSync} />}
      <div
        data-testid={mode === 'history' ? 'simulation-panel' : 'live-workspace'}
        className={`workspace-content${visible('order') ? '' : ' is-order-hidden'}${focusMode ? ' is-focus-mode' : ''}`}
      >
        <div className="workspace-account" hidden={focusMode}>
          <div id="workspace-account-content" hidden={!visible('account')}>
            {mode === 'history'
              ? <AccountStrip state={simulation.state} currency={simulationCurrency} onClose={() => setPanel('account', false)} />
              : <section className="account-strip" aria-label={localMarket ? '本地行情摘要' : '实时行情摘要'}>
                <span>{marketSelection.symbol.ticker}</span>
                {localMarket ? <span>本地历史逐笔 · 实时行情已停止</span> : <>
                  <span>最新价格 <strong>{liveStatus.lastPrice ?? '—'}</strong></span>
                  <span>{connectionLabels[liveStatus.connection]} · 实时只读</span>
                </>}
                <PanelToggle label="账户摘要" expanded controls="workspace-account-content" onToggle={() => setPanel('account', false)} className="panel-close" />
              </section>}
          </div>
          {!visible('account') && <PanelToggle label="账户摘要" expanded={false} showLabel controls="workspace-account-content" onToggle={() => setPanel('account', true)} className="collapsed-panel-handle" />}
        </div>
        <div className="chart-region">
          <ChartWorkspace
            key={configEpoch}
            datafeed={marketRuntime.replayDatafeed}
            orderFlowCloud={marketRuntime.defaultGitHubClient}
            localTradeMarket={localMarket}
            localDownloads={localDownloads}
            onLocalFolderChange={refreshLocalFolder}
            onLoadLocalArchives={loadLocalArchives}
            getOrderFlowLotSize={ticker => marketRuntime.service.source === 'ctrader' ? marketRuntime.service.getCachedLotSize?.(ticker) : undefined}
            jumpRequest={chartJumpRequest}
            onJumpComplete={completeChartTimeJump}
            onReplayStartTimeChange={setChartReplayStartTime}
            viewportRef={viewportRef}
            onSelectionChange={syncMarketSelection}
            symbolLocked={mode === 'history'}
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
              <ReplayControls
                priceSource={source}
                chartStartTime={chartReplayStartTime}
                interactionLocked={simulation.busy}
                market={marketRuntime.service}
                onJumpToTime={jumpChartToTime}
                onLocateLatest={locateLatestChartTime}
                onChartStep={stepChart}
                replay={replay}
                selection={marketSelection}
                simulation={simulation}
                stepPeriod={stepPeriod}
                onStepPeriodChange={period => { saveReplayStepPeriod(period); setStepPeriod(period) }}
                showTradeOverlays={showTradeOverlays}
                onTradeOverlaysChange={visible => { saveShowTradeOverlays(visible); setShowTradeOverlays(visible) }}
              />
            </div>
          </div>
        </div>
        <div className="order-expander" hidden={mobile || focusMode || visible('order')}>
          <PanelToggle label="下单面板" expanded={false} controls="workspace-order-content" direction="right" showLabel onToggle={() => setPanel('order', true)} />
        </div>
        <div id="workspace-order-content" className="order-region" hidden={!visible('order')} data-mobile-open={mobile && mobilePanel === 'order' || undefined}>
          {mode === 'history' ? <SimulationOrder session={replay.session} simulation={simulation} onClose={() => mobile ? closeMobilePanel() : setPanel('order', false)} /> : <><header className="panel-heading"><h2>行情状态</h2><PanelToggle label="下单面板" expanded controls="workspace-order-content" direction="right" onToggle={() => mobile ? closeMobilePanel() : setPanel('order', false)} /></header>
            {localMarket ? <p>从本地逐笔成交归档加载行情。</p> : <LiveStatus status={liveStatus} onSwitchAccount={canSwitchAccount ? () => setAccountSwitchOpen(true) : undefined} />}
          </>}
        </div>
        <div id="workspace-dock-content" className="dock-region" hidden={mode !== 'history' || !visible('dock')} data-mobile-open={mobile && mobilePanel === 'dock' || undefined} data-review={dockTab === 'stats' && simulation.state !== null || undefined}>
          <SimulationDock simulation={simulation} currency={simulationCurrency} pricePrecision={replay.session?.symbol.pricePrecision} tab={dockTab} onTabChange={setDockTab} onClose={() => mobile ? closeMobilePanel() : setPanel('dock', false)} />
        </div>
        <div className="dock-expander" hidden={mobile || mode !== 'history' || focusMode || visible('dock')}>
          <PanelToggle label="持仓面板" expanded={false} controls="workspace-dock-content" direction="down" showLabel onToggle={() => setPanel('dock', true)} className="collapsed-panel-handle" />
        </div>
      </div>
      {mobile && mobilePanel && <div className="mobile-panel-backdrop" onClick={closeMobilePanel} aria-hidden="true" />}
      <footer className="status-footer" role="contentinfo">
        <span id="workspace-status-content" title={currentLocalLoad?.message}>{marketSelection.symbol.ticker} · {marketSelection.period.text}{databentoContract && ` · 实际合约 ${databentoContract}`}{replay.session !== null ? ` · 回放第 ${replay.session.currentIndex + 1} 步` : ''}<span role="status">{statusMessages.map(message => ` · ${message}`).join('')}</span></span>
        <span>{mode === 'history' ? '历史回放' : databento ? '本地行情' : '实时行情'}</span>
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
      {dataManagerOpen && <DataManager onClose={() => setDataManagerOpen(false)} runtime={marketRuntime} />}
      {localDataOpen && okxLocalMarket && localDownloads && <OkxLocalDataDialog files={okxLocalMarket.files}
        downloads={localDownloads} symbol={marketSelection.symbol.ticker} loadedDays={okxLocalMarket.activeDays(marketSelection.symbol.ticker)}
        onClose={() => setLocalDataOpen(false)} onFolderChange={refreshLocalFolder} onLoad={loadLocalArchives} />}
      {localDataOpen && databento && <DatabentoDataDialog files={databento.files} revision={databento.files.revision}
        symbol={marketSelection.symbol.ticker} loadedDays={databento.activeDays(marketSelection.symbol.ticker)}
        onClose={() => setLocalDataOpen(false)} onFolderChange={refreshLocalFolder} onLoad={loadLocalArchives} />}
    </main>
  )
}
