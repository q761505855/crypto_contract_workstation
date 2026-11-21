import { displayAmount } from '../format-amount'
import { formatDisplayTime } from '../format-display-time'
import type { LedgerEntryType, SimulationLedgerEntry, SimulationTrade, TradeAction } from '../simulation/models'
import './trading-history.css'

const actionLabels: Record<TradeAction, string> = {
  open: '开仓', add: '加仓', reduce: '减仓', close: '平仓', take_profit: '止盈', stop_loss: '止损', liquidation: '强平',
}

const ledgerLabels: Record<LedgerEntryType, string> = {
  initial_balance: '初始资金', realized_pnl: '已实现盈亏', trading_fee: '手续费', liquidation_fee: '强平费用', swap: '隔夜调整',
  balance_adjustment: '余额调整',
}

function Amount({ value, currency, digits = 4, signed = false }: {
  value: string | null
  currency: string
  digits?: number
  signed?: boolean
}) {
  if (value === null) return <span className="history-unavailable">—</span>
  const amount = Number(value)
  const tone = signed ? amount > 0 ? 'positive' : amount < 0 ? 'negative' : undefined : undefined
  return <span className="history-amount" data-tone={tone}>
    {tone === 'positive' && '+'}{displayAmount(amount, digits)}{currency && <> <small>{currency}</small></>}
  </span>
}

export function TradeHistory({ trades, currency, usesLots, volumeText }: {
  trades: readonly SimulationTrade[]
  currency: string
  usesLots: boolean
  volumeText(quantity: string): string
}) {
  if (trades.length === 0) return <p className="history-empty">尚无成交</p>

  return <ol className="history-list" role="list">
    {[...trades].reverse().map(trade => {
      const isLong = trade.positionSide === 'long'
      const opening = trade.action === 'open' || trade.action === 'add'
      return <li key={trade.tradeId} className="history-row history-trade">
        <div className="history-identity">
          <div className="history-row-title">
            <strong data-risk={trade.action === 'liquidation' || undefined}>{actionLabels[trade.action]}</strong>
            <span className="history-badge" data-tone={isLong ? 'positive' : 'negative'}>{isLong ? '多仓' : '空仓'}</span>
          </div>
          <span className="history-time">{formatDisplayTime(trade.timestamp, undefined, 'second')}</span>
        </div>
        <dl className="history-field history-pnl">
          <dt>已实现盈亏</dt>
          <dd><Amount value={opening ? null : trade.realizedPnl} currency={currency} digits={2} signed /></dd>
        </dl>
        <dl className="history-field history-fill">
          <dt>{usesLots ? '手数' : '成交数量'} / 成交价</dt>
          <dd>{volumeText(trade.quantity)}{usesLots ? ' 手' : ''}<span className="history-at"> @ </span>{trade.price}</dd>
        </dl>
        <dl className="history-field history-costs">
          <div><dt>{usesLots ? '佣金' : '手续费'}</dt><dd><Amount value={trade.fee} currency={currency} /></dd></div>
          <div><dt>滑点</dt><dd><Amount value={trade.slippage} currency={currency} /></dd></div>
          {Number(trade.liquidationFee) > 0 && <div><dt>强平费</dt><dd><Amount value={trade.liquidationFee} currency={currency} /></dd></div>}
        </dl>
      </li>
    })}
  </ol>
}

export function AccountLedger({ entries, currency, usesLots }: {
  entries: readonly SimulationLedgerEntry[]
  currency: string
  usesLots: boolean
}) {
  if (entries.length === 0) return <p className="history-empty">暂无流水</p>

  return <ol className="history-list" role="list">
    {[...entries].reverse().map(entry =>
      <li key={entry.entryId} className="history-row history-ledger">
        <div className="history-identity">
          <div className="history-row-title"><strong className="history-badge" data-tone={entry.type === 'liquidation_fee' ? 'negative' : undefined}>
            {entry.type === 'trading_fee' && usesLots ? '交易佣金' : ledgerLabels[entry.type]}
          </strong></div>
          <span className="history-time">{formatDisplayTime(entry.timestamp, undefined, 'second')}</span>
        </div>
        <dl className="history-field history-movement">
          <dt>变动金额</dt>
          <dd><Amount value={entry.amount} currency={currency} signed={entry.type !== 'initial_balance'} /></dd>
        </dl>
        <dl className="history-field history-balance">
          <dt>变动后余额</dt>
          <dd><Amount value={entry.balanceAfter} currency={currency} /></dd>
        </dl>
      </li>
    )}
  </ol>
}
