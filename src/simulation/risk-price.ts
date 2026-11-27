import Decimal from 'decimal.js'
import { quoteToAccount } from './ctrader-trading'
import { tradingCommission, type CommissionConfig } from './trading-commission'
import type { PositionSide, SimulationPosition } from './models'

export type RiskPriceTarget = 'take-profit' | 'stop-loss'
export type RiskInputMode = 'price' | 'percent'

function riskDirection(side: PositionSide, target: RiskPriceTarget): number {
  return (side === 'long') === (target === 'take-profit') ? 1 : -1
}

export function riskTriggerPrice(
  value: string, mode: RiskInputMode, position: SimulationPosition,
  target: RiskPriceTarget, precision: number,
): Decimal | null {
  if (value === '') return null
  const input = new Decimal(value)
  const price = (mode === 'price' ? input : new Decimal(position.entryPrice)
    .mul(input.mul(riskDirection(position.side, target)).div(100).plus(1)))
    .toDecimalPlaces(precision, Decimal.ROUND_HALF_UP)
  return price.isFinite() && price.gt(0) ? price : null
}

export function riskPricePercent(price: Decimal, position: SimulationPosition, target: RiskPriceTarget): string {
  return price.div(position.entryPrice).minus(1).mul(100 * riskDirection(position.side, target)).toString()
}

export function estimateRiskPnl(position: SimulationPosition, price: Decimal, config: CommissionConfig): Decimal {
  const direction = position.side === 'long' ? 1 : -1
  const quantity = new Decimal(position.quantity)
  const pnl = price.minus(position.entryPrice).mul(direction).mul(quantity)
  const fee = tradingCommission(config, quantity, price)
  const terms = config.ctrader
  if (terms) {
    const settled = quoteToAccount(terms, pnl, price)
    const conversionFee = terms.quoteCurrency === terms.accountCurrency ? new Decimal(0) : settled.abs().mul(terms.pnlConversionFeeRate)
    return settled.minus(conversionFee).minus(fee)
  }
  return pnl.minus(fee)
}

export function classifyRiskPrice(
  side: PositionSide,
  currentPrice: number,
  targetPrice: number,
): RiskPriceTarget | null {
  if (
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(targetPrice) ||
    currentPrice <= 0 ||
    targetPrice <= 0 ||
    targetPrice === currentPrice
  ) {
    return null
  }

  const isTakeProfit =
    side === 'long'
      ? targetPrice > currentPrice
      : targetPrice < currentPrice
  return isTakeProfit ? 'take-profit' : 'stop-loss'
}
