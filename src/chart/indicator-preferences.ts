import { TTM_WAVE_PALETTES, type TtmWave } from './ttm-wave-colors'
import { validatePivotParams } from './pivots'
import { validateStyleColors } from './colors'
import { validateRsiLevels } from './rsi'
import { writePreference } from '../storage/preference-events'

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
  previous: ChartIndicatorSetting[] = [],
): ChartIndicatorSetting {
  const item = record(value, field)
  if (typeof item.name !== 'string' || item.name.length === 0) {
    throw new Error(`${field}.name 无效`)
  }
  if (!Array.isArray(item.calcParams)) {
    throw new Error(`${field}.calcParams 必须是数组`)
  }
  if (item.name === 'KC' || item.name === 'TTM_SQUEEZE') {
    const params = item.calcParams
    if (params.length !== 3 || params.some(entry => typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0) ||
        !Number.isInteger(params[0]) || (item.name === 'KC' && !Number.isInteger(params[2]))) {
      throw new Error(`${field}.calcParams 无效：周期必须为正整数，倍数必须为有限正数，且必须包含三个参数`)
    }
  }
  if (['TTM_WAVE_A', 'TTM_WAVE_B', 'TTM_WAVE_C'].includes(item.name)) {
    const params = item.calcParams
    if (params.length !== 3 || params.some(p => typeof p !== 'number' || !Number.isInteger(p) || p <= 0) ||
        params[0] >= params[1] || params[1] >= params[2]) {
      throw new Error(`${field}.calcParams 无效：必须包含三个正整数周期，且快线 < 慢线一 < 慢线二`)
    }
    const styles = item.styles as { bars?: unknown } | null | undefined
    if (styles?.bars !== undefined) {
      if (!Array.isArray(styles.bars)) throw new Error(`${field}.styles.bars 必须是数组`)
      styles.bars.forEach((value, index) => {
        const bar = record(value, `${field}.styles.bars[${index}]`)
        for (const key of ['positiveColor', 'negativeColor']) {
          if (bar[key] !== undefined) validateStyleColors({ [key]: bar[key] }, `${field}.styles.bars[${index}]`)
        }
      })
    }
  }
  if (typeof item.visible !== 'boolean') {
    throw new Error(`${field}.visible 必须是布尔值`)
  }
  let validatedStyles = jsonValue(item.styles ?? null, `${field}.styles`)
  validateStyleColors(validatedStyles, `${field}.styles`)
  if (item.name === 'RSI') {
    const prior = previous.find(setting => setting.name === 'RSI')?.styles
    for (const key of ['rsiLevels', 'rsiLines']) {
      const incoming = validatedStyles !== null && typeof validatedStyles === 'object' && !Array.isArray(validatedStyles) ? validatedStyles : null
      if (incoming?.[key] === undefined && prior && typeof prior === 'object' && !Array.isArray(prior) && prior[key] !== undefined) {
        validatedStyles ??= {}
        ;(validatedStyles as Record<string, JsonValue>)[key] = jsonValue(prior[key], `${field}.styles.${key}`)
      }
    }
    if (validatedStyles !== null && typeof validatedStyles === 'object' && !Array.isArray(validatedStyles)) {
      if (Object.hasOwn(validatedStyles, 'rsiLevels')) validateRsiLevels(validatedStyles.rsiLevels)
      const lines = validatedStyles.rsiLines
      if (lines !== undefined && (!Array.isArray(lines) || lines.length > 3 || lines.some(line => line !== null &&
          (typeof line !== 'object' || Array.isArray(line) || (line.size !== undefined &&
            (typeof line.size !== 'number' || !Number.isFinite(line.size) || line.size < 0)))))) {
        throw new Error('RSI.rsiLines 水平线样式无效')
      }
    }
  }
  if (['TTM_WAVE_A', 'TTM_WAVE_B', 'TTM_WAVE_C'].includes(item.name) &&
      validatedStyles !== null && typeof validatedStyles === 'object' && !Array.isArray(validatedStyles)) {
    const palette = TTM_WAVE_PALETTES[item.name.slice(-1) as TtmWave]
    const original = { A: ['#008000', '#daa520'], B: ['#ff00ff', '#0000ff'], C: ['#ff0000', '#ff8c00'] }[item.name.slice(-1) as TtmWave]
    if (Array.isArray(validatedStyles.bars)) validatedStyles.bars.forEach((bar, index) => {
      if (index > 1 || bar === null || typeof bar !== 'object' || Array.isArray(bar)) return
      for (const key of ['noChangeColor', 'positiveColor', 'upColor', 'downColor']) {
        if (bar[key] === ['#26a69a', '#66bb6a'][index] || bar[key] === original[index]) bar[key] = palette.positive[index]
      }
      if (bar.negativeColor === ['#ef5350', '#ff8a65'][index]) bar.negativeColor = palette.negative[index]
    })
  }
  return {
    name: item.name,
    calcParams: (item.name === 'PIVOTS' ? validatePivotParams(item.calcParams, previous.find(setting => setting.name === item.name)?.calcParams) : item.calcParams).map((entry, index) =>
      jsonValue(entry, `${field}.calcParams[${index}]`),
    ),
    visible: item.visible,
    styles: validatedStyles,
  }
}

export function validateChartIndicatorPreferences(
  value: unknown,
  previous?: ChartIndicatorPreferences | null,
): ChartIndicatorPreferences {
  const item = record(value, 'chartIndicators')
  if (item.schemaVersion !== 1) {
    throw new Error('chartIndicators.schemaVersion 不受支持')
  }
  if (!Array.isArray(item.main) || !Array.isArray(item.sub)) {
    throw new Error('chartIndicators 主图或副图配置无效')
  }
  const previousSettings = [...(previous?.main ?? []), ...(previous?.sub ?? []).flatMap(pane => pane.indicators)]
  const main = item.main.map((entry, index) =>
    indicator(entry, `chartIndicators.main[${index}]`, previousSettings),
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
          previousSettings,
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
  writePreference(storage, CHART_INDICATORS_PREFERENCE, JSON.stringify(validated))
}
