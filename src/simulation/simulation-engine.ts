import Decimal from 'decimal.js'
import type { MarketCandle } from '../market-data/models'
import type { ReplayOrderSettings, ReplaySession, ReplayTradingConfig } from '../replay/models'
import { cTraderCommission, cTraderLeverage, cTraderMargin, cTraderSwap, cTraderTotalMargin, quoteToAccount, sameCTraderTradingTerms, validateCTraderTradingTerms } from './ctrader-trading'
import { okxMaximumLeverage, okxRiskTier, sameOkxTradingTerms, validateOkxTradingTerms, type OkxReplayRisk } from './okx-trading'
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
  const slippageRate = nonNegative(config.slippageRate, '滑点率')
  nonNegative(config.maintenanceMarginRate, '维持保证金率')
  nonNegative(config.liquidationFeeRate, '强平费用率')
  const riskRates = decimal(config.maintenanceMarginRate, '维持保证金率').plus(
    config.liquidationFeeRate,
  )
  if (riskRates.greaterThanOrEqualTo(1)) {
    throw new Error('维持保证金率与强平费用率之和必须小于 1')
  }
  if (config.okx !== undefined) {
    validateOkxTradingTerms(config.okx)
    if (config.ctrader !== undefined || config.leverage > okxMaximumLeverage(config.okx) ||
        slippageRate.gte(1) || !new Decimal(config.maintenanceMarginRate).eq(config.okx.tiers[0].maintenanceMarginRate) ||
        config.okx.tiers.some(tier => new Decimal(tier.maintenanceMarginRate).plus(config.liquidationFeeRate).gte(1))) {
      throw new Error('OKX 模拟杠杆、滑点或维持保证金率与合约规格不符')
    }
  }
  if (config.ctrader !== undefined) {
    validateCTraderTradingTerms(config.ctrader)
    const maximum = cTraderLeverage(config.ctrader)
    if (config.leverage > maximum) throw new Error(`模拟杠杆不能超过当前品种的 ${maximum}× 上限`)
    if (slippageRate.gte(1)) throw new Error('滑点率必须小于 1')
    if (!riskRates.isZero() || !new Decimal(config.feeRate).isZero()) {
      throw new Error('IC Markets 回放必须按账户交易规格计算佣金和保证金')
    }
  }
}

export function validateAdjustableLeverage(leverage: number): void {
  if (!isAdjustableLeverage(leverage)) {
    throw new Error(`杠杆必须是 1–${MAX_ADJUSTABLE_LEVERAGE} 的整数`)
  }
}

export class SimulationEngine {
  private state: SimulationState
  private balanceAdjustments = ZERO
  private readonly pricePrecision: number
  private readonly quantityPrecision: number

  private constructor(
    state: StoredSimulationState,
    symbolPrecision: { price: number; quantity: number },
    private readonly now: () => number,
  ) {
    this.state = normalizeSimulationStatePrices(state)
    for (const entry of this.state.ledger) {
      if (entry.type === 'balance_adjustment') this.balanceAdjustments = this.balanceAdjustments.plus(entry.amount)
    }
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
    if (!sameCTraderTradingTerms(state.config.ctrader, session.tradingConfig.ctrader)) {
      throw new Error('模拟交易状态与回放会话的 IC Markets 交易规格不匹配')
    }
    if (!sameOkxTradingTerms(state.config.okx, session.tradingConfig.okx) || (state.config.okx &&
        (state.config.feeRate !== session.tradingConfig.feeRate ||
          state.config.liquidationFeeRate !== session.tradingConfig.liquidationFeeRate))) {
      throw new Error('模拟交易状态与回放会话的 OKX 交易规格不匹配')
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
    this.setOrderSettings({ leverage, slippageRate: this.state.config.slippageRate })
  }

  setOrderSettings({ leverage, slippageRate }: ReplayOrderSettings): void {
    const previous = this.state.config
    if (!previous.ctrader && leverage !== previous.leverage) {
      if (!previous.okx) validateAdjustableLeverage(leverage)
      if (leverage < minimumContractLeverage(this.state)) {
        throw new Error('逐仓有持仓时不能降低杠杆')
      }
      if (previous.okx && this.state.positions.some(position =>
        leverage > (okxRiskTier(previous.okx!, new Decimal(position.quantity))?.maxLeverage ?? 0))) {
        throw new Error('杠杆超过 OKX 当前持仓档位上限')
      }
    }
    if (slippageRate !== previous.slippageRate && nonNegative(slippageRate, '滑点率').gte(1)) {
      throw new Error('滑点率必须小于 1')
    }
    const config = { ...previous, leverage, slippageRate }
    validateSimulationConfig(config)
    this.state.config = config
    // Both hedge sides share the contract setting; their allocated collateral is separate.
    for (const position of this.state.positions) position.leverage = leverage
    this.touch()
  }

  setWalletBalance(value: string, timestamp: number): void {
    const balance = nonNegative(value, '钱包余额')
    const adjustment = balance.minus(this.state.account.walletBalance)
    if (adjustment.isZero()) return
    this.applyWalletChange(adjustment, 'balance_adjustment', timestamp)
    this.balanceAdjustments = this.balanceAdjustments.plus(adjustment)
    this.recalculateAccount(new Decimal(this.state.account.unrealizedPnl))
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
    const { quantity, margin } = this.resolveOrderSize(side, size, fillPrice)
    const notional = this.settlement(quantity.mul(fillPrice), fillPrice)
    const fee = this.commission(quantity, fillPrice)
    const requiredMargin = this.orderMargin(side, margin)
    const available = decimal(
      this.state.account.availableBalance,
      '可用余额',
    )
    if (requiredMargin.plus(fee).greaterThan(available)) {
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
      requiredMargin: text(requiredMargin),
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
    const { quantity, margin } = this.resolveOrderSize(side, size, fillPrice)
    const fee = this.commission(quantity, fillPrice)
    const available = decimal(
      this.state.account.availableBalance,
      '可用余额',
    )
    if (this.orderMargin(side, margin).plus(fee).greaterThan(available)) {
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
        notional: text(this.settlement(quantity.mul(reference), reference)),
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
        ...(this.state.config.ctrader?.swap ? { swapCheckedThrough: candle.closeTime, swapPeriods: 0 } : {}),
        ...(this.state.config.okx ? { fundingCheckedThrough: candle.closeTime } : {}),
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
      slippage: this.settlement(fillPrice.minus(reference).abs().mul(quantity), fillPrice),
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
    const requested = positive(quantityValue, '减仓数量')
    const quantity = this.roundQuantity(requested)
    if (this.state.config.ctrader && !requested.eq(quantity)) throw new Error('减仓手数不符合 IC Markets 手数步长')
    const okx = this.state.config.okx
    if (okx && !requested.eq(quantity)) throw new Error('减仓张数不符合 OKX 下单步长')
    if (quantity.lessThanOrEqualTo(0)) throw new Error('按当前精度计算后的减仓数量为 0')
    if (quantity.greaterThan(currentQuantity)) {
      throw new Error('减仓数量不能大于当前持仓数量')
    }
    const isFullClose = quantity.equals(currentQuantity)
    const terms = this.state.config.ctrader
    if (terms && !isFullClose && (quantity.lt(terms.minQuantity) || currentQuantity.minus(quantity).lt(terms.minQuantity))) {
      throw new Error('减仓数量和剩余仓位须满足 IC Markets 最小成交量')
    }
    if (okx && !isFullClose) {
      const minimum = new Decimal(okx.minContracts).mul(okx.contractValue)
      if (quantity.lt(minimum) || currentQuantity.minus(quantity).lt(minimum)) throw new Error('减仓和剩余仓位须满足 OKX 最小张数')
    }
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
      this.requireProtectionDistance('takeProfit', price, currentPrice)
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
      this.requireProtectionDistance('stopLoss', price, currentPrice)
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

  private settlement(value: Decimal, price: Decimal): Decimal {
    const terms = this.state.config.ctrader
    return terms ? quoteToAccount(terms, value, price) : value
  }

  private requireProtectionDistance(kind: 'stopLoss' | 'takeProfit', price: Decimal, reference: Decimal): void {
    const protection = this.state.config.ctrader?.protection
    if (!protection) return
    const specified = new Decimal(protection[kind])
    const minimum = protection.units === 'points' ? specified.div(10 ** protection.digits) : reference.mul(specified).div(10_000)
    if (price.minus(reference).abs().lt(minimum)) {
      throw new Error(`${kind === 'stopLoss' ? '止损' : '止盈'}价格与当前报价的距离小于 IC Markets 要求`)
    }
  }

  private commission(quantity: Decimal, price: Decimal): Decimal {
    const terms = this.state.config.ctrader
    return terms ? cTraderCommission(terms, quantity, price) : quantity.mul(price).mul(this.state.config.feeRate)
  }

  private positionPnl(position: SimulationPosition, price: Decimal, quantity: Decimal, realized = false): Decimal {
    const direction = position.side === 'long' ? 1 : -1
    const pnl = this.settlement(price.minus(position.entryPrice).mul(quantity).mul(direction), price)
    const terms = this.state.config.ctrader
    return terms && realized && terms.quoteCurrency !== terms.accountCurrency
      ? pnl.minus(pnl.abs().mul(terms.pnlConversionFeeRate)) : pnl
  }

  private totalMargin(adjustment?: { side: PositionSide; amount: Decimal }): Decimal {
    const sideMargin = (side: PositionSide) => new Decimal(this.findPosition(side)?.isolatedMargin ?? 0)
      .plus(adjustment?.side === side ? adjustment.amount : ZERO)
    const long = sideMargin('long')
    const short = sideMargin('short')
    const terms = this.state.config.ctrader
    return terms ? cTraderTotalMargin(terms, long, short) : long.plus(short)
  }

  private orderMargin(side: PositionSide, positionMargin: Decimal): Decimal {
    return this.state.config.ctrader ? Decimal.max(ZERO, this.totalMargin({ side, amount: positionMargin }).minus(this.totalMargin())) : positionMargin
  }

  private accrueSwap(candle: MarketCandle): void {
    const terms = this.state.config.ctrader
    if (!terms?.swap) return
    const { periodHours, utcMinute, skipPeriods, weekends, tripleDay } = terms.swap
    const period = periodHours * 3_600_000
    const offset = utcMinute * 60_000
    for (const position of this.state.positions) {
      const last = position.swapCheckedThrough ?? position.openedAt
      if (last >= candle.closeTime) continue
      let periods = position.swapPeriods ?? 0
      const price = new Decimal(position.lastPrice)
      for (let settlement = (Math.floor((last - offset) / period) + 1) * period + offset;
        settlement <= candle.closeTime; settlement += period) {
        const day = (new Date(settlement).getUTCDay() + 6) % 7 + 1
        if (!weekends && day > 5) continue
        periods += 1
        if (periods <= skipPeriods) continue
        const amount = cTraderSwap(terms, new Decimal(position.quantity), price, position.side, day === tripleDay ? 3 : 1)
        if (!amount.isZero()) this.applyWalletChange(amount, 'swap', settlement)
      }
      position.swapPeriods = periods
      position.swapCheckedThrough = candle.closeTime
    }
  }

  private processStopOut(candle: MarketCandle, riskCheckTime: number): boolean {
    const terms = this.state.config.ctrader!
    const eligible = (position: SimulationPosition) => riskCheckTime > position.riskActiveAfterTime
    let stopped = false
    for (const sample of new Set([candle.open, candle.low, candle.high])) {
      const price = positive(sample, '回放报价')
      while (true) {
        const margin = this.totalMargin()
        if (margin.isZero()) break
        const positions = this.state.positions.map(position => ({ position,
          pnl: this.positionPnl(position, price, new Decimal(position.quantity)),
        }))
        const equity = positions.reduce((value, item) => value.plus(item.pnl), new Decimal(this.state.account.walletBalance))
        if (equity.gte(margin.mul(terms.stopOutRate))) break
        const candidate = positions.filter(({ position }) => eligible(position)).sort((left, right) => terms.stopOutOrder === 'loss'
          ? left.pnl.cmp(right.pnl) : new Decimal(right.position.isolatedMargin).cmp(left.position.isolatedMargin))[0]
        if (!candidate) break
        const { position } = candidate
        const quantity = this.stopOutQuantity(position, price, equity)
        this.closeQuantity(position, quantity, price, candle.openTime, 'liquidation', 'liquidation', false)
        stopped = true
      }
    }
    return stopped
  }

  private stopOutQuantity(position: SimulationPosition, price: Decimal, equity: Decimal): Decimal {
    const terms = this.state.config.ctrader!
    const size = new Decimal(position.quantity)
    if (terms.stopOutMode === 'fair') return size
    const step = new Decimal(terms.quantityStep)
    const positionMargin = new Decimal(position.isolatedMargin)
    let low = new Decimal(terms.minQuantity).div(step).ceil().toNumber()
    let high = size.minus(terms.minQuantity).div(step).floor().toNumber()
    if (terms.marginMode === 'net' && positionMargin.gt(0)) {
      const opposite = this.findPosition(position.side === 'long' ? 'short' : 'long')
      high = Math.min(high, positionMargin.minus(opposite?.isolatedMargin ?? 0).div(positionMargin).mul(size).div(step).ceil().toNumber())
    }
    const restoresMargin = (steps: number) => {
      const quantity = step.mul(steps)
      const remaining = this.totalMargin({ side: position.side, amount: positionMargin.mul(quantity).div(size).negated() })
      const conversionFee = this.positionPnl(position, price, quantity).minus(this.positionPnl(position, price, quantity, true))
      return equity.minus(this.commission(quantity, price)).minus(conversionFee).gt(remaining.mul(terms.stopOutRate))
    }
    if (high < low || !restoresMargin(high)) return size
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (restoresMargin(middle)) high = middle
      else low = middle + 1
    }
    return step.mul(low)
  }

  processCandle(tradeCandle: MarketCandle, sameTimeTick = false, okxRisk?: OkxReplayRisk): CandleProcessResult {
    let exitAction: TradeAction | null = null
    const riskCheckTime = tradeCandle.openTime + Number(sameTimeTick)
    if (this.state.config.ctrader) {
      this.accrueSwap(tradeCandle)
      if (this.processStopOut(tradeCandle, riskCheckTime)) exitAction = 'liquidation'
    }
    if (this.state.config.okx && okxRisk) this.accrueFunding(tradeCandle, okxRisk)
    // Each side is evaluated independently, even if the other side exits on this candle.
    for (const position of [...this.state.positions]) {
      const action = this.processPositionCandle(position, tradeCandle, riskCheckTime, okxRisk?.mark)
      if (action === 'liquidation' || (action === 'stop_loss' && exitAction !== 'liquidation') || exitAction === null) {
        exitAction = action ?? exitAction
      }
    }
    this.recalculate(positive(tradeCandle.close, '当前成交价格'), tradeCandle.openTime)
    this.state.warning = okxRisk?.warning ?? null
    return { exitAction, warning: this.state.warning }
  }

  private accrueFunding(candle: MarketCandle, risk: OkxReplayRisk): void {
    for (const position of this.state.positions) {
      const quantity = new Decimal(position.quantity)
      let margin = new Decimal(position.isolatedMargin)
      let last = position.fundingCheckedThrough ?? position.openedAt
      for (const settlement of risk.funding) {
        if (settlement.timestamp <= last || settlement.timestamp > candle.closeTime) continue
        const amount = quantity.mul(settlement.price).mul(settlement.rate).mul(position.side === 'long' ? -1 : 1)
        if (!amount.isZero()) this.applyWalletChange(amount, 'funding', settlement.timestamp)
        margin = Decimal.max(0, margin.plus(amount))
        last = settlement.timestamp
      }
      position.fundingCheckedThrough = Math.max(last, candle.closeTime)
      if (!margin.eq(position.isolatedMargin)) {
        position.isolatedMargin = text(margin)
        position.liquidationPrice = text(this.roundPrice(this.liquidationPrice(position.side, quantity,
          new Decimal(position.entryPrice), margin)))
      }
    }
  }

  private processPositionCandle(position: SimulationPosition, tradeCandle: MarketCandle, riskCheckTime: number,
    mark?: MarketCandle): TradeAction | null {
    if (
      !this.state.config.ctrader &&
      riskCheckTime > position.riskActiveAfterTime &&
      this.liquidationTouched(position, mark ?? tradeCandle)
    ) {
      const trigger = decimal(position.liquidationPrice, '预估强平价')
      const open = decimal(tradeCandle.open, 'K 线开盘价')
      const exitPrice =
        position.side === 'long'
          ? Decimal.min(trigger, open)
          : Decimal.max(trigger, open)
      this.closeTriggered(
        position,
        mark ? Decimal.max(tradeCandle.low, Decimal.min(tradeCandle.high, exitPrice)) : exitPrice,
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
      riskCheckTime > position.stopLossActiveAfterTime &&
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
      riskCheckTime > position.takeProfitActiveAfterTime &&
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
    side: PositionSide,
    size: OrderSizeInput,
    fillPrice: Decimal,
  ): { quantity: Decimal; margin: Decimal } {
    const terms = this.state.config.ctrader
    if (terms) {
      if (terms.tradingMode !== 0 || (side === 'short' && !terms.canShort)) {
        throw new Error('IC Markets 当前品种规格不允许此方向开仓')
      }
      const marginInput = size.margin?.trim()
      const quantityInput = size.quantity?.trim()
      const lotsInput = size.lots?.trim()
      if ([marginInput, quantityInput, lotsInput].filter(Boolean).length !== 1) {
        throw new Error('保证金金额、数量和手数必须且只能填写一项')
      }
      const currentSize = new Decimal(this.findPosition(side)?.quantity ?? 0)
      const leverage = this.state.config.leverage
      const leverageCap = leverage === cTraderLeverage(terms) ? terms.accountLeverage : leverage
      const marginFor = (size: Decimal) => cTraderMargin(terms, currentSize.plus(size), fillPrice, leverageCap)
        .minus(cTraderMargin(terms, currentSize, fillPrice, leverageCap))
      const step = new Decimal(terms.quantityStep)
      let quantity: Decimal
      if (marginInput) {
        const budget = positive(marginInput, '保证金金额')
        let low = 0
        let high = new Decimal(terms.maxQuantity).div(step).floor().toNumber()
        while (low < high) {
          const middle = low + Math.ceil((high - low) / 2)
          if (marginFor(step.mul(middle)).lte(budget)) low = middle
          else high = middle - 1
        }
        quantity = step.mul(low)
      } else {
        quantity = lotsInput ? positive(lotsInput, '下单手数').mul(terms.lotSize) : positive(quantityInput!, '下单数量')
        if (!quantity.mod(step).isZero()) throw new Error(`下单手数必须符合 ${step.div(terms.lotSize).toString()} 手的步长`)
      }
      if (quantity.lt(terms.minQuantity) || quantity.gt(terms.maxQuantity)) {
        const min = new Decimal(terms.minQuantity).div(terms.lotSize)
        const max = new Decimal(terms.maxQuantity).div(terms.lotSize)
        throw new Error(`IC Markets 单笔下单范围为 ${min.toString()}–${max.toString()} 手`)
      }
      return { quantity, margin: marginFor(quantity) }
    }
    const okx = this.state.config.okx
    if (okx) {
      const { leverage } = this.state.config
      const value = new Decimal(okx.contractValue)
      const step = new Decimal(okx.contractStep)
      const current = new Decimal(this.findPosition(side)?.quantity ?? 0)
      const margin = size.margin?.trim()
      const contracts = size.lots?.trim()
      const quantityInput = size.quantity?.trim()
      if ([margin, contracts, quantityInput].filter(Boolean).length !== 1) throw new Error('请填写保证金金额或合约张数')
      const eligible = okx.tiers.filter(tier => tier.maxLeverage >= leverage).at(-1)
      const limit = Decimal.min(okx.maxOrderContracts, new Decimal(eligible?.maxContracts ?? 0).minus(current.div(value)))
      let count: Decimal
      if (margin) {
        const maximum = Decimal.min(positive(margin, '保证金金额').mul(leverage).div(fillPrice).div(value), limit)
        count = maximum.div(step).floor().mul(step)
      } else {
        count = contracts ? positive(contracts, '下单张数') : positive(quantityInput!, '下单数量').div(value)
        if (!count.mod(step).isZero()) throw new Error(`下单张数必须符合 ${step} 张的步长`)
      }
      if (count.lt(okx.minContracts) || count.gt(limit)) throw new Error(`OKX 当前杠杆及持仓下可下单 ${okx.minContracts}–${Decimal.max(0, limit)} 张`)
      const quantity = count.mul(value)
      return { quantity, margin: quantity.mul(fillPrice).div(leverage) }
    }
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
    const realized = this.positionPnl(position, fillPrice, quantity, true)
    const fee = this.commission(quantity, fillPrice)
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
      slippage: this.settlement(fillPrice.minus(reference).abs().mul(quantity), fillPrice),
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
      if (action === 'liquidation') this.state.stats.liquidations += 1
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
    if (this.state.config.ctrader) {
      this.closeQuantity(position, quantity, exitPrice, timestamp, action, reason, false)
      return
    }
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
      notional: text(this.settlement(input.quantity.mul(input.price), input.price)),
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
    for (const position of this.state.positions) {
      const quantity = decimal(position.quantity, '持仓数量')
      if (this.state.config.okx) position.maintenanceMarginRate = this.maintenanceRate(quantity)
      const positionPnl = this.positionPnl(position, lastPrice, quantity)
      unrealized = unrealized.plus(positionPnl)
      position.lastPrice = text(this.roundPrice(lastPrice))
      position.notional = text(this.settlement(quantity.mul(lastPrice), lastPrice))
      position.unrealizedPnl = text(positionPnl)
      position.updatedAt = timestamp
    }
    this.recalculateAccount(unrealized)
  }

  private recalculateAccount(unrealized: Decimal): void {
    const wallet = decimal(this.state.account.walletBalance, '钱包余额')
    const usedMargin = this.totalMargin()
    const initial = decimal(
      this.state.account.initialBalance,
      '初始资金',
    )
    this.state.account.unrealizedPnl = text(unrealized)
    this.state.account.usedMargin = text(usedMargin)
    this.state.account.equity = text(wallet.plus(unrealized))
    this.state.account.availableBalance = text(wallet.plus(this.state.config.ctrader ? unrealized : ZERO).minus(usedMargin))
    const totalReturn = wallet.plus(unrealized).minus(initial).minus(this.balanceAdjustments)
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
    if (this.state.config.ctrader) return ZERO
    const maintenance = decimal(
      this.maintenanceRate(quantity),
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

  private maintenanceRate(quantity: Decimal): string {
    const terms = this.state.config.okx
    return (terms && okxRiskTier(terms, quantity)?.maintenanceMarginRate) ?? this.state.config.maintenanceMarginRate
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
    const okx = this.state.config.okx
    if (okx) return value.div(okx.tickSize).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(okx.tickSize)
    return value.toDecimalPlaces(
      this.pricePrecision,
      Decimal.ROUND_HALF_UP,
    )
  }

  private roundQuantity(value: Decimal): Decimal {
    const terms = this.state.config.ctrader
    if (terms) return value.div(terms.quantityStep).floor().mul(terms.quantityStep)
    const okx = this.state.config.okx
    if (okx) {
      const step = new Decimal(okx.contractStep).mul(okx.contractValue)
      return value.div(step).floor().mul(step)
    }
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
