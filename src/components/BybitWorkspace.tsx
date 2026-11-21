import { useEffect, useMemo, useRef, useState } from 'react'
import type { Period } from '@klinecharts/pro'
import { ChartWorkspace } from '../chart/ChartWorkspace'
import { CTRADER_PERIODS } from '../chart/chart-config'
import type { DrawingStore } from '../chart/drawings'
import type { GitHubContentsClient } from '../github-sync/github-client'
import { BybitArchive } from '../market-data/bybit/archive'
import { ensureBybitDay } from '../market-data/bybit/archive-requests'
import { BybitDatafeed } from '../market-data/bybit/datafeed'
import { BybitLiveTrades, type BybitLiveStatus } from '../market-data/bybit/live'
import { BYBIT_DAY_MS, BYBIT_SYMBOLS, bybitDay, bybitDayStart, bybitFirstDay, bybitSymbol,
  bybitSymbolInfo, type BybitSymbol } from '../market-data/bybit/trades'
import './bybit-workspace.css'

const minutesInDay = 1440
const chartPeriod = CTRADER_PERIODS.find(item => item.text === '5m')!

interface View {
  symbol: BybitSymbol
  day?: string
  startUs?: number
}

function useFeed(view: View, archive: BybitArchive) {
  const [status, setStatus] = useState<BybitLiveStatus>('连接中')
  const [warning, setWarning] = useState('')
  const [reload, setReload] = useState(0)
  const live = useMemo(() => new BybitLiveTrades(view.symbol, setStatus), [view.symbol])
  const feed = useMemo(() => new BybitDatafeed(view.symbol, archive, view.day ? undefined : live,
    view.day ? bybitDayStart(view.day) : undefined, view.startUs, setWarning, () => setReload(value => value + 1)),
  [archive, live, view])
  useEffect(() => {
    setWarning('')
    feed.start()
    return () => feed.dispose()
  }, [feed])
  useEffect(() => {
    live.open()
    return () => live.close()
  }, [live])
  return { feed, reload, status, warning, setWarning, refresh: () => setReload(value => value + 1) }
}

export function BybitWorkspace({ onClose, drawings, cloud, preferenceEpoch }: {
  onClose(): void
  drawings: DrawingStore
  cloud: GitHubContentsClient
  preferenceEpoch: number
}) {
  const [archive] = useState(() => new BybitArchive(cloud.getTarget()))
  const [view, setView] = useState<View>({ symbol: 'SPYUSDT' })
  const [viewVersion, setViewVersion] = useState(0)
  const [day, setDay] = useState(() => bybitDay(Date.now() - BYBIT_DAY_MS * 2))
  const [time, setTime] = useState('00:00')
  const [historyStatus, setHistoryStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [position, setPosition] = useState<number>()
  const [playing, setPlaying] = useState(false)
  const [period, setPeriod] = useState<Period>(chartPeriod)
  const [stepSeconds, setStepSeconds] = useState(60)
  const request = useRef<AbortController | null>(null)
  const historyRequest = useRef<AbortController | null>(null)
  const { feed, reload, status, warning, setWarning, refresh } = useFeed(view, archive)
  const instrument = useMemo(() => bybitSymbolInfo(view.symbol), [view.symbol])
  const history = view.day !== undefined

  function stopWaiting() {
    historyRequest.current?.abort()
    historyRequest.current = null
    setLoading(false)
    setHistoryStatus('')
  }

  function changeView(next: View) {
    stopWaiting()
    request.current?.abort()
    request.current = null
    setPlaying(false)
    setPosition(next.startUs)
    setView(next)
    setViewVersion(version => version + 1)
  }

  async function openHistory() {
    if (historyRequest.current) return
    const symbol = view.symbol
    const controller = new AbortController()
    historyRequest.current = controller
    setLoading(true)
    setPlaying(false)
    setHistoryStatus('正在检查日归档…')
    try {
      const start = bybitDayStart(day)
      const selected = Date.parse(`${day}T${time}:00Z`)
      if (!Number.isFinite(selected) || selected < start || selected >= start + BYBIT_DAY_MS) throw new Error('请输入有效 UTC 时间')
      await ensureBybitDay(archive, cloud, symbol, day, message => {
        if (!controller.signal.aborted) setHistoryStatus(message)
      }, controller.signal)
      controller.signal.throwIfAborted()
      changeView({ symbol, day, startUs: (selected + 60_000) * 1000 })
    } catch (error) {
      if (!controller.signal.aborted) setHistoryStatus(error instanceof Error ? error.message : '无法读取历史成交')
    } finally {
      if (historyRequest.current === controller) {
        historyRequest.current = null
        setLoading(false)
      }
    }
  }

  async function step(seconds: number) {
    if (!history || request.current) return
    const controller = new AbortController()
    request.current = controller
    try {
      const before = feed.currentUs
      await feed.advance(before + seconds * 1_000_000, controller.signal)
      if (controller.signal.aborted) return
      setPosition(feed.currentUs)
      if (feed.currentUs >= (feed.dayStart! + BYBIT_DAY_MS) * 1000) setPlaying(false)
    } catch (error) {
      if (!controller.signal.aborted) {
        setWarning(error instanceof Error ? error.message : '回放逐笔失败')
        setPlaying(false)
      }
    } finally { if (request.current === controller) request.current = null }
  }

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => { void step(stepSeconds) }, 350)
    return () => clearInterval(timer)
  })

  useEffect(() => () => { historyRequest.current?.abort(); request.current?.abort() }, [])

  return <main className="bybit-workspace">
    <header className="bybit-header">
      <button type="button" onClick={onClose}>返回工作站</button>
      <h1>Bybit 逐笔成交</h1>
      <label>品种 <select value={view.symbol} onChange={event => {
        const symbol = bybitSymbol(event.target.value)
        if (symbol) changeView({ symbol })
      }}>
        {BYBIT_SYMBOLS.map(symbol => <option key={symbol} value={symbol}>{symbol} · {bybitSymbolInfo(symbol).name}</option>)}
      </select></label>
    </header>
    <section className="bybit-controls" aria-label="Bybit 数据和回放">
      <label>UTC 日期 <input type="date" value={day} min={bybitFirstDay(view.symbol)}
        max={bybitDay(Date.now() - BYBIT_DAY_MS)} onChange={event => { stopWaiting(); setDay(event.target.value) }} /></label>
      <label>UTC 起点 <input type="time" value={time} onChange={event => { stopWaiting(); setTime(event.target.value) }} /></label>
      <button type="button" disabled={loading} onClick={() => void openHistory()}>历史回放</button>
      {loading && <button type="button" onClick={stopWaiting}>取消等待</button>}
      <button type="button" disabled={!history} onClick={() => changeView({ symbol: view.symbol })}>回到实时</button>
      {history && <div className="bybit-replay-controls">
        <label>步进 <select value={stepSeconds} onChange={event => setStepSeconds(Number(event.target.value))}>
          <option value="1">1 秒</option><option value="60">1 分钟</option>
        </select></label>
        <button type="button" onClick={() => void step(stepSeconds)}>前进一步</button>
        <button type="button" onClick={() => setPlaying(value => !value)}>{playing ? '暂停' : '播放'}</button>
        <label>回放进度 <input type="range" min={0} max={minutesInDay}
          value={Math.floor(((position ?? feed.currentUs) / 1000 - feed.dayStart!) / 60_000)}
          onChange={event => {
            request.current?.abort()
            request.current = null
            setPlaying(false)
            const next = (feed.dayStart! + Number(event.target.value) * 60_000) * 1000
            feed.seek(next)
            setPosition(next)
            refresh()
          }} /></label>
        <span>{new Date((position ?? feed.currentUs) / 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC</span>
      </div>}
    </section>
    <div className="bybit-status" role="status">{[history ? `${view.day} UTC · 历史成交` : status,
      historyStatus, warning].filter(Boolean).join(' · ')}</div>
    <div className="bybit-chart">
      <ChartWorkspace key={`${viewVersion}:${preferenceEpoch}`} datafeed={feed}
        symbol={instrument} symbolLocked period={period} reloadKey={reload}
        drawingStore={drawings} drawingScope={`live:BYBIT:${view.symbol}`}
        onSelectionChange={selection => setPeriod(selection.period)} />
    </div>
  </main>
}
