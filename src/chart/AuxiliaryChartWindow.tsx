import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Period } from '@klinecharts/pro'
import { ChartWorkspace } from './ChartWorkspace'
import { connectChartWindow, type ChartWindowConnection } from './chart-window'
import { INITIAL_LIVE_STATUS } from '../market-data/live-models'
import type { MarketSelection } from '../market-data/models'
import { DrawingStore } from './drawings'
import { formatDisplayTime } from '../format-display-time'

const connectionLabels = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重新连接中',
  disconnected: '连接已断开',
}

function ConnectedChart({ connection, period, onSelection }: {
  connection: ChartWindowConnection
  period: Period
  onSelection(selection: MarketSelection): void
}) {
  const snapshot = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  const [liveStatus, setLiveStatus] = useState(INITIAL_LIVE_STATUS)
  const [liveReloadKey, setLiveReloadKey] = useState(0)
  const [warning, setWarning] = useState('')
  const [sizeStatus, setSizeStatus] = useState('')
  const [showTradeOverlays, setShowTradeOverlays] = useState(true)
  const [drawingStore] = useState(() => new DrawingStore())

  function saveDefaultSize(): void {
    const { innerWidth: width, innerHeight: height } = window
    try {
      connection.saveDefaultSize({ width, height })
      setSizeStatus(`默认大小已保存 · ${width} × ${height}`)
    } catch {
      setSizeStatus('无法保存默认大小')
    }
  }

  useEffect(() => {
    connection.liveDatafeed.setLiveStatusListener(setLiveStatus)
    connection.liveDatafeed.setReconnectListener(() => setLiveReloadKey(current => current + 1))
    connection.datafeed.setWarningListener(setWarning)
    return () => {
      connection.liveDatafeed.setLiveStatusListener()
      connection.liveDatafeed.setReconnectListener()
      connection.datafeed.setWarningListener()
    }
  }, [connection])

  useEffect(() => {
    if (snapshot) document.title = `${snapshot.symbol.ticker} · ${period.text} · 副图`
  }, [period.text, snapshot?.symbol.ticker])

  useEffect(() => { setWarning('') }, [snapshot?.chartRevision, period.text])

  if (snapshot === null) return <p className="auxiliary-chart-status" role="status">正在等待主窗口连接…</p>
  const replayTime = snapshot.visibleUntil === null ? null : formatDisplayTime(snapshot.visibleUntil, 'Asia/Shanghai')
  const source = snapshot.symbol.exchange === 'CME' ? 'Databento-CME' : connection.localArchives ? 'OKX-本地'
    : snapshot.symbol.exchange === 'OKX' ? 'OKX' : 'cTrader'
  return (
    <>
      <header className="auxiliary-chart-status">
        <strong>{snapshot.symbol.ticker}</strong>
        {replayTime === null
          ? <span>{source} {connection.localArchives ? '历史逐笔' : `实时行情 · ${connectionLabels[liveStatus.connection]}`}</span>
          : <span>{source} 历史回放 · 已回放至 {replayTime}</span>}
        {warning && <span role="status">{warning}</span>}
        <div className="auxiliary-chart-size">
          {replayTime !== null && (
            <button type="button" className="trade-overlays-toggle" aria-pressed={showTradeOverlays}
              onClick={() => setShowTradeOverlays(visible => !visible)}>交易标记</button>
          )}
          <span role="status">{sizeStatus}</span>
          <button type="button" onClick={saveDefaultSize}>设为默认大小</button>
        </div>
      </header>
      <ChartWorkspace
        auxiliary
        key={`${snapshot.chartRevision}:${snapshot.configRevision}`}
        datafeed={connection.datafeed}
        symbol={snapshot.symbol}
        period={period}
        reloadKey={liveReloadKey}
        simulationOverlays={snapshot.simulationOverlays}
        showTradeOverlays={showTradeOverlays}
        drawingStore={drawingStore}
        drawingScope={snapshot.drawingScope}
        onSelectionChange={onSelection}
      />
    </>
  )
}

export function AuxiliaryChartWindow() {
  const [connection, setConnection] = useState<ChartWindowConnection>()
  const [period, setPeriod] = useState<Period>()
  const [openerClosed, setOpenerClosed] = useState(false)
  const active = useRef<ChartWindowConnection>(undefined)
  const selectedPeriod = useRef<Period>(undefined)

  useEffect(() => {
    document.title = '行情副图'
    const connect = () => {
      const opener = window.opener as Window | null
      if (!opener || opener.closed) {
        active.current?.close()
        active.current = undefined
        setConnection(undefined)
        setOpenerClosed(true)
        return
      }
      if (active.current?.getSnapshot()) return
      const next = connectChartWindow(window, selectedPeriod.current)
      if (next) {
        active.current = next
        selectedPeriod.current = next.initialPeriod
        setPeriod(next.initialPeriod)
        setConnection(next)
      }
    }
    const disconnect = () => {
      active.current?.close()
      active.current = undefined
      setConnection(undefined)
    }
    connect()
    const retry = window.setInterval(connect, 500)
    window.addEventListener('pagehide', disconnect)
    return () => {
      window.clearInterval(retry)
      window.removeEventListener('pagehide', disconnect)
      disconnect()
    }
  }, [])

  function changePeriod(selection: MarketSelection): void {
    active.current?.setPeriod(selection.period)
    selectedPeriod.current = selection.period
    setPeriod(selection.period)
  }

  return (
    <main className="workspace-shell auxiliary-chart-window" aria-label="独立副图窗口">
      {connection && period
        ? <ConnectedChart connection={connection} period={period} onSelection={changePeriod} />
        : <p className="auxiliary-chart-status" role="status">{openerClosed
            ? '主窗口已关闭，请从工作站重新打开副图。'
            : '正在等待主窗口连接…'}</p>}
    </main>
  )
}
