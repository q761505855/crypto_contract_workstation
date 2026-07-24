import type { PositionSide } from './models'

export type RiskPriceTarget = 'take-profit' | 'stop-loss'

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
