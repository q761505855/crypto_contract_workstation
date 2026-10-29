import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { ReplayControls } from '../components/ReplayControls'
import { TimeJumpControl } from '../components/TimeJumpControl'
import {
  LiveStatus,
  SimulationPanel,
} from '../components/panels'
import type { MarketSelection } from '../market-data/models'
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
  const [dataManagerOpen, setDataManagerOpen] = useState(false)
  const [marketRuntime] = useState(createMarketDataRuntime)
  const [marketSelection, setMarketSelection] = useState<MarketSelection>({
    symbol: DEFAULT_SYMBOL,
    period: SUPPORTED_PERIODS[3],
  })
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
    if (mode !== 'history') {
      return {
        currentTime: null,
        entryPrice: null,
        takeProfitPrice: null,
        stopLossPrice: null,
        liquidationPrice: null,
        trades: [],
      }
    }
    const position = simulation.state?.position
    const precision = marketSelection.symbol.pricePrecision ?? 8
    const onTakeProfitPriceDrag =
      position === null || position === undefined || simulation.busy
        ? undefined
        : (price: number) =>
            simulation.setTakeProfit(simulationPriceText(price, precision))
    const onStopLossPriceDrag =
      position === null || position === undefined || simulation.busy
        ? undefined
        : (price: number) =>
            simulation.setStopLoss(simulationPriceText(price, precision))
    const onEntryPriceDrag =
      position === null || position === undefined || simulation.busy
        ? undefined
        : (price: number) => {
            const target = classifyRiskPrice(
              position.side,
              Number(position.lastPrice ?? position.markPrice),
              price,
            )
            if (target === 'take-profit') {
              onTakeProfitPriceDrag?.(price)
            } else if (target === 'stop-loss') {
              onStopLossPriceDrag?.(price)
            }
          }
    return {
      currentTime: replay.session?.currentTime ?? null,
      entryPrice: position === null || position === undefined
        ? null
        : Number(position.entryPrice),
      takeProfitPrice:
        position?.takeProfitPrice === null ||
        position?.takeProfitPrice === undefined
          ? null
          : Number(position.takeProfitPrice),
      stopLossPrice:
        position?.stopLossPrice === null ||
        position?.stopLossPrice === undefined
          ? null
          : Number(position.stopLossPrice),
      liquidationPrice:
        position === null || position === undefined
          ? null
          : Number(position.liquidationPrice),
      trades: (simulation.state?.trades ?? [])
        .slice(-100)
        .map(tradeOverlay),
      onEntryPriceDrag,
      onTakeProfitPriceDrag,
      onStopLossPriceDrag,
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

  useEffect(() => {
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

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>加密货币合约回放工作站</h1>
        <div className="header-actions">
          <button
            data-testid="open-data-manager"
            onClick={() => setDataManagerOpen(true)}
            type="button"
          >
            数据管理
          </button>
          <ModeSwitch mode={mode} onChange={changeMode} />
        </div>
      </header>
      <div className="workspace-grid">
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
        />
        {mode === 'history' ? (
          <SimulationPanel
            session={replay.session}
            simulation={simulation}
          />
        ) : (
          <LiveStatus status={liveStatus} />
        )}
      </div>
      {mode === 'history' ? (
        <ReplayControls
          chartStartTime={chartRightmostCandleTime}
          interactionLocked={simulation.busy}
          onJumpToTime={jumpChartToTime}
          replay={replay}
          selection={marketSelection}
        />
      ) : (
        <section className="replay-controls live-time-controls">
          <TimeJumpControl onJump={jumpChartToTime} />
        </section>
      )}
      <footer className="status-footer">
        <span>
          {marketSelection.symbol.ticker} · {marketSelection.period.text}
          {replay.session !== null
            ? ` · 回放 ${replay.session.currentIndex + 1}/${replay.session.candleCount}`
            : ''}
          {marketWarning.length > 0 ? ` · ${marketWarning}` : ''}
        </span>
        <span>{mode === 'history' ? '历史训练模拟' : '实时只读'}</span>
      </footer>
      <DataManager
        onApplySelection={applyMarketSelection}
        onClose={() => setDataManagerOpen(false)}
        open={dataManagerOpen}
        runtime={marketRuntime}
        selection={marketSelection}
      />
    </main>
  )
}
