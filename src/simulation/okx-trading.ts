import Decimal from 'decimal.js'
import type { CTraderTradingTerms } from './ctrader-trading'
import type { MarketCandle } from '../market-data/models'

export interface OkxRiskTier {
  maxContracts: string
  maxLeverage: number
  maintenanceMarginRate: string
}

export interface OkxTradingTerms {
  accountCurrency: 'USDT'
  contractValue: string
  minContracts: string
  contractStep: string
  maxOrderContracts: string
  tickSize: string
  maxLeverage: number
  tiers: OkxRiskTier[]
}

export type ReplayTradingTerms = CTraderTradingTerms | OkxTradingTerms
export const OKX_SIMULATION_TAKER_FEE = '0.0005'

export interface OkxReplayRisk {
  mark?: MarketCandle
  funding: { timestamp: number; rate: string; price: string }[]
  warning?: string
}

export function validateOkxTradingTerms(value: unknown): asserts value is OkxTradingTerms {
  const terms = value as Partial<OkxTradingTerms> | null
  const fail = () => { throw new Error('OKX 回放交易规格无效') }
  const amount = (value: unknown, allowZero = false): value is string => {
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return false
    const number = new Decimal(value)
    return number.isFinite() && (allowZero ? number.gte(0) : number.gt(0))
  }
  const leverage = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 10_000
  if (!terms || terms.accountCurrency !== 'USDT' || !amount(terms.contractValue) || !amount(terms.minContracts) ||
      !amount(terms.contractStep) || !amount(terms.maxOrderContracts) || !amount(terms.tickSize) || !leverage(terms.maxLeverage) ||
      !Array.isArray(terms.tiers) || terms.tiers.length === 0) return fail()
  const step = new Decimal(terms.contractStep)
  if (!new Decimal(terms.minContracts).mod(step).isZero() ||
      new Decimal(terms.maxOrderContracts).lt(terms.minContracts)) return fail()
  let max = new Decimal(0)
  for (const tier of terms.tiers) {
    if (!tier || !amount(tier.maxContracts) || !leverage(tier.maxLeverage) || !amount(tier.maintenanceMarginRate, true) ||
        new Decimal(tier.maxContracts).lte(max) || new Decimal(tier.maintenanceMarginRate).gte(1)) return fail()
    max = new Decimal(tier.maxContracts)
  }
  if (max.lt(terms.minContracts)) fail()
}

export function okxMaximumLeverage(terms: OkxTradingTerms): number {
  return Math.floor(Math.min(terms.maxLeverage, terms.tiers[0].maxLeverage))
}

export function okxRiskTier(terms: OkxTradingTerms, baseQuantity: Decimal): OkxRiskTier | undefined {
  const contracts = baseQuantity.div(terms.contractValue)
  return terms.tiers.find(tier => contracts.lte(tier.maxContracts))
}

export function sameOkxTradingTerms(left?: OkxTradingTerms, right?: OkxTradingTerms): boolean {
  const canonical = (terms?: OkxTradingTerms) => JSON.stringify(terms, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
  return canonical(left) === canonical(right)
}
