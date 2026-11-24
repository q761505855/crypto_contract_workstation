import { useCallback, useEffect, useRef, useState } from 'react'
import Decimal from 'decimal.js'
import { isOkxPriceSource, priceSourceLabel, type PriceSource } from '../market-data/price-source-preferences'
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
import { OKX_SIMULATION_TAKER_FEE, okxMaximumLeverage, type ReplayTradingTerms as TradingTerms } from '../simulation/okx-trading'
import { MAX_ADJUSTABLE_LEVERAGE, minimumContractLeverage } from '../simulation/models'
import type { SimulationController } from '../simulation/useSimulationController'
import { WorkspaceDialog } from './WorkspaceDialog'
import { TimeJumpControl } from './TimeJumpControl'
import { formatDisplayTime } from '../format-display-time'

interface ReplayControlsProps {
  priceSource?: PriceSource
  market: { getReplayTradingTerms(symbol: string, start: number, signal?: AbortSignal): Promise<TradingTerms> }
  selection: MarketSelection
  replay: ReplayController<ReplayStepPeriod>
  simulation: SimulationController
  stepPeriod: ReplayStepPeriod
  onStepPeriodChange: (period: ReplayStepPeriod) => void
  showTradeOverlays: boolean
  onTradeOverlaysChange: (visible: boolean) => void
  interactionLocked?: boolean
  chartStartTime: number | null
  onJumpToTime: (timestamp: number) => void
  onLocateLatest: () => void
  onChartStep: (direction: -1 | 1) => void
}

function sessionName(session: ReplaySession): string {
  const { marketSource } = session
  const time = formatDisplayTime(session.startTime)
  const label = isOkxPriceSource(marketSource) ? priceSourceLabel(marketSource)
    : marketSource !== 'ctrader' ? '币安存档' : session.tradingConfig.ctrader ? undefined : '旧模拟规则'
  return `${session.symbol.ticker} ${session.period.text} · ${time}${label === undefined ? '' : ` · ${label}`}`
}

const HOLD_TO_PLAY_MS = 450

function ReplayTradingTerms({ terms, waiting, source }: { terms?: TradingTerms; waiting?: string; source: PriceSource }) {
  if (isOkxPriceSource(source)) {
    const okx = terms && 'tickSize' in terms ? terms : undefined
    return <details className="replay-advanced">
      <summary>OKX 逐仓交易规格</summary>
      <div>{okx ? <dl className="detail-list">
        <div><dt>保证金和结算货币</dt><dd>USDT</dd></div>
        <div><dt>杠杆上限</dt><dd>{okxMaximumLeverage(okx)}×（随持仓档位变化）</dd></div>
        <div><dt>每张合约单位</dt><dd>{okx.contractValue}</dd></div>
        <div><dt>最小张数 / 张数步长</dt><dd>{okx.minContracts} / {okx.contractStep}</dd></div>
        <div><dt>市价单上限</dt><dd>{okx.maxOrderContracts} 张</dd></div>
        <div><dt>最小价格变动</dt><dd>{okx.tickSize}</dd></div>
        <div><dt>模拟吃单费率</dt><dd>{new Decimal(OKX_SIMULATION_TAKER_FEE).mul(100).toString()}%</dd></div>
        <div><dt>首档维持保证金率</dt><dd>{new Decimal(okx.tiers[0].maintenanceMarginRate).mul(100).toString()}%</dd></div>
      </dl> : <p className="muted-text">{waiting}</p>}</div>
    </details>
  }
  const ctrader = terms as CTraderTradingTerms | undefined
  return <details className="replay-advanced">
    <summary>IC Markets 交易规格</summary>
    <div>
      {ctrader ? <dl className="detail-list">
        <div><dt>账户杠杆上限</dt><dd>{ctrader.accountLeverage}×</dd></div>
        <div><dt>品种起始杠杆</dt><dd>{cTraderLeverage(ctrader)}×（按名义金额分档）</dd></div>
        <div><dt>每手合约单位</dt><dd>{ctrader.lotSize}</dd></div>
        <div><dt>最小手数 / 手数步长</dt><dd>{new Decimal(ctrader.minQuantity).div(ctrader.lotSize).toString()} / {new Decimal(ctrader.quantityStep).div(ctrader.lotSize).toString()}</dd></div>
        <div><dt>佣金</dt><dd>{ctrader.commission.type === 3
          ? new Decimal(ctrader.commission.rate).mul(100).toString() + '% 名义金额'
          : ctrader.commission.rate + (ctrader.commission.type === 1 ? ' USD / 百万美元成交额' : ' ' + (ctrader.commission.type === 2 ? 'USD' : ctrader.quoteCurrency) + ' / 手')}</dd></div>
        <div><dt>账户强平线</dt><dd>{new Decimal(ctrader.stopOutRate).mul(100).toString()}% 保证金水平</dd></div>
        {ctrader.swap && <div><dt>隔夜调整</dt><dd>多 {ctrader.swap.long} / 空 {ctrader.swap.short}（会话规格）</dd></div>}
      </dl> : <p className="muted-text">{waiting}</p>}
    </div>
  </details>
}

function NextCandleButton({ next, play, pause, disabled, label }: {
  next: () => void | Promise<void>
  play: () => void
  pause: () => void
  disabled: boolean
  label: string
}) {
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
  priceSource = 'ctrader',
  market,
  selection,
  replay,
  simulation,
  stepPeriod,
  onStepPeriodChange,
  showTradeOverlays,
  onTradeOverlaysChange,
  interactionLocked = false,
  chartStartTime,
  onJumpToTime,
  onLocateLatest,
  onChartStep,
}: ReplayControlsProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [initialBalance, setInitialBalance] = useState(
    DEFAULT_TRADING_CONFIG.initialBalance,
  )
  const [slippageRate, setSlippageRate] = useState('0')
  const [leverageDraft, setLeverageDraft] = useState<string | null>(null)
  const [activeLeverage, setActiveLeverage] = useState<string | null>(null)
  const [activeSlippage, setActiveSlippage] = useState<string | null>(null)
  const [walletDraft, setWalletDraft] = useState<string | null>(null)
  const [terms, setTerms] = useState<TradingTerms | null>(null)
  const [termsError, setTermsError] = useState('')
  const [viewportSpeed, setViewportSpeed] = useState<ReplaySpeed>(1)
  const [viewportPlaying, setViewportPlaying] = useState(false)
  const ticker = selection.symbol.ticker
  const session = replay.session
  const viewportLocked = interactionLocked || chartStartTime === null || session !== null
  const playViewport = useCallback(() => setViewportPlaying(true), [])
  const pauseViewport = useCallback(() => setViewportPlaying(false), [])
  const nextViewportCandle = useCallback(() => onChartStep(1), [onChartStep])

  useEffect(pauseViewport, [pauseViewport, ticker, selection.period.text, viewportLocked])
  useEffect(() => {
    if (viewportLocked || !viewportPlaying) return
    const timer = window.setInterval(nextViewportCandle, 1000 / viewportSpeed)
    return () => window.clearInterval(timer)
  }, [nextViewportCandle, viewportLocked, viewportPlaying, viewportSpeed])

  const state = session !== null && simulation.state?.sessionId === session.id ? simulation.state : null
  const config = state?.config ?? session?.tradingConfig
  const displayedTerms = session === null ? terms : config?.okx ?? config?.ctrader
  const okx = displayedTerms && 'tickSize' in displayedTerms ? displayedTerms : undefined
  const minimumLeverage = session !== null && !config?.ctrader && state ? minimumContractLeverage(state) : 1
  const sourceMaximum = displayedTerms ? ('tickSize' in displayedTerms ? okxMaximumLeverage(displayedTerms) : cTraderLeverage(displayedTerms)) : undefined
  const defaultLeverage = okx ? Math.min(DEFAULT_TRADING_CONFIG.leverage, okxMaximumLeverage(okx)) : sourceMaximum
  const maximumLeverage = session === null ? sourceMaximum : sourceMaximum ?? MAX_ADJUSTABLE_LEVERAGE
  const leverageText = session === null ? leverageDraft ?? (defaultLeverage?.toString() ?? '')
    : activeLeverage ?? (config?.leverage.toString() ?? '')
  const slippageText = session === null ? slippageRate : activeSlippage ?? config?.slippageRate ?? '0'
  const leverage = Number(leverageText)
  const slippage = Number(slippageText)
  const validLeverage = (session === null && leverageDraft === null) || leverage === config?.leverage ||
    (Number.isInteger(leverage) && leverage >= minimumLeverage && (maximumLeverage === undefined || leverage <= maximumLeverage))
  const validSlippage = slippageText === config?.slippageRate || (slippageText !== '' && slippage >= 0 && slippage < 1)
  const balance = Number(initialBalance)
  const validCreation = chartStartTime !== null && validLeverage && validSlippage && Number.isFinite(balance) && balance > 0
  const walletBalance = Number(walletDraft)
  const validWalletBalance = walletDraft !== null && walletDraft !== '' && Number.isFinite(walletBalance) && walletBalance >= 0

  useEffect(() => {
    if (!settingsOpen || session !== null || chartStartTime === null) return
    const request = new AbortController()
    setTerms(null)
    setTermsError('')
    void market.getReplayTradingTerms(ticker, chartStartTime, request.signal).then(result => {
      if (!request.signal.aborted) setTerms(result)
    }, (error: unknown) => {
      if (!request.signal.aborted) setTermsError(error instanceof Error ? error.message : '无法读取交易规格')
    })
    return () => request.abort()
  }, [settingsOpen, session?.id, ticker, chartStartTime, market])

  const selectedSession = replay.sessions.find((session) => session.id === selectedSessionId) ?? replay.sessions[0]

  useEffect(() => setLeverageDraft(null), [ticker])
  useEffect(() => setSettingsOpen(false), [session?.id])

  function openSettings(): void {
    if (session === null) pauseViewport()
    setActiveLeverage(null)
    setActiveSlippage(null)
    setWalletDraft(null)
    setSettingsOpen(true)
  }

  function createSession(): void {
    if (!validCreation || chartStartTime === null) return
    pauseViewport()
    void replay.createSession({
      symbol: selection.symbol, period: selection.period, startTime: chartStartTime,
      initialBalance, slippageRate,
      ...(leverageDraft === null ? {} : { leverage }),
    })
    setSettingsOpen(false)
  }

  async function applyOrderSettings(): Promise<void> {
    if (!state || !validLeverage || !validSlippage || interactionLocked) return
    if (await simulation.setOrderSettings({ leverage, slippageRate: slippageText })) {
      setActiveLeverage(current => current === activeLeverage ? null : current)
      setActiveSlippage(current => current === activeSlippage ? null : current)
    }
  }

  async function applyWalletBalance(): Promise<void> {
    if (!state || walletDraft === null || !validWalletBalance || interactionLocked) return
    if (await simulation.setWalletBalance(walletDraft)) {
      setWalletDraft(current => current === walletDraft ? null : current)
    }
  }

  const orderFields = <>
    <div className="replay-leverage-setting">
      <label className="panel-field">模拟杠杆（×）
        <input aria-label="杠杆倍率（×）" type="number" inputMode="numeric" step="1" min={minimumLeverage}
          max={maximumLeverage} value={leverageText}
          placeholder={session === null ? '按账户和品种规格' : undefined}
          onChange={event => (session === null ? setLeverageDraft : setActiveLeverage)(event.target.value)} />
      </label>
      {defaultLeverage !== undefined && <button type="button" onClick={() => {
        if (session === null) setLeverageDraft(null)
        else setActiveLeverage(String(defaultLeverage))
      }}>使用默认杠杆</button>}
    </div>
    {defaultLeverage !== undefined && <p className="muted-text">默认 {defaultLeverage}×。调整后按所选倍率和品种档位计算新增保证金。</p>}
    <label className="panel-field">额外模拟滑点率
      <input type="number" inputMode="decimal" min="0" step="any" aria-label="额外模拟滑点率" value={slippageText}
        onChange={event => (session === null ? setSlippageRate : setActiveSlippage)(event.target.value)} />
    </label>
    <p className="muted-text">滑点率需小于 1，0.001 表示 0.1%。</p>
  </>

  const stepSelect = <select aria-label="步进周期" disabled={interactionLocked}
    value={isCTraderReplayStepPeriod(stepPeriod) ? stepPeriod : '1m'}
    onChange={event => onStepPeriodChange(validateReplayStepPeriod(event.target.value))}>
    {priceSource === 'ctrader' && FINE_STEP_PERIODS.map(period => <option key={period} value={period}>{period === 'tick' ? '逐笔 Tick' : period}</option>)}
    {CTRADER_TIMEFRAMES.map(period => <option key={period} value={period}>{period}</option>)}
  </select>
  const speedSelect = <select aria-label={session === null ? '播放速度' : '回放速度'} disabled={interactionLocked}
    value={session?.speed ?? viewportSpeed}
    onChange={event => (session === null ? setViewportSpeed : replay.setSpeed)(Number(event.target.value) as ReplaySpeed)}>
    {[1, 2, 5, 10].map(speed => <option key={speed} value={speed}>{speed}x</option>)}
  </select>

  function deleteSelectedSession(session: ReplaySession): void {
    if (window.confirm(`删除本机回放会话「${sessionName(session)}」及其模拟账户、持仓、成交和流水？`)) {
      void replay.deleteSession(session.id)
    }
  }

  if (session === null) {
    const startLabel = chartStartTime === null ? '等待图表 K 线' : formatDisplayTime(chartStartTime)
    return <section className="replay-controls replay-setup" data-testid="replay-controls">
      <TimeJumpControl compact disabled={interactionLocked}
        defaultTimestamp={priceSource === 'okx-local' ? chartStartTime ?? undefined : undefined}
        onJump={timestamp => { pauseViewport(); onJumpToTime(timestamp) }}
        onLocateLatest={() => { pauseViewport(); onLocateLatest() }} />
      <button type="button" disabled={viewportLocked} onClick={() => { pauseViewport(); onChartStep(-1) }}>上一根</button>
      <NextCandleButton key={`${ticker}:${selection.period.text}`} disabled={viewportLocked} label="下一根"
        next={nextViewportCandle} play={playViewport} pause={pauseViewport} />
      <button type="button" disabled={viewportLocked} onClick={viewportPlaying ? pauseViewport : playViewport}>
        {viewportPlaying ? '暂停' : '播放'}
      </button>
      {speedSelect}
      <span className="replay-start-time">起点：{startLabel}</span>
      <button type="button" onClick={openSettings}>回放设置</button>
      <button type="button" disabled={interactionLocked || !validCreation} onClick={createSession}>{replay.busy ? '准备中…' : '创建回放'}</button>
      {replay.busy && replay.preparationStatus && <span className="replay-preparation" role="status">{replay.preparationStatus}</span>}
      {!settingsOpen && replay.error && <span className="replay-error" role="alert">{replay.error}</span>}
      <WorkspaceDialog open={settingsOpen} title="回放会话设置" onClose={() => setSettingsOpen(false)}>
        <p className="muted-text">{selection.symbol.ticker} · {selection.period.text} · 起点：{startLabel}</p>
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
        {orderFields}
        <ReplayTradingTerms terms={terms ?? undefined} source={priceSource}
          waiting={termsError || (chartStartTime === null ? '请先在图表上选定回放起点。' : '正在读取账户和品种规格…')} />
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
                disabled={replay.busy || selectedSession.marketSource !== priceSource}
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
        <div className="button-row"><button type="button" onClick={() => setSettingsOpen(false)}>应用设置</button><button type="button" disabled={interactionLocked || !validCreation} onClick={createSession}>开始历史回放</button></div>
      </WorkspaceDialog>
    </section>
  }

  const native = session.marketSource === 'ctrader' || isOkxPriceSource(session.marketSource)
  const onTick = session.cursorTimeframe === 'tick'
  const currentTime = onTick ? session.currentTime : sessionVisibleUntil(session) - (native ? 0 : 60_000)
  const precision = onTick ? 'millisecond' : isFineStepPeriod(session.cursorTimeframe) ? 'second' : 'minute'
  return (
    <section className="replay-controls" data-testid="replay-controls">
      <TimeJumpControl compact
        defaultTimestamp={priceSource === 'okx-local' ? session.currentTime : undefined}
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
      <label className="replay-step-period">步进{stepSelect}</label>
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
        next={replay.next}
        play={replay.play}
        pause={replay.pause}
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
      {speedSelect}
      <button type="button" className="trade-overlays-toggle" aria-pressed={showTradeOverlays}
        onClick={() => onTradeOverlaysChange(!showTradeOverlays)} title={showTradeOverlays ? '隐藏图表交易标记' : '显示图表交易标记'}>交易标记</button>
      <button type="button" className="replay-settings-actions" onClick={openSettings}>回放设置</button>
      <WorkspaceDialog open={settingsOpen} title="回放会话设置" onClose={() => setSettingsOpen(false)}>
        <p className="muted-text">{session.symbol.ticker} · {session.period.text} · 起点 {formatDisplayTime(session.startTime)}</p>
        <dl className="detail-list">
          <div><dt>初始资金</dt><dd>{session.tradingConfig.initialBalance} {displayedTerms?.accountCurrency ?? session.symbol.priceCurrency}</dd></div>
          <div><dt>当前进度</dt><dd>{formatDisplayTime(currentTime, undefined, precision)}</dd></div>
        </dl>
        <div className="replay-wallet-setting">
          <label className="panel-field">钱包余额{displayedTerms ? `（${displayedTerms.accountCurrency}）` : ''}
            <input type="number" inputMode="decimal" min="0" step="any" aria-label="钱包余额" disabled={!state}
              value={walletDraft ?? state?.account.walletBalance ?? ''} onChange={event => setWalletDraft(event.target.value)} />
          </label>
          <button type="button" disabled={interactionLocked || !state || !validWalletBalance}
            onClick={() => void applyWalletBalance()}>设置余额</button>
        </div>
        <p className="muted-text">余额差额计入账户流水，复盘收益与回撤按交易表现计算。</p>
        {orderFields}
        <button type="button" disabled={interactionLocked || !state || !validLeverage || !validSlippage ||
          (activeLeverage === null && activeSlippage === null)} onClick={() => void applyOrderSettings()}>应用交易参数</button>
        {simulation.error && <p className="panel-error" role="alert">{simulation.error}</p>}
        {replay.error && <p className="replay-error" role="alert">{replay.error}</p>}
        {displayedTerms ? <ReplayTradingTerms terms={displayedTerms} source={priceSource} /> : <details className="replay-advanced">
          <summary>会话交易规格</summary>
          <div><dl className="detail-list">
            <div><dt>手续费率</dt><dd>{new Decimal(session.tradingConfig.feeRate).mul(100).toString()}%</dd></div>
            <div><dt>维持保证金率</dt><dd>{new Decimal(session.tradingConfig.maintenanceMarginRate).mul(100).toString()}%</dd></div>
            <div><dt>强平费率</dt><dd>{new Decimal(session.tradingConfig.liquidationFeeRate).mul(100).toString()}%</dd></div>
          </dl></div>
        </details>}
        <div className="workspace-session-actions">
      <button
        disabled={interactionLocked || session.status === 'completed'}
        onClick={() => { setSettingsOpen(false); void replay.jumpToEnd() }}
        type="button"
      >
        跳转结束
      </button>
      <button
        disabled={interactionLocked}
        onClick={() => {
          if (
            (!session.hasTrades && !state?.ledger.some(entry => entry.type === 'balance_adjustment')) ||
            window.confirm('重置回放会清空当前模拟交易和余额调整记录，是否继续？')
          ) {
            setWalletDraft(null)
            void replay.reset()
          }
        }}
        type="button"
      >
        重置
      </button>
      <button disabled={interactionLocked} onClick={() => { void replay.endSession(); setSettingsOpen(false) }} type="button">
        结束会话
      </button>
        </div>
        <button type="button" className="dialog-done" onClick={() => setSettingsOpen(false)}>完成</button>
      </WorkspaceDialog>
      {replay.busy && replay.preparationStatus && (
        <span className="replay-preparation" role="status">{replay.preparationStatus}</span>
      )}
      {!settingsOpen && replay.error.length > 0 && (
        <span className="replay-error" role="alert">
          {replay.error}
        </span>
      )}
    </section>
  )
}
