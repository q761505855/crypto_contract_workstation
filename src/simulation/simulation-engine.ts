import Decimal from 'decimal.js'
import type { MarketCandle } from '../market-data/models'
import type { ReplaySession, ReplayTradingConfig } from '../replay/models'
import { isAdjustableLeverage, MAX_ADJUSTABLE_LEVERAGE, minimumContractLeverage, normalizeSimulationStatePrices } from './models'
import type {
  CandleProcessResult,
  LedgerEntryType,
  OrderPreview,
  OrderSizeInput,
  PositionSide,
  SimulationLedgerEntry,
  SimulationPosition,
  SimulationState,
  StoredSimulationState,
  SimulationStats,
  SimulationTrade,
  TradeAction,
  TradeReason,
  TradeSide,
} from './models'

const ZERO = new Decimal(0)

function decimal(value: Decimal.Value, field: string): Decimal {
  let result: Decimal
  try {
    result = new Decimal(value)
  } catch {
    throw new Error(`${field} 不是有效数字`)
  }
  if (!result.isFinite()) {
    throw new Error(`${field} 不是有效数字`)
  }
  return result
}

function nonNegative(value: Decimal.Value, field: string): Decimal {
  const result = decimal(value, field)
  if (result.isNegative()) {
    throw new Error(`${field} 不能为负数`)
  }
  return result
}

function positive(value: Decimal.Value, field: string): Decimal {
  const result = decimal(value, field)
  if (result.lessThanOrEqualTo(0)) {
    throw new Error(`${field} 必须大于 0`)
  }
  return result
}

function id(): string {
  return crypto.randomUUID()
}

function text(value: Decimal): string {
  return value.isZero() ? '0' : value.toString()
}

function emptyStats(): SimulationStats {
  return {
    totalReturn: '0',
    totalReturnRate: '0',
    totalTrades: 0,
    completedPositions: 0,
    wins: 0,
    losses: 0,
    winRate: '0',
    largestWin: '0',
    largestLoss: '0',
    liquidations: 0,
  }
}

export function validateSimulationConfig(
  config: ReplayTradingConfig,
): void {
  positive(config.initialBalance, '初始资金')
  if (!Number.isInteger(config.leverage) || config.leverage < 1) {
    throw new Error('杠杆必须是大于等于 1 的整数')
  }
  nonNegative(config.feeRate, '手续费率')
  nonNegative(config.slippageRate, '滑点率')
  nonNegative(config.maintenanceMarginRate, '维持保证金率')
  nonNegative(config.liquidationFeeRate, '强平费用率')
  const riskRates = decimal(config.maintenanceMarginRate, '维持保证金率').plus(
    config.liquidationFeeRate,
  )
  if (riskRates.greaterThanOrEqualTo(1)) {
    throw new Error('维持保证金率与强平费用率之和必须小于 1')
  }
}

export function validateAdjustableLeverage(leverage: number): void {
  if (!isAdjustableLeverage(leverage)) {
    throw new Error(`杠杆必须是 1–${MAX_ADJUSTABLE_LEVERAGE} 的整数`)
  }
}

export class SimulationEngine {
  private state: SimulationState
  private readonly pricePrecision: number
  private readonly quantityPrecision: number

  private constructor(
    state: StoredSimulationState,
    symbolPrecision: { price: number; quantity: number },
    private readonly now: () => number,
  ) {
    this.state = normalizeSimulationStatePrices(state)
    this.pricePrecision = symbolPrecision.price
    this.quantityPrecision = symbolPrecision.quantity
  }

  static create(
    session: ReplaySession,
    now: () => number = Date.now,
  ): SimulationEngine {
    validateSimulationConfig(session.tradingConfig)
    const initial = positive(
      session.tradingConfig.initialBalance,
      '初始资金',
    )
    const timestamp = now()
    const state: SimulationState = {
      schemaVersion: 2,
      sessionId: session.id,
      symbol: session.symbol.ticker.toUpperCase(),
      config: { ...session.tradingConfig },
      account: {
        initialBalance: text(initial),
        walletBalance: text(initial),
        equity: text(initial),
        availableBalance: text(initial),
        usedMargin: '0',
        realizedPnl: '0',
        unrealizedPnl: '0',
        totalFees: '0',
        totalLiquidationFees: '0',
      },
      positions: [],
      trades: [],
      ledger: [
        {
          entryId: id(),
          sessionId: session.id,
          timestamp: session.startTime,
          type: 'initial_balance',
          amount: text(initial),
          balanceAfter: text(initial),
          tradeId: null,
        },
      ],
      stats: emptyStats(),
      warning: null,
      updatedAt: timestamp,
    }
    return new SimulationEngine(
      state,
      {
        price: session.symbol.pricePrecision ?? 8,
        quantity: session.symbol.volumePrecision ?? 8,
      },
      now,
    )
  }

  static restore(
    state: StoredSimulationState,
    session: ReplaySession,
    now: () => number = Date.now,
  ): SimulationEngine {
    validateSimulationConfig(state.config)
    if (state.sessionId !== session.id) {
      throw new Error('模拟交易状态与回放会话不匹配')
    }
    return new SimulationEngine(
      state,
      {
        price: session.symbol.pricePrecision ?? 8,
        quantity: session.symbol.volumePrecision ?? 8,
      },
      now,
    )
  }

  snapshot(): SimulationState {
    return structuredClone(this.state)
  }

  setLeverage(leverage: number): void {
    validateAdjustableLeverage(leverage)
    if (leverage < minimumContractLeverage(this.state)) {
      throw new Error('逐仓有持仓时不能降低杠杆')
    }
    this.state.config.leverage = leverage
    // Both hedge sides share the contract setting; their allocated collateral is separate.
    for (const position of this.state.positions) position.leverage = leverage
    this.touch()
  }

  previewOpen(
    side: PositionSide,
    size: OrderSizeInput,
    referencePrice: string,
  ): OrderPreview {
    const existing = this.findPosition(side)
    const fillPrice = this.marketFillPrice(
      positive(referencePrice, '当前价格'),
      side === 'long' ? 'buy' : 'sell',
    )
    const { quantity, margin } = this.resolveOrderSize(size, fillPrice)
    const notional = quantity.mul(fillPrice)
    const fee = notional.mul(this.state.config.feeRate)
    const available = decimal(
      this.state.account.availableBalance,
      '可用余额',
    )
    if (margin.plus(fee).greaterThan(available)) {
      throw new Error('可用余额不足以支付保证金和手续费')
    }
    const resultingQuantity =
      existing === null
        ? quantity
        : decimal(existing.quantity, '持仓数量').plus(quantity)
    const resultingEntry =
      existing === null
        ? fillPrice
        : decimal(existing.entryPrice, '开仓均价')
            .mul(existing.quantity)
            .plus(fillPrice.mul(quantity))
            .div(resultingQuantity)
    const resultingMargin =
      existing === null
        ? margin
        : decimal(existing.isolatedMargin, '逐仓保证金').plus(margin)
    return {
      quantity: text(quantity),
      fillPrice: text(this.roundPrice(fillPrice)),
      notional: text(notional),
      requiredMargin: text(margin),
      fee: text(fee),
      estimatedLiquidationPrice: text(
        this.roundPrice(
          this.liquidationPrice(
            side,
            resultingQuantity,
            resultingEntry,
            resultingMargin,
          ),
        ),
      ),
    }
  }

  open(
    side: PositionSide,
    size: OrderSizeInput,
    candle: MarketCandle,
  ): SimulationTrade {
    const reference = positive(candle.close, '当前 K 线收盘价')
    const tradeSide: TradeSide = side === 'long' ? 'buy' : 'sell'
    const fillPrice = this.marketFillPrice(reference, tradeSide)
    const { quantity, margin } = this.resolveOrderSize(size, fillPrice)
    const notional = quantity.mul(fillPrice)
    const fee = notional.mul(this.state.config.feeRate)
    const available = decimal(
      this.state.account.availableBalance,
      '可用余额',
    )
    if (margin.plus(fee).greaterThan(available)) {
      throw new Error('可用余额不足以支付保证金和手续费')
    }

    const existing = this.findPosition(side)
    const action: TradeAction = existing === null ? 'open' : 'add'
    let position: SimulationPosition
    if (existing === null) {
      position = {
        symbol: this.state.symbol,
        side,
        quantity: text(quantity),
        entryPrice: text(this.roundPrice(fillPrice)),
        lastPrice: text(this.roundPrice(reference)),
        notional: text(quantity.mul(reference)),
        leverage: this.state.config.leverage,
        isolatedMargin: text(margin),
        maintenanceMarginRate:
          this.state.config.maintenanceMarginRate,
        liquidationPrice: '0',
        takeProfitPrice: null,
        stopLossPrice: null,
        unrealizedPnl: '0',
        openedAt: candle.openTime,
        updatedAt: candle.openTime,
        riskActiveAfterTime: candle.openTime,
        takeProfitActiveAfterTime: null,
        stopLossActiveAfterTime: null,
      }
    } else {
      const oldQuantity = decimal(existing.quantity, '持仓数量')
      const totalQuantity = oldQuantity.plus(quantity)
      const weightedEntry = decimal(existing.entryPrice, '开仓均价')
        .mul(oldQuantity)
        .plus(fillPrice.mul(quantity))
        .div(totalQuantity)
      position = {
        ...existing,
        quantity: text(totalQuantity),
        entryPrice: text(this.roundPrice(weightedEntry)),
        lastPrice: text(this.roundPrice(reference)),
        isolatedMargin: text(
          decimal(existing.isolatedMargin, '逐仓保证金').plus(margin),
        ),
        updatedAt: candle.openTime,
        riskActiveAfterTime: candle.openTime,
      }
    }
    position.liquidationPrice = text(
      this.roundPrice(
        this.liquidationPrice(
          position.side,
          decimal(position.quantity, '持仓数量'),
          decimal(position.entryPrice, '开仓均价'),
          decimal(position.isolatedMargin, '逐仓保证金'),
        ),
      ),
    )

    if (existing === null) this.state.positions.push(position)
    else this.state.positions[this.state.positions.indexOf(existing)] = position
    this.applyWalletChange(fee.negated(), 'trading_fee', candle.openTime)
    const trade = this.recordTrade({
      timestamp: candle.openTime,
      side: tradeSide,
      positionSide: side,
      action,
      quantity,
      price: fillPrice,
      fee,
      liquidationFee: ZERO,
      slippage: fillPrice.minus(reference).abs().mul(quantity),
      realizedPnl: ZERO,
      reason: 'manual',
    })
    this.attachTradeToLatestLedger(trade.tradeId)
    this.recalculate(reference, candle.openTime)
    return trade
  }

  reduce(
    side: PositionSide,
    quantityValue: string,
    candle: MarketCandle,
    action: 'reduce' | 'close' = 'reduce',
  ): SimulationTrade {
    const position = this.requirePosition(side)
    const currentQuantity = decimal(position.quantity, '持仓数量')
    const quantity = this.roundQuantity(
      positive(quantityValue, '减仓数量'),
    )
    if (quantity.lessThanOrEqualTo(0)) throw new Error('按当前精度计算后的减仓数量为 0')
    if (quantity.greaterThan(currentQuantity)) {
      throw new Error('减仓数量不能大于当前持仓数量')
    }
    const isFullClose = quantity.equals(currentQuantity)
    const resolvedAction: TradeAction = isFullClose ? 'close' : action
    return this.closeQuantity(
      position,
      quantity,
      positive(candle.close, '当前 K 线收盘价'),
      candle.openTime,
      resolvedAction,
      'manual',
      true,
    )
  }

  closeAll(side: PositionSide, candle: MarketCandle): SimulationTrade {
    const position = this.requirePosition(side)
    return this.reduce(side, position.quantity, candle, 'close')
  }

  setTakeProfit(side: PositionSide, priceValue: string | null, currentTime: number): void {
    const position = this.requirePosition(side)
    if (priceValue === null) {
      position.takeProfitPrice = null
      position.takeProfitActiveAfterTime = null
    } else {
      const price = positive(this.roundPrice(positive(priceValue, '止盈价格')), '止盈价格')
      const currentPrice = decimal(
        position.lastPrice,
        '当前成交价格',
      )
      if (
        (position.side === 'long' &&
          price.lessThanOrEqualTo(currentPrice)) ||
        (position.side === 'short' &&
          price.greaterThanOrEqualTo(currentPrice))
      ) {
        throw new Error('止盈价格方向不正确')
      }
      position.takeProfitPrice = text(price)
      position.takeProfitActiveAfterTime = currentTime
    }
    position.updatedAt = currentTime
    this.touch()
  }

  setStopLoss(side: PositionSide, priceValue: string | null, currentTime: number): void {
    const position = this.requirePosition(side)
    if (priceValue === null) {
      position.stopLossPrice = null
      position.stopLossActiveAfterTime = null
    } else {
      const price = positive(this.roundPrice(positive(priceValue, '止损价格')), '止损价格')
      const currentPrice = decimal(
        position.lastPrice,
        '当前成交价格',
      )
      if (
        (position.side === 'long' &&
          price.greaterThanOrEqualTo(currentPrice)) ||
        (position.side === 'short' &&
          price.lessThanOrEqualTo(currentPrice))
      ) {
        throw new Error('止损价格方向不正确')
      }
      position.stopLossPrice = text(price)
      position.stopLossActiveAfterTime = currentTime
    }
    position.updatedAt = currentTime
    this.touch()
  }

  /** Refresh restored valuation without replaying an already processed candle's exits. */
  revalue(candle: MarketCandle): void {
    this.recalculate(positive(candle.close, '当前成交价格'), candle.openTime)
  }

  processCandle(tradeCandle: MarketCandle): CandleProcessResult {
    let exitAction: TradeAction | null = null
    // Each side is evaluated independently, even if the other side exits on this candle.
    for (const position of [...this.state.positions]) {
      const action = this.processPositionCandle(position, tradeCandle)
      if (action === 'liquidation' || (action === 'stop_loss' && exitAction !== 'liquidation') || exitAction === null) {
        exitAction = action ?? exitAction
      }
    }
    this.recalculate(positive(tradeCandle.close, '当前成交价格'), tradeCandle.openTime)
    this.state.warning = null
    return { exitAction, warning: null }
  }

  private processPositionCandle(position: SimulationPosition, tradeCandle: MarketCandle): TradeAction | null {
    if (
      tradeCandle.openTime > position.riskActiveAfterTime &&
      this.liquidationTouched(position, tradeCandle)
    ) {
      const trigger = decimal(position.liquidationPrice, '预估强平价')
      const open = decimal(tradeCandle.open, 'K 线开盘价')
      const exitPrice =
        position.side === 'long'
          ? Decimal.min(trigger, open)
          : Decimal.max(trigger, open)
      this.closeTriggered(
        position,
        exitPrice,
        trigger,
        tradeCandle.openTime,
        'liquidation',
        'liquidation',
      )
      return 'liquidation'
    }

    if (
      position.stopLossPrice !== null &&
      position.stopLossActiveAfterTime !== null &&
      tradeCandle.openTime > position.stopLossActiveAfterTime &&
      this.stopLossTouched(position, tradeCandle)
    ) {
      const trigger = decimal(position.stopLossPrice, '止损价格')
      const open = decimal(tradeCandle.open, 'K 线开盘价')
      const exitPrice =
        position.side === 'long'
          ? Decimal.min(trigger, open)
          : Decimal.max(trigger, open)
      this.closeTriggered(
        position,
        exitPrice,
        trigger,
        tradeCandle.openTime,
        'stop_loss',
        'stop_loss',
      )
      return 'stop_loss'
    }

    if (
      position.takeProfitPrice !== null &&
      position.takeProfitActiveAfterTime !== null &&
      tradeCandle.openTime > position.takeProfitActiveAfterTime &&
      this.takeProfitTouched(position, tradeCandle)
    ) {
      const trigger = decimal(position.takeProfitPrice, '止盈价格')
      const open = decimal(tradeCandle.open, 'K 线开盘价')
      const exitPrice =
        position.side === 'long'
          ? Decimal.max(trigger, open)
          : Decimal.min(trigger, open)
      this.closeTriggered(
        position,
        exitPrice,
        trigger,
        tradeCandle.openTime,
        'take_profit',
        'take_profit',
      )
      return 'take_profit'
    }

    return null
  }

  private resolveOrderSize(
    size: OrderSizeInput,
    fillPrice: Decimal,
  ): { quantity: Decimal; margin: Decimal } {
    const hasMargin = size.margin !== undefined && size.margin.trim() !== ''
    const hasQuantity =
      size.quantity !== undefined && size.quantity.trim() !== ''
    if (hasMargin === hasQuantity) {
      throw new Error('保证金金额和仓位数量必须且只能填写一项')
    }
    if (hasMargin) {
      const requestedMargin = positive(size.margin!, '保证金金额')
      const quantity = this.roundQuantity(
        requestedMargin.mul(this.state.config.leverage).div(fillPrice),
      )
      if (quantity.lessThanOrEqualTo(0)) {
        throw new Error('按当前精度计算后的仓位数量为 0')
      }
      return {
        quantity,
        margin: quantity.mul(fillPrice).div(this.state.config.leverage),
      }
    }
    const quantity = this.roundQuantity(
      positive(size.quantity!, '仓位数量'),
    )
    if (quantity.lessThanOrEqualTo(0)) {
      throw new Error('按当前精度计算后的仓位数量为 0')
    }
    return {
      quantity,
      margin: quantity.mul(fillPrice).div(this.state.config.leverage),
    }
  }

  private closeQuantity(
    position: SimulationPosition,
    quantity: Decimal,
    reference: Decimal,
    timestamp: number,
    action: TradeAction,
    reason: TradeReason,
    applySlippage: boolean,
  ): SimulationTrade {
    const tradeSide: TradeSide =
      position.side === 'long' ? 'sell' : 'buy'
    const fillPrice = applySlippage
      ? this.marketFillPrice(reference, tradeSide)
      : reference
    const oldQuantity = decimal(position.quantity, '持仓数量')
    const entry = decimal(position.entryPrice, '开仓均价')
    const realized =
      position.side === 'long'
        ? fillPrice.minus(entry).mul(quantity)
        : entry.minus(fillPrice).mul(quantity)
    const notional = fillPrice.mul(quantity)
    const fee = notional.mul(this.state.config.feeRate)
    const releasedMargin = decimal(
      position.isolatedMargin,
      '逐仓保证金',
    )
      .mul(quantity)
      .div(oldQuantity)

    this.applyWalletChange(realized, 'realized_pnl', timestamp)
    this.applyWalletChange(fee.negated(), 'trading_fee', timestamp)
    const trade = this.recordTrade({
      timestamp,
      side: tradeSide,
      positionSide: position.side,
      action,
      quantity,
      price: fillPrice,
      fee,
      liquidationFee: ZERO,
      slippage: fillPrice.minus(reference).abs().mul(quantity),
      realizedPnl: realized,
      reason,
    })
    this.attachTradeToRecentLedger(trade.tradeId, 2)

    const remaining = oldQuantity.minus(quantity)
    if (remaining.isZero()) {
      this.state.positions = this.state.positions.filter(value => value !== position)
      this.updateExitStats(realized, action)
    } else {
      position.quantity = text(remaining)
      position.isolatedMargin = text(
        decimal(position.isolatedMargin, '逐仓保证金').minus(
          releasedMargin,
        ),
      )
      position.updatedAt = timestamp
      position.riskActiveAfterTime = timestamp
      position.liquidationPrice = text(
        this.roundPrice(
          this.liquidationPrice(
            position.side,
            remaining,
            entry,
            decimal(position.isolatedMargin, '逐仓保证金'),
          ),
        ),
      )
    }
    this.state.account.realizedPnl = text(
      decimal(this.state.account.realizedPnl, '累计已实现盈亏').plus(
        realized,
      ),
    )
    this.recalculate(reference, timestamp)
    return trade
  }

  private closeTriggered(
    position: SimulationPosition,
    exitPrice: Decimal,
    triggerPrice: Decimal,
    timestamp: number,
    action: 'take_profit' | 'stop_loss' | 'liquidation',
    reason: TradeReason,
  ): void {
    const quantity = decimal(position.quantity, '持仓数量')
    const entry = decimal(position.entryPrice, '开仓均价')
    const realized =
      position.side === 'long'
        ? exitPrice.minus(entry).mul(quantity)
        : entry.minus(exitPrice).mul(quantity)
    const notional = exitPrice.mul(quantity)
    const fee =
      action === 'liquidation'
        ? ZERO
        : notional.mul(this.state.config.feeRate)
    const liquidationFee =
      action === 'liquidation'
        ? notional.mul(this.state.config.liquidationFeeRate)
        : ZERO
    this.applyWalletChange(realized, 'realized_pnl', timestamp)
    if (fee.isPositive()) {
      this.applyWalletChange(fee.negated(), 'trading_fee', timestamp)
    }
    if (liquidationFee.isPositive()) {
      this.applyWalletChange(
        liquidationFee.negated(),
        'liquidation_fee',
        timestamp,
      )
    }
    const trade = this.recordTrade({
      timestamp,
      side: position.side === 'long' ? 'sell' : 'buy',
      positionSide: position.side,
      action,
      quantity,
      price: exitPrice,
      fee,
      liquidationFee,
      slippage: exitPrice.minus(triggerPrice).abs().mul(quantity),
      realizedPnl: realized,
      reason,
    })
    this.attachTradeToRecentLedger(
      trade.tradeId,
      1 +
        Number(fee.isPositive()) +
        Number(liquidationFee.isPositive()),
    )
    this.state.account.realizedPnl = text(
      decimal(this.state.account.realizedPnl, '累计已实现盈亏').plus(
        realized,
      ),
    )
    this.state.positions = this.state.positions.filter(value => value !== position)
    this.updateExitStats(realized, action)
    this.recalculate(exitPrice, timestamp)
  }

  private recordTrade(input: {
    timestamp: number
    side: TradeSide
    positionSide: PositionSide
    action: TradeAction
    quantity: Decimal
    price: Decimal
    fee: Decimal
    liquidationFee: Decimal
    slippage: Decimal
    realizedPnl: Decimal
    reason: TradeReason
  }): SimulationTrade {
    const trade: SimulationTrade = {
      tradeId: id(),
      sessionId: this.state.sessionId,
      timestamp: input.timestamp,
      symbol: this.state.symbol,
      side: input.side,
      positionSide: input.positionSide,
      action: input.action,
      quantity: text(input.quantity),
      price: text(this.roundPrice(input.price)),
      notional: text(input.quantity.mul(input.price)),
      fee: text(input.fee),
      liquidationFee: text(input.liquidationFee),
      slippage: text(input.slippage),
      realizedPnl: text(input.realizedPnl),
      reason: input.reason,
    }
    this.state.trades.push(trade)
    this.state.stats.totalTrades = this.state.trades.length
    return trade
  }

  private applyWalletChange(
    amount: Decimal,
    type: LedgerEntryType,
    timestamp: number,
  ): void {
    const wallet = decimal(
      this.state.account.walletBalance,
      '钱包余额',
    ).plus(amount)
    this.state.account.walletBalance = text(wallet)
    if (type === 'trading_fee') {
      this.state.account.totalFees = text(
        decimal(this.state.account.totalFees, '累计手续费').plus(
          amount.abs(),
        ),
      )
    }
    if (type === 'liquidation_fee') {
      this.state.account.totalLiquidationFees = text(
        decimal(
          this.state.account.totalLiquidationFees,
          '累计强平费用',
        ).plus(amount.abs()),
      )
    }
    this.state.ledger.push({
      entryId: id(),
      sessionId: this.state.sessionId,
      timestamp,
      type,
      amount: text(amount),
      balanceAfter: text(wallet),
      tradeId: null,
    })
  }

  private attachTradeToLatestLedger(tradeId: string): void {
    const latest = this.state.ledger.at(-1)
    if (latest !== undefined) latest.tradeId = tradeId
  }

  private attachTradeToRecentLedger(tradeId: string, count: number): void {
    for (
      let index = this.state.ledger.length - count;
      index < this.state.ledger.length;
      index += 1
    ) {
      if (index >= 0) this.state.ledger[index].tradeId = tradeId
    }
  }

  private recalculate(
    lastPrice: Decimal,
    timestamp: number,
  ): void {
    let unrealized = ZERO
    let usedMargin = ZERO
    for (const position of this.state.positions) {
      const quantity = decimal(position.quantity, '持仓数量')
      const entry = decimal(position.entryPrice, '开仓均价')
      const positionPnl =
        position.side === 'long'
          ? lastPrice.minus(entry).mul(quantity)
          : entry.minus(lastPrice).mul(quantity)
      unrealized = unrealized.plus(positionPnl)
      usedMargin = usedMargin.plus(decimal(position.isolatedMargin, '逐仓保证金'))
      position.lastPrice = text(this.roundPrice(lastPrice))
      position.notional = text(quantity.mul(lastPrice))
      position.unrealizedPnl = text(positionPnl)
      position.updatedAt = timestamp
    }
    const wallet = decimal(this.state.account.walletBalance, '钱包余额')
    const initial = decimal(
      this.state.account.initialBalance,
      '初始资金',
    )
    this.state.account.unrealizedPnl = text(unrealized)
    this.state.account.usedMargin = text(usedMargin)
    this.state.account.equity = text(wallet.plus(unrealized))
    this.state.account.availableBalance = text(wallet.minus(usedMargin))
    const totalReturn = wallet.plus(unrealized).minus(initial)
    this.state.stats.totalReturn = text(totalReturn)
    this.state.stats.totalReturnRate = text(totalReturn.div(initial))
    this.touch()
  }

  private updateExitStats(
    realized: Decimal,
    action: TradeAction,
  ): void {
    this.state.stats.completedPositions += 1
    if (realized.isPositive()) {
      this.state.stats.wins += 1
      if (
        realized.greaterThan(
          decimal(this.state.stats.largestWin, '最大单笔盈利'),
        )
      ) {
        this.state.stats.largestWin = text(realized)
      }
    } else if (realized.isNegative()) {
      this.state.stats.losses += 1
      if (
        realized.lessThan(
          decimal(this.state.stats.largestLoss, '最大单笔亏损'),
        )
      ) {
        this.state.stats.largestLoss = text(realized)
      }
    }
    if (action === 'liquidation') {
      this.state.stats.liquidations += 1
    }
    const decided = this.state.stats.wins + this.state.stats.losses
    this.state.stats.winRate =
      decided === 0
        ? '0'
        : text(new Decimal(this.state.stats.wins).div(decided))
  }

  private marketFillPrice(
    reference: Decimal,
    side: TradeSide,
  ): Decimal {
    const slippage = decimal(this.state.config.slippageRate, '滑点率')
    return this.roundPrice(
      side === 'buy'
        ? reference.mul(Decimal.add(1, slippage))
        : reference.mul(Decimal.sub(1, slippage)),
    )
  }

  private liquidationPrice(
    side: PositionSide,
    quantity: Decimal,
    entryPrice: Decimal,
    isolatedMargin: Decimal,
  ): Decimal {
    const maintenance = decimal(
      this.state.config.maintenanceMarginRate,
      '维持保证金率',
    )
    const liquidationFee = decimal(
      this.state.config.liquidationFeeRate,
      '强平费用率',
    )
    const rates = maintenance.plus(liquidationFee)
    if (side === 'long') {
      return Decimal.max(
        ZERO,
        quantity
          .mul(entryPrice)
          .minus(isolatedMargin)
          .div(quantity.mul(Decimal.sub(1, rates))),
      )
    }
    return quantity
      .mul(entryPrice)
      .plus(isolatedMargin)
      .div(quantity.mul(Decimal.add(1, rates)))
  }

  private liquidationTouched(
    position: SimulationPosition,
    candle: MarketCandle,
  ): boolean {
    const price = decimal(position.liquidationPrice, '预估强平价')
    return position.side === 'long'
      ? decimal(candle.low, 'K 线最低价').lessThanOrEqualTo(price)
      : decimal(candle.high, 'K 线最高价').greaterThanOrEqualTo(
          price,
        )
  }

  private stopLossTouched(
    position: SimulationPosition,
    candle: MarketCandle,
  ): boolean {
    const price = decimal(position.stopLossPrice!, '止损价格')
    return position.side === 'long'
      ? decimal(candle.low, '最低价').lessThanOrEqualTo(price)
      : decimal(candle.high, '最高价').greaterThanOrEqualTo(price)
  }

  private takeProfitTouched(
    position: SimulationPosition,
    candle: MarketCandle,
  ): boolean {
    const price = decimal(position.takeProfitPrice!, '止盈价格')
    return position.side === 'long'
      ? decimal(candle.high, '最高价').greaterThanOrEqualTo(price)
      : decimal(candle.low, '最低价').lessThanOrEqualTo(price)
  }

  private roundPrice(value: Decimal): Decimal {
    return value.toDecimalPlaces(
      this.pricePrecision,
      Decimal.ROUND_HALF_UP,
    )
  }

  private roundQuantity(value: Decimal): Decimal {
    return value.toDecimalPlaces(
      this.quantityPrecision,
      Decimal.ROUND_DOWN,
    )
  }

  private findPosition(side: PositionSide): SimulationPosition | null {
    return this.state.positions.find(position => position.side === side) ?? null
  }

  private requirePosition(side: PositionSide): SimulationPosition {
    const position = this.findPosition(side)
    if (position === null) throw new Error('当前没有该方向持仓')
    return position
  }

  private touch(): void {
    this.state.updatedAt = this.now()
  }
}
