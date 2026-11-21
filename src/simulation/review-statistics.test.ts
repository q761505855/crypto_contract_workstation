import { expect, it } from 'vitest'
import type { SimulationLedgerEntry, SimulationTrade } from './models'
import { summarizeClosedPositions, buildBalanceCurve } from './review-statistics'

function trade(positionSide: SimulationTrade['positionSide'], action: SimulationTrade['action'], quantity: string, realizedPnl = '0', fee = '0', liquidationFee = '0'): SimulationTrade {
  return {
    tradeId: crypto.randomUUID(), sessionId: 'review', timestamp: 0, symbol: 'BTCUSDT', side: 'buy',
    positionSide, action, quantity, price: '100', notional: '100', fee, liquidationFee, slippage: '0', realizedPnl, reason: 'manual',
  }
}

it('combines costs, adds and partial exits by direction before classifying a completed position', () => {
  const result = summarizeClosedPositions([
    trade('long', 'open', '2', '0', '2'),
    trade('short', 'open', '1', '0', '1'),
    trade('long', 'add', '1', '0', '1'),
    trade('long', 'reduce', '1', '-10', '1'),
    trade('short', 'stop_loss', '1', '-7'),
    trade('long', 'liquidation', '1', '-4', '1', '2'),
    trade('long', 'close', '1', '30', '1'),
    trade('short', 'open', '1', '0', '1'),
    trade('short', 'take_profit', '1', '2', '1'),
    trade('long', 'open', '2'),
    trade('long', 'reduce', '1', '100'),
  ])

  expect(result).toMatchObject({
    completed: 3, wins: 1, losses: 1, breakevens: 1, liquidations: 1,
    winRate: '0.5', payoffRatio: '1', averageWin: '8', averageLoss: '-8', largestWin: '8', largestLoss: '-8',
  })
})

it('leaves ratios undefined until their required samples exist', () => {
  expect(summarizeClosedPositions([])).toMatchObject({ winRate: null, payoffRatio: null })
  expect(summarizeClosedPositions([trade('long', 'open', '1'), trade('long', 'close', '1', '10')]))
    .toMatchObject({ winRate: '1', payoffRatio: null, averageLoss: null })
  expect(summarizeClosedPositions([trade('long', 'open', '1'), trade('long', 'close', '1', '-10')]))
    .toMatchObject({ winRate: '0', payoffRatio: null, averageWin: null })
})

function entry(type: SimulationLedgerEntry['type'], balanceAfter: string, timestamp: number, tradeId: string | null = null): SimulationLedgerEntry {
  return { entryId: crypto.randomUUID(), sessionId: 'review', timestamp, type, balanceAfter, amount: '0', tradeId }
}

it('uses posted balances, groups all entries of one fill and keeps independent same-time entries', () => {
  const result = buildBalanceCurve('100', [
    entry('initial_balance', '100', 1),
    entry('realized_pnl', '120', 3, 'close-a'),
    entry('trading_fee', '115', 3, 'close-a'),
    entry('swap', '90', 2),
    entry('trading_fee', '89', 3, 'open-b'),
    entry('realized_pnl', '110', 3, 'close-c'),
  ])

  expect(result.points.map(({ balance, timestamp }) => [balance, timestamp])).toEqual([
    ['100', 1], ['115', 3], ['90', 2], ['89', 3], ['110', 3],
  ])
  expect(Number(result.maxDrawdown)).toBeCloseTo(0.2260869565)
  expect(Number(result.points.at(-1)?.drawdown)).toBeCloseTo(-0.0434782609)
})

it('keeps a zero-drawdown starting point when the wallet has no recorded changes', () => {
  expect(buildBalanceCurve('100', [entry('initial_balance', '100', 1), entry('trading_fee', '100', 1, 'open')])).toEqual({
    maxDrawdown: '0', points: [{ balance: '100', drawdown: '0', timestamp: 1 }],
  })
  expect(buildBalanceCurve('100', []).points).toEqual([{ balance: '100', drawdown: '0', timestamp: null }])
})

it('plots manual wallet changes without counting them in drawdown', () => {
  const result = buildBalanceCurve('100', [
    entry('initial_balance', '100', 1),
    entry('realized_pnl', '80', 2),
    { ...entry('balance_adjustment', '180', 3), amount: '100' },
    entry('realized_pnl', '175', 4),
    { ...entry('balance_adjustment', '0', 5), amount: '-175' },
  ])
  expect(result.points.map(point => [point.balance, point.drawdown])).toEqual([
    ['100', '0'], ['80', '-0.2'], ['180', '-0.2'], ['175', '-0.25'], ['0', '-0.25'],
  ])
  expect(result.maxDrawdown).toBe('0.25')
})
