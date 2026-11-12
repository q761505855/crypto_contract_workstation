import { useEffect, useState } from 'react'
import Decimal from 'decimal.js'
import type { ReplaySession } from '../replay/models'
import type { PositionSide, OrderPreview, SimulationPosition, SimulationState } from '../simulation/models'
import { estimateRiskPnl, riskPricePercent, riskTriggerPrice, type RiskInputMode, type RiskPriceTarget } from '../simulation/risk-price'
import type { SimulationController } from '../simulation/useSimulationController'
import { WorkspaceDialog } from './WorkspaceDialog'
import { PanelToggle } from './PanelToggle'

export function displayAmount(value: string, digits = 2) {
  return Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
const rate = (value: string) => `${(Number(value) * 100).toFixed(2)}%`
const sideName = (side: PositionSide) => side === 'long' ? '多仓' : '空仓'
const actionName = { open: '开仓', add: '加仓', reduce: '减仓', close: '平仓', take_profit: '止盈', stop_loss: '止损', liquidation: '强平' }
const tradeTime = (time: number) => new Date(time).toLocaleString('zh-CN', { hour12: false })

export function AccountStrip({ state, onClose }: { state: SimulationState | null; onClose(): void }) {
  const [details, setDetails] = useState(false)
  if (state === null) return null
  const account = state.account
  return <>
    <section className="account-strip" aria-label="模拟账户摘要">
      <span>账户权益 <strong>{displayAmount(account.equity)}</strong></span>
      <span>可用余额 <strong>{displayAmount(account.availableBalance)}</strong></span>
      <span>浮动盈亏 <strong className={Number(account.unrealizedPnl) >= 0 ? 'profit' : 'loss'}>{displayAmount(account.unrealizedPnl)} USDT</strong></span>
      <button type="button" className="text-button" onClick={() => setDetails(true)}>账户详情</button>
      <PanelToggle label="账户摘要" expanded controls="workspace-account-content" onToggle={onClose} className="panel-close" />
    </section>
    <WorkspaceDialog open={details} title="模拟账户详情" onClose={() => setDetails(false)}>
      <dl className="detail-list">{[
        ['钱包余额', account.walletBalance], ['账户权益', account.equity], ['可用余额', account.availableBalance],
        ['占用保证金', account.usedMargin], ['浮动盈亏', account.unrealizedPnl], ['已实现盈亏', account.realizedPnl], ['累计手续费', account.totalFees],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{displayAmount(value)} USDT</dd></div>)}</dl>
    </WorkspaceDialog>
  </>
}

export function SimulationOrder({ session, simulation, requestedSide, onClose }: {
  session: ReplaySession | null
  simulation: SimulationController
  requestedSide?: PositionSide
  onClose(): void
}) {
  const [direction, setDirection] = useState<PositionSide>('long')
  const [mode, setMode] = useState<'margin' | 'quantity'>('margin')
  const [value, setValue] = useState('100')
  const [preview, setPreview] = useState<OrderPreview | null>(null)
  useEffect(() => { if (requestedSide) { setDirection(requestedSide); setPreview(null) } }, [requestedSide])
  const state = simulation.state
  return <aside className="order-panel side-panel" aria-label="模拟下单面板">
    <header className="panel-heading"><h2>模拟下单</h2><PanelToggle label="下单面板" expanded controls="workspace-order-content" direction="right" onToggle={onClose} /></header>
    {session === null || state === null ? <p className="muted-text">{simulation.busy ? '正在准备模拟账户…' : '创建历史回放会话后即可进行模拟交易。'}</p> : <>
      <div className="order-context"><span>{state.symbol}</span><span>逐仓 · {state.config.leverage}×</span></div>
      <div className="segmented-control" aria-label="下单方向">{(['long', 'short'] as const).map(side => <button key={side} type="button" aria-pressed={direction === side} onClick={() => { setDirection(side); setPreview(null) }}>{side === 'long' ? '多' : '空'}</button>)}</div>
      <label className="panel-field">下单方式<select value={mode} onChange={event => { setMode(event.target.value as typeof mode); setPreview(null) }}><option value="margin">保证金金额</option><option value="quantity">仓位数量</option></select></label>
      <label className="panel-field">{mode === 'margin' ? '保证金（USDT）' : `数量（${state.symbol.replace(/USDT$/, '')}）`}<input aria-label={mode === 'margin' ? '保证金金额' : '仓位数量'} inputMode="decimal" type="number" min="0" value={value} onChange={event => { setValue(event.target.value); setPreview(null) }} /></label>
      {mode === 'margin' && <div className="compact-actions">{[25, 50, 75, 100].map(percent => <button type="button" key={percent} onClick={() => { setValue(new Decimal(state.account.availableBalance).mul(percent).div(100).toDecimalPlaces(4).toString()); setPreview(null) }}>{percent}%</button>)}</div>}
      <p className="order-available">可用 {displayAmount(state.account.availableBalance)} USDT</p>
      <div className="button-row"><button type="button" disabled={simulation.busy} onClick={() => void simulation.preview(direction, mode === 'margin' ? { margin: value } : { quantity: value }).then(setPreview)}>计算预估</button><button type="button" className={direction === 'long' ? 'long-button' : 'short-button'} disabled={simulation.busy} onClick={() => void simulation.open(direction, mode === 'margin' ? { margin: value } : { quantity: value })}>{state.positions.some(position => position.side === direction) ? '同向加仓' : direction === 'long' ? '开多' : '开空'}</button></div>
      {preview && <dl className="order-preview detail-list">{[['预计数量', preview.quantity], ['预计成交价', preview.fillPrice], ['所需保证金', preview.requiredMargin], ['手续费', preview.fee], ['预估强平价', preview.estimatedLiquidationPrice]].map(([label, amount]) => <div key={label}><dt>{label}</dt><dd>{amount}</dd></div>)}</dl>}
      <p className="muted-text">在对应仓位设置止盈止损、减仓或平仓。</p>
    </>}
    {simulation.error && <p className="panel-error" role="alert">{simulation.error}</p>}
  </aside>
}

export type TradingTab = 'positions' | 'trades' | 'stats' | 'ledger'

function RiskEditor({ position, simulation, feeRate, precision }: {
  position: SimulationPosition
  simulation: SimulationController
  feeRate: string
  precision: number
}) {
  const [mode, setMode] = useState<RiskInputMode>('price')
  const [values, setValues] = useState({
    'take-profit': position.takeProfitPrice ?? '', 'stop-loss': position.stopLossPrice ?? '',
  })
  const targets = ['take-profit', 'stop-loss'] as const
  const priceFor = (target: RiskPriceTarget) => riskTriggerPrice(values[target], mode, position, target, precision)

  function changeMode(next: RiskInputMode) {
    const convert = (target: RiskPriceTarget) => {
      const price = priceFor(target)
      if (price === null) return ''
      return next === 'price' ? price.toString() : riskPricePercent(price, position, target)
    }
    setValues({ 'take-profit': convert('take-profit'), 'stop-loss': convert('stop-loss') })
    setMode(next)
  }

  return <>
    <label className="panel-field">设置方式<select aria-label="设置方式" value={mode} onChange={event => changeMode(event.target.value as RiskInputMode)}>
      <option value="price">按价格</option><option value="percent">按百分比（相对开仓均价）</option>
    </select></label>
    {targets.map(target => {
      const takeProfit = target === 'take-profit'
      const label = takeProfit ? '止盈' : '止损'
      const inputLabel = `${label}${mode === 'price' ? '价格' : '百分比'}`
      const price = priceFor(target)
      const pnl = price === null ? null : estimateRiskPnl(position, price, feeRate)
      const save = takeProfit ? simulation.setTakeProfit : simulation.setStopLoss
      return <div key={target}>
        <label className="panel-field">{inputLabel}{mode === 'percent' && '（%）'}<input aria-label={inputLabel} type="number" inputMode="decimal" step="any" value={values[target]} onChange={event => setValues({ ...values, [target]: event.target.value })} /></label>
        <p className="muted-text">预计{label}盈亏 {pnl === null ? '—' : <strong className={pnl.gte(0) ? 'profit' : 'loss'}>{pnl.gt(0) ? '+' : ''}{displayAmount(pnl.toString())} USDT</strong>}{mode === 'percent' && price !== null && ` · 触发价 ${price.toString()}`}</p>
        <div className="compact-actions">
          <button type="button" onClick={() => { if (price !== null) save(position.side, price.toString()) }} disabled={simulation.busy || price === null}>设置{label}</button>
          <button type="button" onClick={() => { save(position.side, null); setValues({ ...values, [target]: '' }) }} disabled={simulation.busy}>取消{label}</button>
        </div>
      </div>
    })}
    <p className="muted-text" role="status">当前止盈 {position.takeProfitPrice ?? '未设置'} / 止损 {position.stopLossPrice ?? '未设置'}</p>
    <p className="muted-text">按触发价估算剩余仓位盈亏，已扣预计平仓手续费。设置从下一根 K 线生效。</p>
  </>
}

export function SimulationDock({ simulation, onClose, tab, onTabChange, pricePrecision = 8 }: {
  simulation: SimulationController
  pricePrecision?: number
  onClose(): void
  tab: TradingTab
  onTabChange(tab: TradingTab): void
}) {
  const [editing, setEditing] = useState<{ side: PositionSide; kind: 'risk' | 'reduce' | 'details' } | null>(null)
  const [quantity, setQuantity] = useState('')
  const state = simulation.state
  const position = state?.positions.find(position => position.side === editing?.side)
  useEffect(() => { if (editing && !position) setEditing(null) }, [editing, position])
  function edit(side: PositionSide, kind: NonNullable<typeof editing>['kind']) {
    const current = state?.positions.find(position => position.side === side)
    if (!current) return
    setQuantity(current.quantity); simulation.clearError(); setEditing({ side, kind })
  }
  const labels: [TradingTab, string][] = [['positions', `持仓 (${state?.positions.length ?? 0})`], ['trades', '成交记录'], ['stats', '复盘统计'], ['ledger', '账户流水']]
  return <section className="simulation-dock" aria-label="持仓与复盘面板">
    <header className="dock-heading"><div role="tablist" aria-label="交易记录类别">{labels.map(([key, label]) => <button key={key} type="button" role="tab" id={`trading-tab-${key}`} aria-controls={`trading-panel-${key}`} aria-selected={tab === key} onClick={() => onTabChange(key)}>{label}</button>)}</div><PanelToggle label="持仓面板" expanded controls="workspace-dock-content" direction="down" onToggle={onClose} /></header>
    <div className="dock-body" role="tabpanel" id={`trading-panel-${tab}`} aria-labelledby={`trading-tab-${tab}`}>
      {!state ? <p className="muted-text">创建回放会话后显示交易记录。</p> : <>
        {tab === 'positions' && (state.positions.length === 0 ? <p className="muted-text">当前无持仓</p> : <div className="position-rows">{state.positions.map(p => <article key={p.side} className="compact-position" data-testid={`position-${p.side}`}>
          <div className="position-summary" data-testid="position-summary">
            <div><span className={p.side === 'long' ? 'profit' : 'loss'}>{sideName(p.side)}</span><span className="muted-text">{p.symbol} · {p.leverage}×</span></div>
            <dl className="position-values"><div><dt>数量</dt><dd>{p.quantity}</dd></div><div><dt>开仓均价</dt><dd>{p.entryPrice}</dd></div><div><dt>当前价格</dt><dd>{p.lastPrice}</dd></div><div><dt>浮动盈亏</dt><dd className={Number(p.unrealizedPnl) >= 0 ? 'profit' : 'loss'}>{displayAmount(p.unrealizedPnl)} USDT</dd></div><div><dt>持仓收益率</dt><dd>{rate(new Decimal(p.unrealizedPnl).div(new Decimal(p.isolatedMargin).isZero() ? 1 : p.isolatedMargin).toString())}</dd></div><div><dt>止盈 / 止损</dt><dd>{p.takeProfitPrice ?? '—'} / {p.stopLossPrice ?? '—'}</dd></div></dl>
          </div>
          <div className="position-actions"><button type="button" onClick={() => edit(p.side, 'risk')}>止盈止损</button><button type="button" onClick={() => edit(p.side, 'reduce')}>减仓 / 平仓</button><button type="button" className="text-button" onClick={() => edit(p.side, 'details')}>详情</button></div>
        </article>)}</div>)}
        {tab === 'trades' && <div className="trade-list">{state.trades.length === 0 ? <p className="muted-text">尚无成交</p> : [...state.trades].reverse().map(trade => <div key={trade.tradeId}><strong>{actionName[trade.action]} · {sideName(trade.positionSide)}</strong><span>{tradeTime(trade.timestamp)}</span><span>{trade.quantity} @ {trade.price}</span><span>手续费 {displayAmount(trade.fee, 4)} · 滑点 {displayAmount(trade.slippage, 4)}</span><span>盈亏 {displayAmount(trade.realizedPnl)} USDT</span></div>)}</div>}
        {tab === 'stats' && <dl className="detail-list stats-grid">{[['总收益', `${displayAmount(state.stats.totalReturn)} USDT`], ['收益率', rate(state.stats.totalReturnRate)], ['成交次数', state.stats.totalTrades], ['完整平仓', state.stats.completedPositions], ['盈利次数', state.stats.wins], ['亏损次数', state.stats.losses], ['胜率', rate(state.stats.winRate)], ['最大单笔盈利', displayAmount(state.stats.largestWin)], ['最大单笔亏损', displayAmount(state.stats.largestLoss)], ['强平次数', state.stats.liquidations]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
        {tab === 'ledger' && <div className="trade-list">{[...state.ledger].reverse().map(entry => <div key={entry.entryId}><strong>{entry.type}</strong><span>{tradeTime(entry.timestamp)}</span><span>变动 {displayAmount(entry.amount, 4)} · 余额 {displayAmount(entry.balanceAfter, 4)}</span></div>)}</div>}
      </>}
    </div>
    <WorkspaceDialog open={editing !== null && position !== undefined} title={editing ? `${sideName(editing.side)} · ${editing.kind === 'risk' ? '止盈止损' : editing.kind === 'reduce' ? '减仓和平仓' : '仓位详情'}` : ''} onClose={() => setEditing(null)}>
      {editing && position && state && <>
        <p className="muted-text">{position.symbol} · {sideName(position.side)} · 剩余数量 {position.quantity}</p>
        {editing.kind === 'risk' && <RiskEditor key={`${state.sessionId}:${position.side}`} position={position} simulation={simulation} feeRate={state.config.feeRate} precision={pricePrecision} />}
        {editing.kind === 'reduce' && <>
          <label className="panel-field">减仓数量<input aria-label="减仓数量" type="number" inputMode="decimal" value={quantity} onChange={event => setQuantity(event.target.value)} /></label>
          <div className="compact-actions">{([25, 50, 75] as const).map(value => <button key={value} type="button" disabled={simulation.busy} onClick={() => void simulation.reducePercent(editing.side, value)}>减 {value}%</button>)}</div>
          <div className="button-row"><button type="button" disabled={simulation.busy || !quantity} onClick={() => void simulation.reduce(editing.side, quantity)}>按数量减仓</button><button type="button" className="danger-button" disabled={simulation.busy} onClick={() => void simulation.closeAll(editing.side)}>全部平仓</button></div>
        </>}
        {editing.kind === 'details' && <dl className="detail-list">{[['逐仓保证金', position.isolatedMargin], ['预估强平价', position.liquidationPrice], ['名义价值', position.notional], ['开仓时间', tradeTime(position.openedAt)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
        {simulation.error && <p role="alert" className="panel-error">{simulation.error}</p>}
        <button type="button" className="dialog-done" onClick={() => setEditing(null)}>完成</button>
      </>}
    </WorkspaceDialog>
  </section>
}
