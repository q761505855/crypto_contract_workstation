import type Decimal from 'decimal.js'
import type { ReplayTradingConfig } from '../replay/models'
import { cTraderCommission } from './ctrader-trading'

export type CommissionConfig = Pick<ReplayTradingConfig, 'feeRate' | 'ctrader' | 'cmeFeePerContractSide'>

export function tradingCommission(config: CommissionConfig, quantity: Decimal, price: Decimal): Decimal {
  if (config.ctrader) return cTraderCommission(config.ctrader, quantity, price)
  if (typeof config.cmeFeePerContractSide === 'string') return quantity.mul(config.cmeFeePerContractSide)
  return quantity.mul(price).mul(config.feeRate)
}
