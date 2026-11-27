import Decimal from 'decimal.js'

// NinjaTrader Free all-in USD per contract per side, August 14, 2026.
// https://ninjatrader.com/pricing/commissions/
const FEES = new Map(Object.entries({
  ES: '2.87', NQ: '2.87', RTY: '2.87', YM: '2.87',
  MES: '0.94', MNQ: '0.94', M2K: '0.94', MYM: '0.94',
  CL: '2.99', MCL: '1.19', QM: '2.69', NG: '3.09', RB: '2.99', HO: '2.99',
  GC: '3.14', MGC: '1.29', SI: '3.14', HG: '3.14', '1OZ': '1.09',
  '6A': '3.09', '6B': '3.09', '6E': '3.09', '6J': '3.09', '6M': '3.09',
  M6A: '0.83', M6B: '0.83', M6E: '0.83',
  ZB: '2.36', ZN: '2.29', ZF: '2.14', ZT: '2.14', UB: '2.44',
  ZC: '3.64', ZS: '3.62', ZW: '3.64',
  MBT: '1.74', MET: '0.69',
}))

export function defaultCmeFeePerContractSide(ticker: string): string | null {
  const symbol = ticker.toUpperCase()
  const root = symbol.endsWith('.FUT') ? symbol.slice(0, -4) : symbol.replace(/[FGHJKMNQUVXZ]\d{1,4}$/, '')
  return FEES.get(symbol) ?? FEES.get(root) ?? null
}

export function isCmeFeePerContractSide(value: unknown): value is string {
  return typeof value === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && new Decimal(value).isFinite()
}

export function validateCmeFeePerContractSide(value: unknown): asserts value is string | null | undefined {
  if (value !== undefined && value !== null && !isCmeFeePerContractSide(value)) {
    throw new Error('CME 每张单边手续费必须为非负金额')
  }
}
