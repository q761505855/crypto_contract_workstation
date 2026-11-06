export interface RsiLevels { oversold: number; overbought: number }
export const DEFAULT_RSI_LEVELS: RsiLevels = { oversold: 30, overbought: 70 }

export function validateRsiLevels(value: unknown): RsiLevels {
  const item = value as RsiLevels | null
  if (!item || typeof item !== 'object' || Array.isArray(item) ||
      typeof item.oversold !== 'number' || !Number.isFinite(item.oversold) || item.oversold < 0 || item.oversold >= 50 ||
      typeof item.overbought !== 'number' || !Number.isFinite(item.overbought) || item.overbought <= 50 || item.overbought > 100) {
    throw new Error('RSI 水平线必须满足 0 ≤ 超卖 < 50 < 超买 ≤ 100')
  }
  return { oversold: item.oversold, overbought: item.overbought }
}
