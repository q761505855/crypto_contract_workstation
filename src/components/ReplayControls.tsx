import { useCallback, useEffect, useRef, useState } from 'react'
import Decimal from 'decimal.js'
import type { CTraderMarketService } from '../market-data/ctrader-market'
import type { MarketSelection } from '../market-data/models'
import { CTRADER_TIMEFRAMES } from '../market-data/intervals'
import type {
  ReplaySession,
  ReplaySpeed,
} from '../replay/models'
import { DEFAULT_TRADING_CONFIG, sessionVisibleUntil } from '../replay/models'
import type { ReplayController } from '../replay/useReplayController'
import { validateReplayStepPeriod } from '../replay/step-preferences'
import { FINE_STEP_PERIODS, isCTraderReplayStepPeriod, isFineStepPeriod, type ReplayStepPeriod } from '../replay/step-periods'
import { cTraderLeverage, type CTraderTradingTerms } from '../simulation/ctrader-trading'
import { WorkspaceDialog } from './WorkspaceDialog'
import { TimeJumpControl } from './TimeJumpControl'
import { formatDisplayTime, formatInputWeekday } from '../format-display-time'

interface ReplayControlsProps {
  market: Pick<CTraderMarketService, 'getReplayTradingTerms'>
  selection: MarketSelection
  replay: ReplayController<ReplayStepPeriod>
  stepPeriod: ReplayStepPeriod
  onStepPeriodChange: (period: ReplayStepPeriod) => void
  showTradeOverlays: boolean
  onTradeOverlaysChange: (visible: boolean) => void
  interactionLocked?: boolean
  chartStartTime: number | null
  onJumpToTime: (timestamp: number) => void
  onLocateLatest: () => void
}

function sessionName(session: ReplaySession): string {
  return `${session.symbol.ticker} ${session.period.text} · ${formatDisplayTime(
    session.startTime,
  )}${session.marketSource !== 'ctrader' ? ' · 币安存档' : session.tradingConfig.ctrader ? '' : ' · 旧模拟规则'}`
}

const HOLD_TO_PLAY_MS = 450

function NextCandleButton({ replay, disabled, label }: { replay: ReplayController<ReplayStepPeriod>; disabled: boolean; label: string }) {
  const { next, play, pause } = replay
  const [pressing, setPressing] = useState(false)
  const press = useRef<{ pointerId: number; timer: number; playing: boolean } | null>(null)
  const suppressClick = useRef(false)

  const finishPress = useCallback((cancelClick: boolean, pointerId?: number) => {
    const active = press.current
    if (active === null || (pointerId !== undefined && active.pointerId !== pointerId)) return
    press.current = null
    window.clearTimeout(active.timer)
    suppressClick.current = cancelClick || active.playing
    if (active.playing) pause()
    setPressing(false)
  }, [pause])

  useEffect(() => {
    const cancel = () => finishPress(true)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('blur', cancel)
      cancel()
    }
  }, [finishPress])

  return <button
    className="replay-next-button"
    disabled={disabled && !pressing}
    title="长按播放，松开暂停"
    type="button"
    onPointerDown={event => {
      if (disabled || !event.isPrimary || event.button !== 0 || press.current !== null) return
      event.currentTarget.setPointerCapture(event.pointerId)
      suppressClick.current = false
      const active = { pointerId: event.pointerId, timer: 0, playing: false }
      active.timer = window.setTimeout(() => {
        active.playing = true
        play()
      }, HOLD_TO_PLAY_MS)
      press.current = active
      // Keep receiving the release while a playback step temporarily locks the controls.
      setPressing(true)
    }}
    onPointerUp={event => {
      const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect()
      const outside = event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom
      finishPress(outside, event.pointerId)
    }}
    onPointerCancel={event => finishPress(true, event.pointerId)}
    onLostPointerCapture={event => finishPress(true, event.pointerId)}
    onContextMenu={event => { if (press.current !== null) event.preventDefault() }}
    onClick={event => {
      if (disabled || press.current !== null || (event.detail > 0 && suppressClick.current)) return
      void next()
    }}
  >{label}</button>
}

export function ReplayControls({
  market,
  selection,
  replay,
  stepPeriod,
  onStepPeriodChange,
  showTradeOverlays,
  onTradeOverlaysChange,
  interactionLocked = false,
  chartStartTime,
  onJumpToTime,
  onLocateLatest,
}: ReplayControlsProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [toText, setToText] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [initialBalance, setInitialBalance] = useState(
    DEFAULT_TRADING_CONFIG.initialBalance,
  )
  const [slippageRate, setSlippageRate] = useState('0')
  const [terms, setTerms] = useState<CTraderTradingTerms | null>(null)
  const [termsError, setTermsError] = useState('')
  const ticker = selection.symbol.ticker

  useEffect(() => {
    if (!settingsOpen || chartStartTime === null) return
    const request = new AbortController()
    setTerms(null)
    setTermsError('')
    void market.getReplayTradingTerms(ticker, chartStartTime, request.signal).then(result => {
      if (!request.signal.aborted) setTerms(result)
    }, (error: unknown) => {
      if (!request.signal.aborted) setTermsError(error instanceof Error ? error.message : '无法读取交易规格')
    })
    return () => request.abort()
  }, [settingsOpen, ticker, chartStartTime, market])

  const selectedSession = replay.sessions.find((session) => session.id === selectedSessionId) ?? replay.sessions[0]

  useEffect(() => {
    if (replay.session === null) setToText('')
  }, [replay.session])

  function createSession(): void {
    if (chartStartTime === null) return
    void replay.createSession({
      symbol: selection.symbol, period: selection.period, startTime: chartStartTime,
      ...(toText.length === 0 ? {} : { endTime: new Date(toText).getTime() }),
      initialBalance, slippageRate,
    })
    setSettingsOpen(false)
  }

  function deleteSelectedSession(session: ReplaySession): void {
    if (window.confirm(`删除本机回放会话「${sessionName(session)}」及其模拟账户、持仓、成交和流水？`)) {
      void replay.deleteSession(session.id)
    }
  }

  if (replay.session === null) {
    const startLabel = chartStartTime === null ? '等待图表 K 线' : formatDisplayTime(chartStartTime)
    return <section className="replay-controls replay-setup" data-testid="replay-controls">
      <TimeJumpControl compact disabled={replay.busy} onJump={onJumpToTime} onLocateLatest={onLocateLatest} />
      <span className="replay-start-time">起点：{startLabel}</span>
      <button type="button" onClick={() => setSettingsOpen(true)}>回放设置</button>
      <button type="button" disabled={replay.busy || chartStartTime === null} onClick={createSession}>{replay.busy ? '准备中…' : '创建回放'}</button>
      {replay.busy && replay.preparationStatus && <span className="replay-preparation" role="status">{replay.preparationStatus}</span>}
      {!settingsOpen && replay.error && <span className="replay-error" role="alert">{replay.error}</span>}
      <WorkspaceDialog open={settingsOpen} title="回放会话设置" onClose={() => setSettingsOpen(false)}>
        <p className="muted-text">{selection.symbol.ticker} · {selection.period.text} · 起点：{startLabel}</p>
        <label className="panel-field">
          <span>结束（可选） {formatInputWeekday(toText)}</span>
          <input
            aria-label="回放结束时间"
            onChange={(event) => setToText(event.target.value)}
            type="datetime-local"
            value={toText}
          />
        </label>
        <label className="panel-field">
          初始资金{terms ? '（' + terms.accountCurrency + '）' : ''}
          <input
            aria-label="初始资金"
            min="0"
            onChange={(event) => setInitialBalance(event.target.value)}
            step="100"
            type="number"
            value={initialBalance}
          />
        </label>
        <details className="replay-advanced">
          <summary>IC Markets 交易规格</summary>
          <div>
            {terms ? <dl className="detail-list">
              <div><dt>账户杠杆上限</dt><dd>{terms.accountLeverage}×</dd></div>
              <div><dt>品种起始杠杆</dt><dd>{cTraderLeverage(terms)}×（按名义金额分档）</dd></div>
              <div><dt>每手合约单位</dt><dd>{terms.lotSize}</dd></div>
              <div><dt>最小手数 / 手数步长</dt><dd>{new Decimal(terms.minQuantity).div(terms.lotSize).toString()} / {new Decimal(terms.quantityStep).div(terms.lotSize).toString()}</dd></div>
              <div><dt>佣金</dt><dd>{terms.commission.type === 3
                ? new Decimal(terms.commission.rate).mul(100).toString() + '% 名义金额'
                : terms.commission.rate + (terms.commission.type === 1 ? ' USD / 百万美元成交额' : ' ' + (terms.commission.type === 2 ? 'USD' : terms.quoteCurrency) + ' / 手')}</dd></div>
              <div><dt>账户强平线</dt><dd>{new Decimal(terms.stopOutRate).mul(100).toString()}% 保证金水平</dd></div>
              {terms.swap && <div><dt>隔夜调整</dt><dd>多 {terms.swap.long} / 空 {terms.swap.short}（会话规格）</dd></div>}
            </dl> : <p className="muted-text">{termsError || (chartStartTime === null ? '请先在图表上选定回放起点。' : '正在读取账户和品种规格…')}</p>}
            <label className="panel-field">
              额外模拟滑点率
              <input aria-label="额外模拟滑点率" min="0" max="0.9999" onChange={(event) => setSlippageRate(event.target.value)}
                step="0.0001" type="number" value={slippageRate} />
            </label>
            <p className="muted-text">创建时保存当前券商规格。成交基于历史买价，额外滑点默认 0。</p>
          </div>
        </details>
        {selectedSession && (
          <>
            <select
              aria-label="已有回放会话"
              disabled={replay.busy}
              onChange={(event) => setSelectedSessionId(event.target.value)}
              value={selectedSession.id}
            >
              {replay.sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {sessionName(session)}
                </option>
              ))}
            </select>
            <div className="button-row">
              <button
                disabled={replay.busy || selectedSession.marketSource !== 'ctrader'}
                onClick={() => { void replay.loadSession(selectedSession.id); setSettingsOpen(false) }}
                type="button"
              >
                加载会话
              </button>
              <button
                className="danger-button"
                disabled={replay.busy}
                onClick={() => deleteSelectedSession(selectedSession)}
                type="button"
              >
                删除会话
              </button>
            </div>
          </>
        )}

        {replay.error && <span className="replay-error" role="alert">{replay.error}</span>}
        <div className="button-row"><button type="button" onClick={() => setSettingsOpen(false)}>应用设置</button><button type="button" disabled={replay.busy || chartStartTime === null} onClick={createSession}>开始历史回放</button></div>
      </WorkspaceDialog>
    </section>
  }

  const session = replay.session
  const native = session.marketSource === 'ctrader'
  const onTick = session.cursorTimeframe === 'tick'
  const currentTime = onTick ? session.currentTime : sessionVisibleUntil(session) - (native ? 0 : 60_000)
  const precision = onTick ? 'millisecond' : isFineStepPeriod(session.cursorTimeframe) ? 'second' : 'minute'
  return (
    <section className="replay-controls" data-testid="replay-controls">
      <TimeJumpControl compact
        disabled={interactionLocked}
        onJump={onJumpToTime}
        onLocateLatest={onLocateLatest}
      />
      <span className="replay-position">
        {session.symbol.ticker} · 当前：
        {formatDisplayTime(currentTime, undefined, precision)} · {native
          ? <span>第 {session.currentIndex + 1} 步</span>
          : <span title={`会话进度按创建时的 ${session.period.text} K 线计数`}>{session.currentIndex + 1}/{session.candleCount}</span>}
      </span>
      <label className="replay-step-period">步进
        <select aria-label="步进周期" disabled={interactionLocked} value={isCTraderReplayStepPeriod(stepPeriod) ? stepPeriod : '1m'} onChange={event => onStepPeriodChange(validateReplayStepPeriod(event.target.value))}>
          {FINE_STEP_PERIODS.map(period => <option key={period} value={period}>{period === 'tick' ? '逐笔 Tick' : period}</option>)}
          {CTRADER_TIMEFRAMES.map(period => <option key={period} value={period}>{period}</option>)}
        </select>
      </label>
      <button
        disabled={
          interactionLocked ||
          (session.currentIndex === 0 && (native || session.visibleUntil === undefined)) ||
          session.hasTrades
        }
        onClick={() => void replay.previous()}
        type="button"
      >
        {stepPeriod === 'tick' ? '上一笔' : '上一根'}
      </button>
      <NextCandleButton
        key={session.id}
        replay={replay}
        label={stepPeriod === 'tick' ? '下一笔' : '下一根'}
        disabled={interactionLocked || session.status === 'completed'}
      />
      <button
        disabled={(!replay.isPlaying && interactionLocked) || session.status === 'completed'}
        onClick={replay.isPlaying ? replay.pause : replay.play}
        type="button"
      >
        {replay.isPlaying ? '暂停' : '播放'}
      </button>
      <select
        aria-label="回放速度"
        disabled={interactionLocked}
        onChange={(event) =>
          replay.setSpeed(Number(event.target.value) as ReplaySpeed)
        }
        value={session.speed}
      >
        {[1, 2, 5, 10].map((speed) => (
          <option key={speed} value={speed}>
            {speed}x
          </option>
        ))}
      </select>
      <button type="button" className="trade-overlays-toggle" aria-pressed={showTradeOverlays}
        onClick={() => onTradeOverlaysChange(!showTradeOverlays)} title={showTradeOverlays ? '隐藏图表交易标记' : '显示图表交易标记'}>交易标记</button>
      <button type="button" className="replay-settings-actions" onClick={() => setActionsOpen(true)}>回放设置</button>
      <WorkspaceDialog open={actionsOpen} title="回放会话操作" onClose={() => setActionsOpen(false)}>
        <p className="muted-text">{session.symbol.ticker} · {formatDisplayTime(session.startTime)} 至 {formatDisplayTime(session.endTime)}</p>
        <div className="workspace-session-actions">
      <button
        disabled={interactionLocked || session.status === 'completed'}
        onClick={() => void replay.jumpToEnd()}
        type="button"
      >
        跳转结束
      </button>
      <button
        disabled={interactionLocked}
        onClick={() => {
          if (
            !session.hasTrades ||
            window.confirm('重置回放会清空当前模拟交易记录，是否继续？')
          ) {
            void replay.reset()
          }
        }}
        type="button"
      >
        重置
      </button>
      <button onClick={() => { void replay.endSession(); setActionsOpen(false) }} type="button">
        结束会话
      </button>
        </div>
        <button type="button" className="dialog-done" onClick={() => setActionsOpen(false)}>完成</button>
      </WorkspaceDialog>
      {replay.busy && replay.preparationStatus && (
        <span className="replay-preparation" role="status">{replay.preparationStatus}</span>
      )}
      {replay.error.length > 0 && (
        <span className="replay-error" role="alert">
          {replay.error}
        </span>
      )}
    </section>
  )
}
