import { describe, expect, it } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import type { MarketCandle } from '../market-data/models'
import type { ReplaySession, ReplayTradingConfig } from '../replay/models'
import { SimulationEngine } from './simulation-engine'
import { normalizeSimulationStatePrices, type LegacySimulationState } from './models'

const ZERO_FEE_CONFIG: ReplayTradingConfig = {
  initialBalance: '10000',
  leverage: 10,
  feeRate: '0',
  slippageRate: '0',
  maintenanceMarginRate: '0.01',
  liquidationFeeRate: '0',
}

function session(
  config: ReplayTradingConfig = ZERO_FEE_CONFIG,
): ReplaySession {
  return {
    schemaVersion: 2,
    id: 'session-1',
    symbol: DEFAULT_SYMBOL,
    period: SUPPORTED_PERIODS[0],
    startTime: 0,
    endTime: 600_000,
    currentTime: 0,
    currentIndex: 0,
    candleCount: 11,
    speed: 1,
    status: 'paused',
    hasTrades: false,
    active: true,
    tradingConfig: config,
    createdAt: 0,
    updatedAt: 0,
  }
}

function candle(
  openTime: number,
  values: {
    open?: string
    high?: string
    low?: string
    close?: string
  } = {},
): MarketCandle {
  const open = values.open ?? values.close ?? '100'
  const close = values.close ?? open
  return {
    symbol: 'BTCUSDT',
    timeframe: '1m',
    openTime,
    closeTime: openTime + 59_999,
    open,
    high: values.high ?? DecimalMax(open, close),
    low: values.low ?? DecimalMin(open, close),
    close,
    volume: '10',
    quoteVolume: '1000',
    tradeCount: 1,
    isClosed: true,
    source: 'binance',
  }
}

function DecimalMax(left: string, right: string): string {
  return Math.max(Number(left), Number(right)).toString()
}

function DecimalMin(left: string, right: string): string {
  return Math.min(Number(left), Number(right)).toString()
}

describe('SimulationEngine account and position operations', () => {
  it('changes shared contract leverage and prices new orders with it while preserving allocated margin', () => {
    const engine = SimulationEngine.create(session())
    engine.setLeverage(5)
    engine.open('long', { margin: '100' }, candle(0))
    engine.open('short', { quantity: '1' }, candle(0))
    const before = engine.snapshot()
    engine.setLeverage(20)
    const raised = engine.snapshot()
    expect(raised.config.leverage).toBe(20)
    expect(raised.positions).toEqual(before.positions.map(position => ({ ...position, leverage: 20 })))
    expect(raised.account).toEqual(before.account)
    expect(raised.trades).toEqual(before.trades)
    expect(raised.ledger).toEqual(before.ledger)
    expect(engine.previewOpen('long', { margin: '100' }, '100')).toMatchObject({ quantity: '20', requiredMargin: '100' })
    engine.open('short', { quantity: '2' }, candle(0))
    expect(engine.snapshot().positions[1]).toMatchObject({ leverage: 20, quantity: '3', isolatedMargin: '30' })
    expect(SimulationEngine.restore(engine.snapshot(), session()).snapshot()).toMatchObject({ config: { leverage: 20 } })
  })

  it('blocks decreasing leverage while either isolated side remains open', () => {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0))
    engine.open('short', { quantity: '1' }, candle(0))
    engine.closeAll('long', candle(0))
    const before = engine.snapshot()
    expect(() => engine.setLeverage(9)).toThrow(/持仓.*降低杠杆/)
    expect(engine.snapshot()).toEqual(before)
    engine.closeAll('short', candle(0))
    engine.setLeverage(9)
    expect(engine.snapshot().config.leverage).toBe(9)
  })

  it.each([0, -1, 1.5, 126, NaN, Infinity])('rejects invalid leverage adjustments (%s)', leverage => {
    const engine = SimulationEngine.create(session())
    const before = engine.snapshot()
    expect(() => engine.setLeverage(leverage)).toThrow(/杠杆.*整数/)
    expect(engine.snapshot()).toEqual(before)
  })

  it('opens, adds, reduces, and fully closes a long position', () => {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0, { close: '100' }))
    expect(engine.snapshot()).toMatchObject({
      account: { walletBalance: '10000', usedMargin: '10' },
      positions: [{
        side: 'long',
        quantity: '1',
        entryPrice: '100',
        isolatedMargin: '10',
      }],
    })

    engine.open(
      'long',
      { quantity: '1' },
      candle(60_000, { close: '120' }),
    )
    expect(engine.snapshot().positions[0]).toMatchObject({
      quantity: '2',
      entryPrice: '110',
      isolatedMargin: '22',
      liquidationPrice: '100',
    })

    const reduction = engine.reduce(
      'long',
      '1',
      candle(120_000, { close: '130' }),
    )
    expect(reduction).toMatchObject({
      action: 'reduce',
      realizedPnl: '20',
    })
    expect(engine.snapshot()).toMatchObject({
      account: { walletBalance: '10020', realizedPnl: '20' },
      positions: [{
        quantity: '1',
        entryPrice: '110',
        isolatedMargin: '11',
      }],
    })

    engine.closeAll('long', candle(180_000, { close: '130' }))
    expect(engine.snapshot()).toMatchObject({
      account: {
        walletBalance: '10040',
        usedMargin: '0',
        realizedPnl: '40',
      },
      positions: [],
      stats: {
        completedPositions: 1,
        wins: 1,
        largestWin: '20',
      },
    })
  })

  it('calculates short PnL', () => {
    const engine = SimulationEngine.create(session())
    engine.open('short', { quantity: '2' }, candle(0, { close: '100' }))
    engine.closeAll('short', candle(60_000, { close: '80' }))
    expect(engine.snapshot().account.realizedPnl).toBe('40')
  })

  it('deducts deterministic fees and directional slippage', () => {
    const engine = SimulationEngine.create(
      session({
        ...ZERO_FEE_CONFIG,
        feeRate: '0.001',
        slippageRate: '0.01',
      }),
    )
    const trade = engine.open(
      'long',
      { quantity: '1' },
      candle(0, { close: '100' }),
    )
    expect(trade).toMatchObject({
      price: '101',
      notional: '101',
      fee: '0.101',
      slippage: '1',
    })
    expect(engine.snapshot().account.walletBalance).toBe('9999.899')
  })

  it('supports margin sizing and rejects unaffordable orders', () => {
    const engine = SimulationEngine.create(session())
    expect(
      engine.previewOpen('long', { margin: '100' }, '100'),
    ).toMatchObject({
      quantity: '10',
      notional: '1000',
      requiredMargin: '100',
    })
    expect(() =>
      engine.previewOpen('long', { margin: '20000' }, '100'),
    ).toThrow('可用余额不足')
  })

  it('previews the resulting weighted position when adding', () => {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0, { close: '100' }))

    expect(
      engine.previewOpen('long', { quantity: '1' }, '120'),
    ).toMatchObject({
      quantity: '1',
      fillPrice: '120',
      requiredMargin: '12',
      estimatedLiquidationPrice: '100',
    })
    expect(engine.previewOpen('short', { quantity: '1' }, '120').requiredMargin).toBe('12')
  })
})

describe('SimulationEngine candle trigger rules', () => {
  it.each([
    ['long', '110', '100', '115', '99', '110', '10'],
    ['short', '90', '100', '101', '85', '90', '10'],
    ['long', '110', '115', '120', '114', '115', '15'],
    ['short', '90', '85', '86', '80', '85', '15'],
  ] as const)('fills %s take profit at its trigger or a favorable opening gap (%s, open %s)', (side, target, open, high, low, fill, pnl) => {
    const engine = SimulationEngine.create(session({ ...ZERO_FEE_CONFIG, leverage: 2 }))
    engine.open(side, { quantity: '1' }, candle(0))
    engine.setTakeProfit(side, target, 0)
    engine.processCandle(candle(60_000, { open, high, low, close: open }))
    expect(engine.snapshot().positions).toEqual([])
    expect(engine.snapshot().trades.at(-1)).toMatchObject({ positionSide: side, action: 'take_profit', price: fill, realizedPnl: pnl })
  })

  it.each([['long', '120', '240'], ['short', '80', '160']] as const)('values a %s position using the ordinary close', (side, close, notional) => {
    const engine = SimulationEngine.create(session({ ...ZERO_FEE_CONFIG, leverage: 2 }))
    engine.open(side, { quantity: '2' }, candle(0, { close: '100' }))
    expect(engine.processCandle(candle(60_000, { close }))).toEqual({ exitAction: null, warning: null })
    expect(engine.snapshot().positions[0]).toMatchObject({ lastPrice: close, unrealizedPnl: '40', notional })
    expect(engine.snapshot().positions[0]).not.toHaveProperty('markPrice')
    expect(engine.snapshot().account).toMatchObject({ equity: '10040', unrealizedPnl: '40' })
  })

  it('uses the ordinary short gap for liquidation before take profit or stop loss', () => {
    const engine = SimulationEngine.create(session())
    engine.open('short', { quantity: '1' }, candle(0))
    engine.setTakeProfit('short', '90', 0)
    engine.setStopLoss('short', '105', 0)
    expect(engine.processCandle(candle(60_000, { open: '160', high: '170', low: '80', close: '100' })).exitAction).toBe('liquidation')
    expect(engine.snapshot().trades.at(-1)).toMatchObject({ price: '160', realizedPnl: '-60' })
  })
  it('allows moving a long stop loss above entry after the trade price rises', () => {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0, { close: '100' }))
    engine.processCandle(
      candle(60_000, { open: '120', high: '121', low: '119', close: '120' }),
    )

    expect(engine.snapshot().positions[0]).toMatchObject({
      entryPrice: '100',
      lastPrice: '120',
    })
    expect(() => engine.setStopLoss('long', '110', 60_000)).not.toThrow()
    expect(engine.snapshot().positions[0]?.stopLossPrice).toBe('110')
    expect(() => engine.setStopLoss('long', '121', 60_000)).toThrow(
      '止损价格方向不正确',
    )
  })

  it('allows moving a short stop loss below entry after the trade price falls', () => {
    const engine = SimulationEngine.create(session())
    engine.open('short', { quantity: '1' }, candle(0, { close: '100' }))
    engine.processCandle(
      candle(60_000, { open: '80', high: '81', low: '79', close: '80' }),
    )

    expect(() => engine.setStopLoss('short', '90', 60_000)).not.toThrow()
    expect(engine.snapshot().positions[0]?.stopLossPrice).toBe('90')
    expect(() => engine.setStopLoss('short', '79', 60_000)).toThrow(
      '止损价格方向不正确',
    )
  })

  it('does not trigger exits on the candle where TP and SL were set', () => {
    const engine = SimulationEngine.create(
      session({ ...ZERO_FEE_CONFIG, leverage: 2 }),
    )
    engine.open('long', { quantity: '1' }, candle(0, { close: '100' }))
    engine.setTakeProfit('long', '110', 0)
    engine.setStopLoss('long', '90', 0)

    const result = engine.processCandle(
      candle(0, { open: '100', high: '120', low: '1', close: '100' }),
    )
    expect(result.exitAction).toBeNull()
    expect(engine.snapshot().positions[0]).toBeDefined()
  })

  it('uses liquidation, stop loss, take profit priority', () => {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0, { close: '100' }))
    engine.setTakeProfit('long', '110', 0)
    engine.setStopLoss('long', '95', 0)

    const result = engine.processCandle(
      candle(60_000, {
        open: '100',
        high: '120',
        low: '80',
        close: '100',
      }),
    )

    expect(result.exitAction).toBe('liquidation')
    expect(engine.snapshot()).toMatchObject({
      positions: [],
      stats: { liquidations: 1, completedPositions: 1 },
    })
    expect(engine.snapshot().trades.at(-1)?.action).toBe('liquidation')
  })

  it('uses stop loss before take profit when both trade prices are touched', () => {
    const engine = SimulationEngine.create(
      session({ ...ZERO_FEE_CONFIG, leverage: 2 }),
    )
    engine.open('long', { quantity: '1' }, candle(0, { close: '100' }))
    engine.setTakeProfit('long', '110', 0)
    engine.setStopLoss('long', '90', 0)

    const result = engine.processCandle(
      candle(60_000, {
        open: '85',
        high: '120',
        low: '80',
        close: '100',
      }),
    )

    expect(result.exitAction).toBe('stop_loss')
    expect(engine.snapshot().trades.at(-1)).toMatchObject({
      action: 'stop_loss',
      price: '85',
      realizedPnl: '-15',
    })
  })

  it('liquidates from the ordinary candle gap without a separate price source', () => {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0, { close: '100' }))
    const result = engine.processCandle(
      candle(60_000, { open: '50', high: '60', low: '40', close: '50' }),
    )
    expect(result).toEqual({
      exitAction: 'liquidation',
      warning: null,
    })
    expect(engine.snapshot().positions[0]).toBeUndefined()
    expect(engine.snapshot().trades.at(-1)?.price).toBe('50')
  })
})

describe('hedged positions', () => {
  it.each([{ quantity: '0' }, { quantity: '1e-100' }, { margin: '0' }])('rejects zero-sized orders without creating an unarchivable position (%j)', size => {
    const engine = SimulationEngine.create(session())
    const before = engine.snapshot()
    expect(() => engine.open('long', size, candle(0))).toThrow()
    expect(engine.snapshot()).toEqual(before)
  })

  it.each(['0', '1e-100'])('rejects risk prices rounded to zero without mutating either side (%s)', price => {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0))
    engine.open('short', { quantity: '1' }, candle(0))
    const before = engine.snapshot()
    expect(() => engine.setStopLoss('long', price, 0)).toThrow()
    expect(() => engine.setTakeProfit('short', price, 0)).toThrow()
    expect(engine.snapshot()).toEqual(before)
  })

  it('holds both directions, merges only the same side and sums account valuations', () => {
    const engine = SimulationEngine.create(session({ ...ZERO_FEE_CONFIG, leverage: 2 }))
    engine.open('long', { quantity: '2' }, candle(0))
    engine.open('short', { quantity: '1' }, candle(0))
    engine.open('long', { quantity: '2' }, candle(60_000, { close: '120' }))
    expect(engine.snapshot().positions).toMatchObject([
      { side: 'long', quantity: '4', entryPrice: '110', isolatedMargin: '220', unrealizedPnl: '40' },
      { side: 'short', quantity: '1', entryPrice: '100', isolatedMargin: '50', unrealizedPnl: '-20' },
    ])
    expect(engine.snapshot().account).toMatchObject({ usedMargin: '270', availableBalance: '9730', unrealizedPnl: '20', equity: '10020' })
    expect(engine.snapshot().trades.map(trade => trade.action)).toEqual(['open', 'open', 'add'])
    expect(engine.previewOpen('short', { quantity: '1' }, '120').requiredMargin).toBe('60')
  })

  it('binds risk prices to a side through adds, reductions and reopening', () => {
    const engine = SimulationEngine.create(session({ ...ZERO_FEE_CONFIG, leverage: 2 }))
    engine.open('long', { quantity: '2' }, candle(0))
    engine.open('short', { quantity: '2' }, candle(0))
    engine.setTakeProfit('long', '120', 0)
    engine.setStopLoss('long', '90', 0)
    engine.setTakeProfit('short', '80', 0)
    engine.setStopLoss('short', '110', 0)
    engine.open('long', { quantity: '2' }, candle(0))
    engine.reduce('long', '1', candle(0))
    expect(engine.snapshot().positions).toMatchObject([
      { side: 'long', quantity: '3', takeProfitPrice: '120', stopLossPrice: '90' },
      { side: 'short', quantity: '2', takeProfitPrice: '80', stopLossPrice: '110' },
    ])
    engine.closeAll('long', candle(0))
    expect(engine.snapshot().positions).toMatchObject([{ side: 'short', takeProfitPrice: '80', stopLossPrice: '110' }])
    expect(() => engine.setStopLoss('long', '90', 0)).toThrow('当前没有')
    engine.open('long', { quantity: '1' }, candle(0))
    expect(engine.snapshot().positions.find(position => position.side === 'long')).toMatchObject({ takeProfitPrice: null, stopLossPrice: null })
  })

  it('processes both exits on the same candle and does not replay them', () => {
    const engine = SimulationEngine.create(session({ ...ZERO_FEE_CONFIG, leverage: 2 }))
    engine.open('long', { quantity: '1' }, candle(0))
    engine.open('short', { quantity: '2' }, candle(0))
    engine.setTakeProfit('long', '110', 0)
    engine.setStopLoss('short', '105', 0)
    const next = candle(60_000, { open: '100', high: '115', low: '99', close: '112' })
    engine.processCandle(next)
    expect(engine.snapshot().positions).toEqual([])
    expect(engine.snapshot().trades.slice(2)).toMatchObject([
      { positionSide: 'long', action: 'take_profit', price: '110', realizedPnl: '10' },
      { positionSide: 'short', action: 'stop_loss', price: '105', realizedPnl: '-10' },
    ])
    expect(engine.snapshot().account).toMatchObject({ walletBalance: '10000', usedMargin: '0' })
    engine.processCandle(next)
    expect(engine.snapshot().trades).toHaveLength(4)
  })

  it('liquidates only the affected side and values the survivor at the candle close', () => {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0))
    engine.open('short', { quantity: '2' }, candle(0))
    engine.processCandle(candle(60_000, { open: '80', low: '79', high: '85', close: '82' }))
    expect(engine.snapshot().positions).toMatchObject([{ side: 'short', lastPrice: '82', unrealizedPnl: '36' }])
    expect(engine.snapshot().account).toMatchObject({ walletBalance: '9980', equity: '10016', usedMargin: '20', unrealizedPnl: '36' })
    expect(engine.snapshot().stats).toMatchObject({ liquidations: 1, completedPositions: 1 })
  })

  it('rejects sub-precision reductions without writing trades or changing either position', () => {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0))
    engine.open('short', { quantity: '1' }, candle(0))
    const before = engine.snapshot()
    expect(() => engine.reduce('short', '1e-100', candle(0))).toThrow()
    expect(engine.snapshot()).toEqual(before)
  })
})

describe('legacy simulation price migration', () => {
  function legacyState(): LegacySimulationState {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0))
    const { positions, ...fields } = engine.snapshot()
    const state: LegacySimulationState = { ...fields, schemaVersion: 1, position: positions[0] }
    Object.assign(state.position!, { markPrice: '80', lastPrice: '120' })
    state.warning = '缺少当前 K 线的标记价格，已停止强平判断。'
    return state
  }

  it('prefers saved ordinary prices, removes legacy fields and clears only obsolete warnings without mutation', () => {
    const state = legacyState()
    const migrated = normalizeSimulationStatePrices(state)
    expect(migrated.positions[0]?.lastPrice).toBe('120')
    expect(migrated.positions[0]).not.toHaveProperty('markPrice')
    expect(migrated.warning).toBeNull()
    expect(state.position).toHaveProperty('markPrice', '80')
    state.warning = '保留其他警告'
    expect(normalizeSimulationStatePrices(state).warning).toBe('保留其他警告')
  })

  it('uses a legacy price only when an ordinary saved price is missing', () => {
    const state = legacyState()
    delete (state.position as unknown as Record<string, unknown>).lastPrice
    expect(normalizeSimulationStatePrices(state).positions[0]).toMatchObject({ lastPrice: '80' })
    expect(normalizeSimulationStatePrices(state).positions[0]).not.toHaveProperty('markPrice')
  })

  it('revalues a restored position at the current ordinary candle without replaying exits, trades or ledger', () => {
    const state = legacyState()
    const engine = SimulationEngine.restore(state, session())
    engine.revalue(candle(60_000, { open: '50', low: '1', high: '130', close: '120' }))
    expect(engine.snapshot().positions[0]).toMatchObject({ lastPrice: '120', unrealizedPnl: '20', notional: '120' })
    expect(engine.snapshot().positions[0]).not.toHaveProperty('markPrice')
    expect(engine.snapshot().account.equity).toBe('10020')
    expect(engine.snapshot().trades).toEqual(state.trades)
    expect(engine.snapshot().ledger).toEqual(state.ledger)
  })

  it('preserves unrelated saved warnings during a valuation-only restore', () => {
    const state = legacyState()
    state.warning = '保留其他警告'
    const engine = SimulationEngine.restore(state, session())
    engine.revalue(candle(60_000, { close: '120' }))
    expect(engine.snapshot().warning).toBe('保留其他警告')
  })
})
