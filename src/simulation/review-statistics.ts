import Decimal from 'decimal.js'
import type { PositionSide, SimulationLedgerEntry, SimulationTrade } from './models'

export function summarizeClosedPositions(trades: readonly SimulationTrade[]) {
  const active = new Map<PositionSide, { quantity: Decimal; netPnl: Decimal }>()
  const zero = new Decimal(0)
  let winTotal = zero
  let lossTotal = zero
  let largestWin: Decimal | null = null
  let largestLoss: Decimal | null = null
  let wins = 0
  let losses = 0
  let breakevens = 0
  let liquidations = 0

  for (const trade of trades) {
    const { action, positionSide } = trade
    const quantity = new Decimal(trade.quantity)
    const netPnl = new Decimal(trade.realizedPnl).minus(trade.fee).minus(trade.liquidationFee)
    if (action === 'liquidation') liquidations += 1
    if (action === 'open') {
      active.set(positionSide, { quantity, netPnl })
      continue
    }

    const position = active.get(positionSide)
    if (position === undefined) continue
    position.netPnl = position.netPnl.plus(netPnl)
    position.quantity = action === 'add' ? position.quantity.plus(quantity) : position.quantity.minus(quantity)
    if (position.quantity.gt(0)) continue

    active.delete(positionSide)
    if (!position.quantity.isZero()) continue
    if (position.netPnl.gt(0)) {
      wins += 1
      winTotal = winTotal.plus(position.netPnl)
      largestWin = Decimal.max(largestWin ?? zero, position.netPnl)
    } else if (position.netPnl.lt(0)) {
      losses += 1
      lossTotal = lossTotal.plus(position.netPnl)
      largestLoss = Decimal.min(largestLoss ?? zero, position.netPnl)
    } else {
      breakevens += 1
    }
  }

  const averageWin = wins ? winTotal.div(wins) : null
  const averageLoss = losses ? lossTotal.div(losses) : null
  return {
    completed: wins + losses + breakevens,
    wins,
    losses,
    breakevens,
    liquidations,
    winRate: wins + losses ? new Decimal(wins).div(wins + losses).toString() : null,
    payoffRatio: averageWin && averageLoss ? averageWin.div(averageLoss.abs()).toString() : null,
    averageWin: averageWin?.toString() ?? null,
    averageLoss: averageLoss?.toString() ?? null,
    largestWin: largestWin?.toString() ?? null,
    largestLoss: largestLoss?.toString() ?? null,
  }
}

export interface BalancePoint {
  timestamp: number | null
  balance: string
  drawdown: string
}

export function buildBalanceCurve(initialBalance: string, ledger: readonly SimulationLedgerEntry[]) {
  const points: BalancePoint[] = [{ timestamp: ledger[0]?.timestamp ?? null, balance: initialBalance, drawdown: '0' }]
  let peak = new Decimal(initialBalance)
  let maxDrawdown = new Decimal(0)
  let previous = peak
  let balanceAdjustments = new Decimal(0)

  for (const [index, entry] of ledger.entries()) {
    // An execution can post P&L and costs separately. Plot its final balance once.
    if (entry.tradeId !== null && entry.tradeId === ledger[index + 1]?.tradeId) continue
    const balance = new Decimal(entry.balanceAfter)
    if (entry.type === 'balance_adjustment') balanceAdjustments = balanceAdjustments.plus(entry.amount)
    if (balance.eq(previous)) continue

    const tradingBalance = balance.minus(balanceAdjustments)
    peak = Decimal.max(peak, tradingBalance)
    const drawdown = tradingBalance.minus(peak).div(peak)
    maxDrawdown = Decimal.max(maxDrawdown, drawdown.negated())
    points.push({ timestamp: entry.timestamp, balance: balance.toString(), drawdown: drawdown.toString() })
    previous = balance
  }

  return { points, maxDrawdown: maxDrawdown.toString() }
}
