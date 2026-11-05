import { describe, expect, it } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import type { MarketCandle } from '../market-data/models'
import type { ReplaySession, ReplayTradingConfig } from '../replay/models'
import { SimulationEngine } from './simulation-engine'
import { normalizeSimulationStatePrices, type SimulationState } from './models'

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
  it('opens, adds, reduces, and fully closes a long position', () => {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0, { close: '100' }))
    expect(engine.snapshot()).toMatchObject({
      account: { walletBalance: '10000', usedMargin: '10' },
      position: {
        side: 'long',
        quantity: '1',
        entryPrice: '100',
        isolatedMargin: '10',
      },
    })

    engine.open(
      'long',
      { quantity: '1' },
      candle(60_000, { close: '120' }),
    )
    expect(engine.snapshot().position).toMatchObject({
      quantity: '2',
      entryPrice: '110',
      isolatedMargin: '22',
      liquidationPrice: '100',
    })

    const reduction = engine.reduce(
      '1',
      candle(120_000, { close: '130' }),
    )
    expect(reduction).toMatchObject({
      action: 'reduce',
      realizedPnl: '20',
    })
    expect(engine.snapshot()).toMatchObject({
      account: { walletBalance: '10020', realizedPnl: '20' },
      position: {
        quantity: '1',
        entryPrice: '110',
        isolatedMargin: '11',
      },
    })

    engine.closeAll(candle(180_000, { close: '130' }))
    expect(engine.snapshot()).toMatchObject({
      account: {
        walletBalance: '10040',
        usedMargin: '0',
        realizedPnl: '40',
      },
      position: null,
      stats: {
        completedPositions: 1,
        wins: 1,
        largestWin: '20',
      },
    })
  })

  it('calculates short PnL and blocks opening the opposite direction', () => {
    const engine = SimulationEngine.create(session())
    engine.open('short', { quantity: '2' }, candle(0, { close: '100' }))
    expect(() =>
      engine.open('long', { quantity: '1' }, candle(60_000)),
    ).toThrow('必须先全部平仓')
    engine.closeAll(candle(60_000, { close: '80' }))
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
    expect(() =>
      engine.previewOpen('short', { quantity: '1' }, '120'),
    ).toThrow('必须先全部平仓')
  })
})

describe('SimulationEngine candle trigger rules', () => {
  it.each([['long', '120', '240'], ['short', '80', '160']] as const)('values a %s position using the ordinary close', (side, close, notional) => {
    const engine = SimulationEngine.create(session({ ...ZERO_FEE_CONFIG, leverage: 2 }))
    engine.open(side, { quantity: '2' }, candle(0, { close: '100' }))
    expect(engine.processCandle(candle(60_000, { close }))).toEqual({ exitAction: null, warning: null })
    expect(engine.snapshot().position).toMatchObject({ lastPrice: close, unrealizedPnl: '40', notional })
    expect(engine.snapshot().position).not.toHaveProperty('markPrice')
    expect(engine.snapshot().account).toMatchObject({ equity: '10040', unrealizedPnl: '40' })
  })

  it('uses the ordinary short gap for liquidation before take profit or stop loss', () => {
    const engine = SimulationEngine.create(session())
    engine.open('short', { quantity: '1' }, candle(0))
    engine.setTakeProfit('90', 0)
    engine.setStopLoss('105', 0)
    expect(engine.processCandle(candle(60_000, { open: '160', high: '170', low: '80', close: '100' })).exitAction).toBe('liquidation')
    expect(engine.snapshot().trades.at(-1)).toMatchObject({ price: '160', realizedPnl: '-60' })
  })
  it('allows moving a long stop loss above entry after the trade price rises', () => {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0, { close: '100' }))
    engine.processCandle(
      candle(60_000, { open: '120', high: '121', low: '119', close: '120' }),
    )

    expect(engine.snapshot().position).toMatchObject({
      entryPrice: '100',
      lastPrice: '120',
    })
    expect(() => engine.setStopLoss('110', 60_000)).not.toThrow()
    expect(engine.snapshot().position?.stopLossPrice).toBe('110')
    expect(() => engine.setStopLoss('121', 60_000)).toThrow(
      '止损价格方向不正确',
    )
  })

  it('allows moving a short stop loss below entry after the trade price falls', () => {
    const engine = SimulationEngine.create(session())
    engine.open('short', { quantity: '1' }, candle(0, { close: '100' }))
    engine.processCandle(
      candle(60_000, { open: '80', high: '81', low: '79', close: '80' }),
    )

    expect(() => engine.setStopLoss('90', 60_000)).not.toThrow()
    expect(engine.snapshot().position?.stopLossPrice).toBe('90')
    expect(() => engine.setStopLoss('79', 60_000)).toThrow(
      '止损价格方向不正确',
    )
  })

  it('does not trigger exits on the candle where TP and SL were set', () => {
    const engine = SimulationEngine.create(
      session({ ...ZERO_FEE_CONFIG, leverage: 2 }),
    )
    engine.open('long', { quantity: '1' }, candle(0, { close: '100' }))
    engine.setTakeProfit('110', 0)
    engine.setStopLoss('90', 0)

    const result = engine.processCandle(
      candle(0, { open: '100', high: '120', low: '1', close: '100' }),
    )
    expect(result.exitAction).toBeNull()
    expect(engine.snapshot().position).not.toBeNull()
  })

  it('uses liquidation, stop loss, take profit priority', () => {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0, { close: '100' }))
    engine.setTakeProfit('110', 0)
    engine.setStopLoss('95', 0)

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
      position: null,
      stats: { liquidations: 1, completedPositions: 1 },
    })
    expect(engine.snapshot().trades.at(-1)?.action).toBe('liquidation')
  })

  it('uses stop loss before take profit when both trade prices are touched', () => {
    const engine = SimulationEngine.create(
      session({ ...ZERO_FEE_CONFIG, leverage: 2 }),
    )
    engine.open('long', { quantity: '1' }, candle(0, { close: '100' }))
    engine.setTakeProfit('110', 0)
    engine.setStopLoss('90', 0)

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
    expect(engine.snapshot().position).toBeNull()
    expect(engine.snapshot().trades.at(-1)?.price).toBe('50')
  })
})

describe('legacy simulation price migration', () => {
  function legacyState(): SimulationState {
    const engine = SimulationEngine.create(session())
    engine.open('long', { quantity: '1' }, candle(0))
    const state = engine.snapshot()
    Object.assign(state.position!, { markPrice: '80', lastPrice: '120' })
    state.warning = '缺少当前 K 线的标记价格，已停止强平判断。'
    return state
  }

  it('prefers saved ordinary prices, removes legacy fields and clears only obsolete warnings without mutation', () => {
    const state = legacyState()
    const migrated = normalizeSimulationStatePrices(state)
    expect(migrated.position?.lastPrice).toBe('120')
    expect(migrated.position).not.toHaveProperty('markPrice')
    expect(migrated.warning).toBeNull()
    expect(state.position).toHaveProperty('markPrice', '80')
    state.warning = '保留其他警告'
    expect(normalizeSimulationStatePrices(state).warning).toBe('保留其他警告')
  })

  it('uses a legacy price only when an ordinary saved price is missing', () => {
    const state = legacyState()
    delete (state.position as unknown as Record<string, unknown>).lastPrice
    expect(normalizeSimulationStatePrices(state).position).toMatchObject({ lastPrice: '80' })
    expect(normalizeSimulationStatePrices(state).position).not.toHaveProperty('markPrice')
  })

  it('revalues a restored position at the current ordinary candle without replaying exits, trades or ledger', () => {
    const state = legacyState()
    const engine = SimulationEngine.restore(state, session())
    engine.revalue(candle(60_000, { open: '50', low: '1', high: '130', close: '120' }))
    expect(engine.snapshot().position).toMatchObject({ lastPrice: '120', unrealizedPnl: '20', notional: '120' })
    expect(engine.snapshot().position).not.toHaveProperty('markPrice')
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
