import Decimal from 'decimal.js'

export interface CTraderTradingTerms {
  accountCurrency: string
  quoteCurrency: string
  quoteToUsd: string
  usdToAccount: string
  lotSize: string
  minQuantity: string
  quantityStep: string
  maxQuantity: string
  accountLeverage: number
  leverageTiers: { upToUsd: string; leverage: number }[]
  marginMode: 'max' | 'sum' | 'net'
  stopOutRate: string
  stopOutMode: 'smart' | 'fair'
  stopOutOrder: 'margin' | 'loss'
  commission: { type: 1 | 2 | 3 | 4; rate: string; minimumUsd: string; minimumQuote: string }
  canShort: boolean
  tradingMode: 0 | 1 | 2 | 3
  pnlConversionFeeRate: string
  protection?: { units: 'points' | 'percent'; digits: number; stopLoss: number; takeProfit: number }
  swap?: {
    type: 'pips' | 'percent' | 'admin-per-lot'
    long: string
    short: string
    pipPosition: number
    periodHours: number
    utcMinute: number
    tripleDay: number
    skipPeriods: number
    weekends: boolean
    moneyDigits: number
  }
}

export function validateCTraderTradingTerms(value: unknown): asserts value is CTraderTradingTerms {
  const terms = value as Partial<CTraderTradingTerms> | null
  const fail = (): never => { throw new Error('IC Markets 回放交易规格无效') }
  const number = (value: unknown, min: number, max: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
  const amount = (value: unknown, minimum = 0, exclusive = false) => {
    if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return false
    const parsed = new Decimal(value)
    return parsed.isFinite() && (exclusive ? parsed.gt(minimum) : parsed.gte(minimum))
  }
  if (!terms || typeof terms !== 'object' || !terms.commission ||
      ![terms.accountCurrency, terms.quoteCurrency].every(code => typeof code === 'string' && /^[A-Z0-9]{2,12}$/.test(code)) ||
      (terms.quoteToUsd !== 'inverse-price' && !amount(terms.quoteToUsd, 0, true)) || !amount(terms.usdToAccount, 0, true) ||
      ![terms.lotSize, terms.minQuantity, terms.quantityStep, terms.maxQuantity].every(value => amount(value, 0, true)) ||
      !number(terms.accountLeverage, 1, 10_000) || !Array.isArray(terms.leverageTiers) ||
      !['max', 'sum', 'net'].includes(terms.marginMode ?? '') || !['smart', 'fair'].includes(terms.stopOutMode ?? '') ||
      !['margin', 'loss'].includes(terms.stopOutOrder ?? '') || !amount(terms.stopOutRate, 0, true) ||
      !amount(terms.pnlConversionFeeRate) || !number(terms.commission.type, 1, 4) ||
      ![terms.commission.rate, terms.commission.minimumUsd, terms.commission.minimumQuote].every(value => amount(value)) ||
      typeof terms.canShort !== 'boolean' || !number(terms.tradingMode, 0, 3)) return fail()
  const step = new Decimal(terms.quantityStep!)
  const minimum = new Decimal(terms.minQuantity!)
  if (!minimum.mod(step).isZero() || new Decimal(terms.maxQuantity!).lt(minimum) ||
      !step.mul(100).isInteger() || new Decimal(terms.maxQuantity!).div(step).gt(Number.MAX_SAFE_INTEGER) ||
      new Decimal(terms.stopOutRate!).gt(1) || new Decimal(terms.pnlConversionFeeRate!).gt(1)) return fail()
  let previousLimit = new Decimal(0)
  for (const tier of terms.leverageTiers) {
    if (!tier || !number(tier.leverage, 1, 10_000) || !amount(tier.upToUsd, 0, true) || new Decimal(tier.upToUsd).lte(previousLimit)) return fail()
    previousLimit = new Decimal(tier.upToUsd)
  }
  const swap = terms.swap
  if (swap !== undefined && (!swap || !['pips', 'percent', 'admin-per-lot'].includes(swap.type) ||
    ![swap.long, swap.short].every(value => amount(value, -Infinity)) || !number(swap.pipPosition, 0, 15) ||
    !number(swap.periodHours, 1, 24) || 24 % swap.periodHours !== 0 || !number(swap.utcMinute, 0, 1439) ||
    !number(swap.tripleDay, 0, 7) || !number(swap.skipPeriods, 0, 10_000) ||
    !number(swap.moneyDigits, 0, 8) || typeof swap.weekends !== 'boolean')) return fail()
  const protection = terms.protection
  if (protection !== undefined && (!protection || !['points', 'percent'].includes(protection.units) ||
    !number(protection.digits, 0, 15) || !number(protection.stopLoss, 0, 0xffffffff) ||
    !number(protection.takeProfit, 0, 0xffffffff))) return fail()
}

export function cTraderLeverage(terms: CTraderTradingTerms): number {
  return Math.min(terms.accountLeverage, terms.leverageTiers[0]?.leverage ?? terms.accountLeverage)
}

export function sameCTraderTradingTerms(left: CTraderTradingTerms | undefined, right: CTraderTradingTerms | undefined): boolean {
  const canonical = (terms: CTraderTradingTerms | undefined) => JSON.stringify(terms, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
  return canonical(left) === canonical(right)
}

function usdPerQuote(terms: CTraderTradingTerms, price: Decimal): Decimal {
  return terms.quoteToUsd === 'inverse-price' ? new Decimal(1).div(price) : new Decimal(terms.quoteToUsd)
}

function accountPerUsd(terms: CTraderTradingTerms, price: Decimal): Decimal {
  return terms.accountCurrency === terms.quoteCurrency
    ? new Decimal(1).div(usdPerQuote(terms, price)) : new Decimal(terms.usdToAccount)
}

export function quoteToAccount(terms: CTraderTradingTerms, amount: Decimal, price: Decimal): Decimal {
  return terms.quoteCurrency === terms.accountCurrency ? amount : amount.mul(usdPerQuote(terms, price)).mul(accountPerUsd(terms, price))
}

export function cTraderCommission(terms: CTraderTradingTerms, quantity: Decimal, price: Decimal): Decimal {
  const { type, rate, minimumUsd, minimumQuote } = terms.commission
  const usd = accountPerUsd(terms, price)
  const lots = quantity.div(terms.lotSize)
  const notional = quantity.mul(price)
  const fee = type === 1 ? notional.mul(usdPerQuote(terms, price)).mul(rate).div(1_000_000).mul(usd)
    : type === 2 ? lots.mul(rate).mul(usd)
    : quoteToAccount(terms, (type === 3 ? notional : lots).mul(rate), price)
  return Decimal.max(fee, new Decimal(minimumUsd).mul(usd), quoteToAccount(terms, new Decimal(minimumQuote), price))
}

export function cTraderMargin(terms: CTraderTradingTerms, quantity: Decimal, price: Decimal, leverageCap = terms.accountLeverage): Decimal {
  const notional = quantity.mul(price).mul(usdPerQuote(terms, price))
  let remaining = notional
  let margin = new Decimal(0)
  let previous = new Decimal(0)
  for (const [index, tier] of terms.leverageTiers.entries()) {
    const width = new Decimal(tier.upToUsd).minus(previous)
    const portion = index === terms.leverageTiers.length - 1 ? remaining : Decimal.min(remaining, width)
    margin = margin.plus(portion.div(Math.min(tier.leverage, leverageCap)))
    remaining = remaining.minus(portion)
    if (remaining.isZero()) break
    previous = new Decimal(tier.upToUsd)
  }
  return margin.plus(remaining.div(leverageCap)).mul(accountPerUsd(terms, price))
}

export function cTraderTotalMargin(terms: CTraderTradingTerms, long: Decimal, short: Decimal): Decimal {
  if (terms.marginMode === 'max') return Decimal.max(long, short)
  if (terms.marginMode === 'net') return long.minus(short).abs()
  return long.plus(short)
}

export function cTraderSwap(terms: CTraderTradingTerms, quantity: Decimal, price: Decimal, side: 'long' | 'short', days: number): Decimal {
  const swap = terms.swap
  if (!swap) return new Decimal(0)
  const value = quantity.mul(swap[side]).mul(days)
  const converted = swap.type === 'admin-per-lot' ? value.div(terms.lotSize).mul(accountPerUsd(terms, price))
    : quoteToAccount(terms, swap.type === 'percent' ? value.mul(price).div(36500) : value.div(10 ** swap.pipPosition), price)
  return converted.toDecimalPlaces(swap.moneyDigits, Decimal.ROUND_HALF_UP)
}
