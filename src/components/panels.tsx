import { useEffect, useState } from 'react'
import Decimal from 'decimal.js'
import type { ReplaySession } from '../replay/models'
import type { LiveMarketStatus } from '../market-data/live-models'
import type {
  OrderPreview,
  PositionSide,
  SimulationState,
} from '../simulation/models'
import type { SimulationController } from '../simulation/useSimulationController'

function amount(value: string, digits = 2): string {
  const parsed = Number(value)
  return Number.isFinite(parsed)
    ? parsed.toLocaleString('zh-CN', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : value
}

function percent(value: string): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(2)}%` : value
}

function tradeAction(action: SimulationState['trades'][number]['action']): string {
  return {
    open: '开仓',
    add: '加仓',
    reduce: '减仓',
    close: '平仓',
    take_profit: '止盈',
    stop_loss: '止损',
    liquidation: '强平',
  }[action]
}

function tradeReason(reason: SimulationState['trades'][number]['reason']): string {
  return {
    manual: '手动',
    take_profit: '止盈触发',
    stop_loss: '止损触发',
    liquidation: '强平触发',
  }[reason]
}

function displayTradeTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp)
}

function AccountSummary({ state }: { state: SimulationState }) {
  const rows = [
    ['钱包余额', `${amount(state.account.walletBalance)} USDT`],
    ['账户权益', `${amount(state.account.equity)} USDT`],
    ['可用余额', `${amount(state.account.availableBalance)} USDT`],
    ['占用保证金', `${amount(state.account.usedMargin)} USDT`],
    ['浮动盈亏', `${amount(state.account.unrealizedPnl)} USDT`],
    ['已实现盈亏', `${amount(state.account.realizedPnl)} USDT`],
    ['累计手续费', `${amount(state.account.totalFees, 4)} USDT`],
  ] as const
  return (
    <dl>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function PositionSummary({ state }: { state: SimulationState }) {
  const position = state.position
  if (position === null) {
    return <p className="muted-text">当前无持仓</p>
  }
  const unrealizedPnl = new Decimal(position.unrealizedPnl)
  const isolatedMargin = new Decimal(position.isolatedMargin)
  const returnRate = isolatedMargin.isZero()
    ? new Decimal(0)
    : unrealizedPnl.div(isolatedMargin)
  const profitClass = unrealizedPnl.gt(0)
    ? 'profit'
    : unrealizedPnl.lt(0)
      ? 'loss'
      : undefined
  return (
    <>
      <dl className="position-summary" data-testid="position-summary">
        <div>
          <dt>方向</dt>
          <dd className={position.side === 'long' ? 'profit' : 'loss'}>
            {position.side === 'long' ? '多仓' : '空仓'}
          </dd>
        </div>
        <div>
          <dt>数量</dt>
          <dd>{position.quantity}</dd>
        </div>
        <div>
          <dt>开仓均价</dt>
          <dd>{position.entryPrice}</dd>
        </div>
        <div>
          <dt>标记价格</dt>
          <dd>{position.markPrice}</dd>
        </div>
        <div>
          <dt>浮动盈亏</dt>
          <dd className={profitClass}>
            {amount(position.unrealizedPnl)} USDT
          </dd>
        </div>
        <div>
          <dt>持仓收益率</dt>
          <dd className={profitClass}>{percent(returnRate.toString())}</dd>
        </div>
        <div>
          <dt>逐仓保证金</dt>
          <dd>{amount(position.isolatedMargin)} USDT</dd>
        </div>
        <div>
          <dt>预估强平价</dt>
          <dd>{position.liquidationPrice}</dd>
        </div>
        <div>
          <dt>止盈 / 止损</dt>
          <dd>
            {position.takeProfitPrice ?? '—'} / {position.stopLossPrice ?? '—'}
          </dd>
        </div>
      </dl>
      <p className="muted-text position-drag-hint">
        拖动图表上的开仓均价线可创建止盈或止损；拖动止盈、止损线可修改触发价。
      </p>
    </>
  )
}

interface SimulationPanelProps {
  session: ReplaySession | null
  simulation: SimulationController
}

export function SimulationPanel({
  session,
  simulation,
}: SimulationPanelProps) {
  const [sizeMode, setSizeMode] = useState<'margin' | 'quantity'>('margin')
  const [sizeValue, setSizeValue] = useState('100')
  const [direction, setDirection] = useState<PositionSide>('long')
  const [preview, setPreview] = useState<OrderPreview | null>(null)
  const [reduceQuantity, setReduceQuantity] = useState('')
  const [takeProfit, setTakeProfit] = useState('')
  const [stopLoss, setStopLoss] = useState('')
  const state = simulation.state

  useEffect(() => {
    if (state?.position !== null && state?.position !== undefined) {
      setDirection(state.position.side)
      setTakeProfit(state.position.takeProfitPrice ?? '')
      setStopLoss(state.position.stopLossPrice ?? '')
    } else {
      setTakeProfit('')
      setStopLoss('')
    }
  }, [
    state?.position?.side,
    state?.position?.takeProfitPrice,
    state?.position?.stopLossPrice,
  ])

  if (session === null) {
    return (
      <aside className="side-panel" data-testid="simulation-panel">
        <h2>模拟交易</h2>
        <p>创建历史回放会话后即可进行模拟交易。</p>
      </aside>
    )
  }

  if (state === null) {
    return (
      <aside className="side-panel" data-testid="simulation-panel">
        <h2>模拟账户</h2>
        <p>{simulation.busy ? '正在准备模拟账户…' : '模拟账户不可用'}</p>
        {simulation.error && <p className="panel-error">{simulation.error}</p>}
      </aside>
    )
  }

  const position = state.position
  const orderInput =
    sizeMode === 'margin'
      ? { margin: sizeValue }
      : { quantity: sizeValue }

  async function calculatePreview(): Promise<void> {
    setPreview(await simulation.preview(direction, orderInput))
  }

  function setMarginPercent(value: number): void {
    const available = new Decimal(state!.account.availableBalance)
    setSizeMode('margin')
    setSizeValue(available.mul(value).div(100).toDecimalPlaces(4).toString())
    setPreview(null)
  }

  return (
    <aside className="side-panel" data-testid="simulation-panel">
      <section>
        <h2>模拟账户</h2>
        <AccountSummary state={state} />
      </section>
      <section>
        <h2>当前持仓</h2>
        <PositionSummary state={state} />
      </section>
      <section>
        <h2>模拟下单</h2>
        <div className="segmented-control" aria-label="下单方向">
          <button
            aria-pressed={direction === 'long'}
            disabled={position?.side === 'short'}
            onClick={() => {
              setDirection('long')
              setPreview(null)
            }}
            type="button"
          >
            多
          </button>
          <button
            aria-pressed={direction === 'short'}
            disabled={position?.side === 'long'}
            onClick={() => {
              setDirection('short')
              setPreview(null)
            }}
            type="button"
          >
            空
          </button>
        </div>
        <label className="panel-field">
          下单方式
          <select
            onChange={(event) => {
              setSizeMode(event.target.value as 'margin' | 'quantity')
              setPreview(null)
            }}
            value={sizeMode}
          >
            <option value="margin">保证金金额</option>
            <option value="quantity">仓位数量</option>
          </select>
        </label>
        <label className="panel-field">
          {sizeMode === 'margin' ? '保证金（USDT）' : '数量'}
          <input
            aria-label={sizeMode === 'margin' ? '保证金金额' : '仓位数量'}
            min="0"
            onChange={(event) => {
              setSizeValue(event.target.value)
              setPreview(null)
            }}
            type="number"
            value={sizeValue}
          />
        </label>
        {sizeMode === 'margin' && (
          <div className="compact-actions">
            {[25, 50, 75, 100].map((value) => (
              <button
                key={value}
                onClick={() => setMarginPercent(value)}
                type="button"
              >
                {value}%
              </button>
            ))}
          </div>
        )}
        <div className="button-row">
          <button
            disabled={simulation.busy}
            onClick={() => void calculatePreview()}
            type="button"
          >
            计算预估
          </button>
          <button
            className={direction === 'long' ? 'long-button' : 'short-button'}
            disabled={simulation.busy}
            onClick={() => void simulation.open(direction, orderInput)}
            type="button"
          >
            {position === null
              ? direction === 'long'
                ? '开多'
                : '开空'
              : '同向加仓'}
          </button>
        </div>
        {preview !== null && (
          <dl className="order-preview">
            <div>
              <dt>预计数量</dt>
              <dd>{preview.quantity}</dd>
            </div>
            <div>
              <dt>预计成交价</dt>
              <dd>{preview.fillPrice}</dd>
            </div>
            <div>
              <dt>名义价值</dt>
              <dd>{amount(preview.notional)} USDT</dd>
            </div>
            <div>
              <dt>所需保证金</dt>
              <dd>{amount(preview.requiredMargin)} USDT</dd>
            </div>
            <div>
              <dt>手续费</dt>
              <dd>{amount(preview.fee, 4)} USDT</dd>
            </div>
            <div>
              <dt>预估强平价</dt>
              <dd>{preview.estimatedLiquidationPrice}</dd>
            </div>
          </dl>
        )}
      </section>
      {position !== null && (
        <section>
          <h2>仓位管理</h2>
          <label className="panel-field">
            减仓数量
            <input
              aria-label="减仓数量"
              min="0"
              onChange={(event) => setReduceQuantity(event.target.value)}
              type="number"
              value={reduceQuantity}
            />
          </label>
          <div className="compact-actions">
            {[25, 50, 75].map((value) => (
              <button
                key={value}
                disabled={simulation.busy}
                onClick={() =>
                  void simulation.reducePercent(value as 25 | 50 | 75)
                }
                type="button"
              >
                减 {value}%
              </button>
            ))}
          </div>
          <div className="button-row">
            <button
              disabled={simulation.busy || reduceQuantity.length === 0}
              onClick={() => void simulation.reduce(reduceQuantity)}
              type="button"
            >
              按数量减仓
            </button>
            <button
              className="danger-button"
              disabled={simulation.busy}
              onClick={() => void simulation.closeAll()}
              type="button"
            >
              全部平仓
            </button>
          </div>
          <label className="panel-field">
            止盈价格
            <input
              aria-label="止盈价格"
              min="0"
              onChange={(event) => setTakeProfit(event.target.value)}
              type="number"
              value={takeProfit}
            />
          </label>
          <div className="compact-actions">
            <button
              onClick={() => simulation.setTakeProfit(takeProfit || null)}
              type="button"
            >
              设置止盈
            </button>
            <button
              onClick={() => simulation.setTakeProfit(null)}
              type="button"
            >
              取消
            </button>
          </div>
          <label className="panel-field">
            止损价格
            <input
              aria-label="止损价格"
              min="0"
              onChange={(event) => setStopLoss(event.target.value)}
              type="number"
              value={stopLoss}
            />
          </label>
          <div className="compact-actions">
            <button
              onClick={() => simulation.setStopLoss(stopLoss || null)}
              type="button"
            >
              设置止损
            </button>
            <button
              onClick={() => simulation.setStopLoss(null)}
              type="button"
            >
              取消
            </button>
          </div>
        </section>
      )}
      <section>
        <h2>本会话统计</h2>
        <dl>
          <div>
            <dt>总收益</dt>
            <dd>{amount(state.stats.totalReturn)} USDT</dd>
          </div>
          <div>
            <dt>收益率</dt>
            <dd>{percent(state.stats.totalReturnRate)}</dd>
          </div>
          <div>
            <dt>成交次数</dt>
            <dd>{state.stats.totalTrades}</dd>
          </div>
          <div>
            <dt>完整平仓</dt>
            <dd>{state.stats.completedPositions}</dd>
          </div>
          <div>
            <dt>盈利次数</dt>
            <dd>{state.stats.wins}</dd>
          </div>
          <div>
            <dt>亏损次数</dt>
            <dd>{state.stats.losses}</dd>
          </div>
          <div>
            <dt>胜率</dt>
            <dd>{percent(state.stats.winRate)}</dd>
          </div>
          <div>
            <dt>最大单笔盈利</dt>
            <dd>{amount(state.stats.largestWin)} USDT</dd>
          </div>
          <div>
            <dt>最大单笔亏损</dt>
            <dd>{amount(state.stats.largestLoss)} USDT</dd>
          </div>
          <div>
            <dt>强平次数</dt>
            <dd>{state.stats.liquidations}</dd>
          </div>
        </dl>
      </section>
      <section>
        <h2>最近成交</h2>
        {state.trades.length === 0 ? (
          <p className="muted-text">尚无成交</p>
        ) : (
          <div className="trade-list">
            {[...state.trades]
              .reverse()
              .slice(0, 10)
              .map((trade) => (
                <div key={trade.tradeId}>
                  <strong>
                    {tradeAction(trade.action)} ·{' '}
                    {trade.positionSide === 'long' ? '多仓' : '空仓'}
                  </strong>
                  <span>{displayTradeTime(trade.timestamp)}</span>
                  <span>
                    {trade.quantity} @ {trade.price}
                  </span>
                  <span>
                    手续费 {amount(trade.fee, 4)} · 滑点{' '}
                    {amount(trade.slippage, 4)}
                  </span>
                  <span>
                    {tradeReason(trade.reason)} · 盈亏{' '}
                    {amount(trade.realizedPnl)}
                  </span>
                </div>
              ))}
          </div>
        )}
      </section>
      <details className="ledger-details">
        <summary>账户流水（{state.ledger.length}）</summary>
        <div className="trade-list">
          {[...state.ledger]
            .reverse()
            .slice(0, 20)
            .map((entry) => (
              <div key={entry.entryId}>
                <strong>{entry.type}</strong>
                <span>{displayTradeTime(entry.timestamp)}</span>
                <span>
                  变动 {amount(entry.amount, 4)} · 余额{' '}
                  {amount(entry.balanceAfter, 4)}
                </span>
              </div>
            ))}
        </div>
      </details>
      <p className="liquidation-disclaimer">
        预估强平价仅用于历史训练，并非币安精确结果。
      </p>
      {state.warning !== null && (
        <p className="panel-warning">{state.warning}</p>
      )}
      {simulation.error.length > 0 && (
        <p className="panel-error" role="alert">
          {simulation.error}
        </p>
      )}
    </aside>
  )
}

const connectionLabels: Record<
  LiveMarketStatus['connection'],
  string
> = {
  connecting: '正在连接',
  connected: '已连接',
  reconnecting: '正在重连',
  disconnected: '已断开',
}

export function LiveStatus({ status }: { status: LiveMarketStatus }) {
  return (
    <aside className="side-panel" data-testid="live-status">
      <h2>实时行情</h2>
      <p>只读模式</p>
      <dl>
        <div>
          <dt>连接状态</dt>
          <dd>{connectionLabels[status.connection]}</dd>
        </div>
        <div>
          <dt>最后消息</dt>
          <dd>
            {status.lastMessageTime === null
              ? '—'
              : displayTradeTime(status.lastMessageTime)}
          </dd>
        </div>
        <div>
          <dt>数据延迟</dt>
          <dd>
            {status.latencyMs === null ? '—' : `${status.latencyMs} ms`}
          </dd>
        </div>
        <div>
          <dt>当前 K 线</dt>
          <dd>
            {status.candleClosed === null
              ? '—'
              : status.candleClosed
                ? '已完成'
                : '进行中'}
          </dd>
        </div>
        <div>
          <dt>最新价格</dt>
          <dd>{status.lastPrice ?? '—'}</dd>
        </div>
        <div>
          <dt>标记价格</dt>
          <dd>{status.markPrice ?? '—'}</dd>
        </div>
        {status.reconnectAttempt > 0 && (
          <div>
            <dt>重连次数</dt>
            <dd>{status.reconnectAttempt}</dd>
          </div>
        )}
      </dl>
      {status.warning.length > 0 && (
        <p className="panel-warning">{status.warning}</p>
      )}
      <p className="muted-text">此模式不提供任何下单操作。</p>
    </aside>
  )
}
