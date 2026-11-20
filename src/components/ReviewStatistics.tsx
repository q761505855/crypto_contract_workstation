import { useId, useMemo, useState, type PointerEvent } from 'react'
import { displayAmount, displayRate } from '../format-amount'
import { formatDisplayTime } from '../format-display-time'
import type { SimulationState } from '../simulation/models'
import { buildBalanceCurve, summarizeClosedPositions, type BalancePoint } from '../simulation/review-statistics'
import './review-statistics.css'

const chartPercent = new Intl.NumberFormat('zh-CN', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 4 })

function Money({ value, currency, signed = false }: { value: string | null; currency: string; signed?: boolean }) {
  if (value === null) return '—'
  return <>{signed && Number(value) > 0 ? '+' : ''}{displayAmount(value)} {currency && <small>{currency}</small>}</>
}

function BalanceChart({ points, currency }: { points: readonly BalancePoint[]; currency: string }) {
  const [mode, setMode] = useState<'balance' | 'drawdown'>('balance')
  const [picked, setPicked] = useState<number | null>(null)
  const fill = useId()
  const heading = useId()
  const last = points.length - 1
  const index = Math.min(picked ?? last, last)
  const { values, x, y, line, ticks, digits } = useMemo(() => {
    const values = points.map(point => Number(point[mode]))
    const low = values.reduce((min, value) => Math.min(min, value), values[0])
    const high = values.reduce((max, value) => Math.max(max, value), values[0])
    const span = high - low
    const y = (value: number) => span ? 100 * ((high - value) / span) : 50
    const x = (pointIndex: number) => last ? 100 * (pointIndex / last) : 0
    const line = values.map((value, i) => `${x(i)},${y(value)}`).join(' ')
    const ticks = span ? [high, low + span / 2, low] : [high]
    const digits = span ? Math.min(8, Math.max(2, 1 - Math.floor(Math.log10(span)))) : 2
    return { values, x, y, line, ticks, digits }
  }, [points, mode, last])
  const format = (value: number) => mode === 'drawdown' ? chartPercent.format(value) : displayAmount(value, digits)
  const time = formatDisplayTime(points[index].timestamp, undefined, 'second')
  const label = mode === 'balance' ? '钱包余额' : '回撤'
  const selectedValue = `${format(values[index])}${mode === 'balance' && currency ? ` ${currency}` : ''}`
  const select = (next: number) => setPicked(Math.max(0, Math.min(last, next)))

  function selectAtPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width > 0) select(Math.round(((event.clientX - rect.left) / rect.width) * last))
  }

  return <section className="review-card review-curve" data-mode={mode} aria-labelledby={heading}>
    <header className="review-card-heading">
      <h3 id={heading}>资金曲线</h3>
      <div className="review-series" role="group" aria-label="曲线显示">
        <button type="button" aria-pressed={mode === 'balance'} onClick={() => setMode('balance')}>钱包余额</button>
        <button type="button" aria-pressed={mode === 'drawdown'} onClick={() => setMode('drawdown')}>回撤</button>
      </div>
    </header>
    <div className="review-chart-readout">
      <strong>{selectedValue}</strong>
      {points[index].timestamp !== null && <span>{time}</span>}
    </div>
    {last === 0 ? <p className="review-chart-empty">尚无余额变动</p> : <>
      <div className="review-chart">
        <div className="review-chart-axis" aria-hidden="true">
          {ticks.map(value => <span key={value} style={{ top: `${y(value)}%` }}>{format(value)}</span>)}
        </div>
        <div className="review-chart-plot" tabIndex={0} role="slider" aria-label={`${label}曲线`}
          aria-valuemin={0} aria-valuemax={last} aria-valuenow={index} aria-valuetext={`${selectedValue}，${time}`}
          onPointerDown={selectAtPointer}
          onPointerMove={event => { if (event.pointerType === 'mouse') selectAtPointer(event) }}
          onKeyDown={event => {
            const next = { ArrowLeft: index - 1, ArrowDown: index - 1, ArrowRight: index + 1, ArrowUp: index + 1, Home: 0, End: last }[event.key]
            if (next === undefined) return
            event.preventDefault()
            select(next)
          }}>
          {ticks.map(value => <span key={value} className="review-chart-gridline" style={{ top: `${y(value)}%` }} aria-hidden="true" />)}
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id={fill} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="currentColor" stopOpacity=".27" />
              <stop offset="100%" stopColor="currentColor" stopOpacity=".02" />
            </linearGradient></defs>
            <polygon points={`0,100 ${line} 100,100`} fill={`url(#${fill})`} />
            <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
          <span className="review-chart-crosshair" style={{ left: `${x(index)}%` }} aria-hidden="true" />
          <span className="review-chart-dot" style={{ left: `${x(index)}%`, top: `${y(values[index])}%` }} aria-hidden="true" />
        </div>
      </div>
      <div className="review-chart-endpoints" aria-hidden="true"><span>初始</span><span>按入账顺序</span><span>最新</span></div>
    </>}
    <p className="review-note">余额计入已实现盈亏、费用及隔夜调整。</p>
  </section>
}

export function ReviewStatistics({ state, currency }: { state: SimulationState; currency: string }) {
  const outcomes = useMemo(() => summarizeClosedPositions(state.trades), [state.trades])
  const curve = useMemo(() => buildBalanceCurve(state.account.initialBalance, state.ledger), [state.account.initialBalance, state.ledger])
  const { totalReturn, totalReturnRate } = state.stats
  const net = Number(totalReturn)
  const groups = [
    { label: '盈利', count: outcomes.wins, tone: 'profit' },
    { label: '亏损', count: outcomes.losses, tone: 'loss' },
    { label: '持平', count: outcomes.breakevens, tone: 'neutral' },
  ]

  return <div className="review-dashboard">
    <dl className="review-metrics">
      <div className="review-card review-metric">
        <dt>总收益</dt>
        <dd className={net > 0 ? 'profit' : net < 0 ? 'loss' : undefined}><Money value={totalReturn} currency={currency} signed /></dd>
        <dd className="review-caption">收益率 {displayRate(totalReturnRate)} · 含浮动盈亏</dd>
      </div>
      <div className="review-card review-metric">
        <dt>胜率</dt>
        <dd>{outcomes.winRate === null ? '—' : displayRate(outcomes.winRate)}</dd>
        <dd className="review-caption">盈利 ÷（盈利 + 亏损）</dd>
      </div>
      <div className="review-card review-metric">
        <dt>盈亏比</dt>
        <dd>{outcomes.payoffRatio === null ? '—' : `${displayAmount(outcomes.payoffRatio)} : 1`}</dd>
        <dd className="review-caption">平均盈利 ÷ 平均亏损绝对值</dd>
      </div>
      <div className="review-card review-metric">
        <dt>最大回撤</dt>
        <dd className={Number(curve.maxDrawdown) > 0 ? 'loss' : undefined}>{chartPercent.format(Number(curve.maxDrawdown))}</dd>
        <dd className="review-caption">钱包余额距前高的最大跌幅</dd>
      </div>
    </dl>
    <div className="review-panels">
      <BalanceChart points={curve.points} currency={currency} />
      <section className="review-card review-outcomes" aria-label="交易表现">
        <header className="review-card-heading"><h3>交易表现</h3><span>按完整平仓</span></header>
        <div className="review-outcome-bar" aria-hidden="true">
          {groups.filter(group => group.count > 0).map(group => <span key={group.tone} data-tone={group.tone} style={{ flexGrow: group.count }} />)}
        </div>
        <dl className="review-outcome-counts">
          {groups.map(group => <div key={group.label}><dt><span className="review-legend-dot" data-tone={group.tone} />{group.label}</dt><dd>{group.count}</dd></div>)}
        </dl>
        <dl className="review-outcome-details">
          {([
            ['完整平仓', outcomes.completed], ['成交次数', state.trades.length],
            ['平均盈利', <Money value={outcomes.averageWin} currency={currency} signed />],
            ['平均亏损', <Money value={outcomes.averageLoss} currency={currency} />],
            ['最大单笔盈利', <Money value={outcomes.largestWin} currency={currency} signed />],
            ['最大单笔亏损', <Money value={outcomes.largestLoss} currency={currency} />],
            ['强平次数', outcomes.liquidations],
          ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <p className="review-note">净盈亏合计分批减仓，并扣除交易及强平费用。</p>
      </section>
    </div>
  </div>
}
