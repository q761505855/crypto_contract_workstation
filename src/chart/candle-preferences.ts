export const CANDLE_TYPE_KEY = 'chart.candleType.v1'
export const CANDLE_TYPES = ['candle_solid', 'candle_stroke', 'candle_up_stroke', 'candle_down_stroke', 'ohlc', 'area', 'heikin_ashi'] as const
export type ChartCandleType = typeof CANDLE_TYPES[number]

export function validateCandleType(value: unknown): ChartCandleType {
  if (typeof value !== 'string' || !CANDLE_TYPES.includes(value as ChartCandleType)) {
    throw new Error('candleType 必须是支持的蜡烛图类型')
  }
  return value as ChartCandleType
}

export function readCandleType(storage: Pick<Storage, 'getItem'> = localStorage): ChartCandleType {
  try {
    const saved = storage.getItem(CANDLE_TYPE_KEY)
    if (saved !== null) return validateCandleType(JSON.parse(saved))
  } catch {
    // Damaged local preferences must not prevent opening the chart.
  }
  return 'candle_solid'
}

export function saveCandleType(value: ChartCandleType, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(CANDLE_TYPE_KEY, JSON.stringify(validateCandleType(value)))
}
