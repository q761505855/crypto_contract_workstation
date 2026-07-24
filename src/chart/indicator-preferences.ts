export const CHART_INDICATORS_PREFERENCE = 'chart.indicators.v1'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface ChartIndicatorSetting {
  name: string
  calcParams: JsonValue[]
  visible: boolean
  styles: JsonValue
}

export interface ChartIndicatorPaneSetting {
  height?: number
  indicators: ChartIndicatorSetting[]
}

export interface ChartIndicatorPreferences {
  schemaVersion: 1
  main: ChartIndicatorSetting[]
  sub: ChartIndicatorPaneSetting[]
}

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} 格式无效`)
  }
  return value as Record<string, unknown>
}

function jsonValue(value: unknown, field: string): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${field} 包含无效数字`)
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => jsonValue(item, `${field}[${index}]`))
  }
  const item = record(value, field)
  return Object.fromEntries(
    Object.entries(item).map(([key, entry]) => [
      key,
      jsonValue(entry, `${field}.${key}`),
    ]),
  )
}

function indicator(
  value: unknown,
  field: string,
): ChartIndicatorSetting {
  const item = record(value, field)
  if (typeof item.name !== 'string' || item.name.length === 0) {
    throw new Error(`${field}.name 无效`)
  }
  if (!Array.isArray(item.calcParams)) {
    throw new Error(`${field}.calcParams 必须是数组`)
  }
  if (typeof item.visible !== 'boolean') {
    throw new Error(`${field}.visible 必须是布尔值`)
  }
  return {
    name: item.name,
    calcParams: item.calcParams.map((entry, index) =>
      jsonValue(entry, `${field}.calcParams[${index}]`),
    ),
    visible: item.visible,
    styles: jsonValue(item.styles ?? null, `${field}.styles`),
  }
}

export function validateChartIndicatorPreferences(
  value: unknown,
): ChartIndicatorPreferences {
  const item = record(value, 'chartIndicators')
  if (item.schemaVersion !== 1) {
    throw new Error('chartIndicators.schemaVersion 不受支持')
  }
  if (!Array.isArray(item.main) || !Array.isArray(item.sub)) {
    throw new Error('chartIndicators 主图或副图配置无效')
  }
  const main = item.main.map((entry, index) =>
    indicator(entry, `chartIndicators.main[${index}]`),
  )
  const sub = item.sub.map((entry, index) => {
    const pane = record(entry, `chartIndicators.sub[${index}]`)
    if (!Array.isArray(pane.indicators)) {
      throw new Error(`chartIndicators.sub[${index}].indicators 必须是数组`)
    }
    const height =
      pane.height === undefined
        ? undefined
        : typeof pane.height === 'number' &&
            Number.isFinite(pane.height) &&
            pane.height > 0
          ? pane.height
          : null
    if (height === null) {
      throw new Error(`chartIndicators.sub[${index}].height 无效`)
    }
    return {
      ...(height === undefined ? {} : { height }),
      indicators: pane.indicators.map((setting, settingIndex) =>
        indicator(
          setting,
          `chartIndicators.sub[${index}].indicators[${settingIndex}]`,
        ),
      ),
    }
  })
  return { schemaVersion: 1, main, sub }
}

export function loadChartIndicatorPreferences(
  storage: ReadableStorage = localStorage,
): ChartIndicatorPreferences | null {
  const stored = storage.getItem(CHART_INDICATORS_PREFERENCE)
  if (stored === null) return null
  try {
    return validateChartIndicatorPreferences(JSON.parse(stored))
  } catch {
    return null
  }
}

export function saveChartIndicatorPreferences(
  preferences: ChartIndicatorPreferences,
  storage: WritableStorage = localStorage,
): void {
  const validated = validateChartIndicatorPreferences(preferences)
  storage.setItem(CHART_INDICATORS_PREFERENCE, JSON.stringify(validated))
}
