import { isChartColor } from './colors'
import { bigTradeColors, bigTradeMode, DEFAULT_BIG_TRADE_NOTIONAL } from './order-flow'

export const FOOTPRINT = 'FOOTPRINT'
export const CVD = 'CVD'
export const PROFILE = 'VOLUME_PROFILE_SETTINGS'

const number = (label: string, fallback: number, min: number, max: number, step = 1) =>
  ({ kind: 'number' as const, label, fallback, min, max, step })
const toggle = (label: string, fallback: boolean) => ({ kind: 'boolean' as const, label, fallback })
const color = (label: string, fallback: string) => ({ kind: 'color' as const, label, fallback })
const defaultBubbleColors = bigTradeColors(undefined)
function select<K extends string>(label: string, fallback: NoInfer<K>, options: Record<K, string>) {
  return { kind: 'select' as const, label, fallback, options }
}

const footprintTypes = { bidAsk: 'Bid / Ask', volume: '总成交量', delta: 'Delta', volumeDelta: 'Delta / 总成交量' }
export type FootprintType = keyof typeof footprintTypes

export const orderFlowFields = {
  footprint: {
    type: select('数值内容', 'bidAsk', footprintTypes),
    plotType: select('图形内容', 'matchText', { matchText: '跟随数值内容', ...footprintTypes }),
    layout: select('显示样式', 'box', { box: '色块', histogram: '横条' }),
    input: select('统计单位', 'volume', { volume: '成交量', count: '成交笔数' }),
    grouping: select('价位分组', 'auto', { auto: '自动', manual: '手动' }),
    targetRows: number('自动目标档数', 22, 4, 96),
    ticksPerRow: number('手动每档 ticks', 1, 1, 100_000),
    columnWidth: number('开启时 K 线间距', 110, 48, 240),
    minNotional: number('最低成交额（USDT）', 0, 0, 1e12, 0.01),
    maxNotional: number('最高成交额（0 为不限）', 0, 0, 1e12, 0.01),
    shading: select('颜色强度', 'fade', { fade: '随数值变化', fixed: '固定' }),
    showText: toggle('显示数值', true),
    fontSize: number('字号', 10, 8, 18),
    showPoc: toggle('标记总量 POC', true),
    showImbalance: toggle('标记对角失衡', true),
    imbalanceRatio: number('失衡倍数', 3, 1, 20, 0.1),
    bidColor: color('Bid 主动卖出色', '#e66a73'),
    askColor: color('Ask 主动买入色', '#33b99a'),
    textColor: color('文字色', '#e7eef8'),
    pocColor: color('POC 色', '#ffcc70'),
    imbalanceColor: color('失衡色', '#eaa9ff'),
  },
  bubbles: {
    mode: select('大单模式', 'volume', { volume: 'Volume（逐笔）', aggregate: 'Aggregate（聚合）' }),
    minNotional: number('最低成交额（USDT）', DEFAULT_BIG_TRADE_NOTIONAL, 0, Number.MAX_VALUE, 0.01),
    maxNotional: number('最高成交额（USDT，0 为不限）', 0, 0, 1e12, 0.01),
    marker: select('标记形状', 'circle', { circle: '圆形', square: '方形', diamond: '菱形' }),
    minRadius: number('最小半径', 0, 0, 40),
    maxRadius: number('最大半径', 20, 1, 40),
    hollow: toggle('空心标记', false),
    showText: toggle('显示成交量', false),
    buyFillColor: color('主动买入填充色', defaultBubbleColors.buy.fill),
    sellFillColor: color('主动卖出填充色', defaultBubbleColors.sell.fill),
    buyOutlineColor: color('主动买入描边色', defaultBubbleColors.buy.outline),
    sellOutlineColor: color('主动卖出描边色', defaultBubbleColors.sell.outline),
    textColor: color('文字色', '#f2f5fa'),
  },
  profile: {
    type: select('显示数据', 'volumeDelta', { volumeDelta: 'Delta / 总成交量', volume: '总成交量', bidAsk: 'Bid / Ask', delta: 'Delta' }),
    rows: number('价位档数', 48, 4, 200),
    width: number('每侧最大宽度（占选区 %）', 42, 5, 100),
    valueArea: number('价值区（%）', 70, 1, 100),
    showPoc: toggle('显示 POC', true),
    showValueArea: toggle('显示 VAH / VAL', true),
    showLabels: toggle('显示价格线标签', true),
    showValues: toggle('显示各档成交量', false),
    volumeColor: color('成交量色', '#3b54766b'),
    valueAreaColor: color('价值区成交量色', '#5e93d67a'),
    bidColor: color('Bid 主动卖出色', '#ff827e66'),
    askColor: color('Ask 主动买入色', '#49d4ae66'),
    pocColor: color('POC 线色', '#ffcc70'),
    levelColor: color('VAH / VAL 线色', '#aabcda'),
  },
  cvd: {
    reset: select('累计方式', 'daily', { daily: 'UTC 日切', continuous: '连续累计' }),
    plot: select('显示样式', 'line', { line: '折线', histogram: '柱形' }),
    showZero: toggle('显示零线', true),
    lineWidth: number('线宽', 2, 1, 5),
    positiveColor: color('正值色', '#35c6a1'),
    negativeColor: color('负值色', '#ef7881'),
    zeroColor: color('零线色', '#8493a8'),
  },
}

type Schema = typeof orderFlowFields
export type OrderFlowGroup = keyof Schema
type Field = { [G in OrderFlowGroup]: Schema[G][keyof Schema[G]] }[OrderFlowGroup]
type GroupValues<G extends OrderFlowGroup> = {
  [K in keyof Schema[G]]: Schema[G][K] extends { fallback: infer T } ? T : never
}
export type OrderFlowPreferences = { [G in OrderFlowGroup]?: Partial<GroupValues<G>> }

export function bubblePreferenceDefaults(calcParams: unknown[], styles: unknown) {
  const { buy, sell } = bigTradeColors(styles)
  return {
    mode: bigTradeMode(styles),
    minNotional: typeof calcParams[0] === 'number' ? calcParams[0] : DEFAULT_BIG_TRADE_NOTIONAL,
    buyFillColor: buy.fill, sellFillColor: sell.fill,
    buyOutlineColor: buy.outline, sellOutlineColor: sell.outline,
  }
}

export function withoutBubbleDefaults(preferences: OrderFlowPreferences | undefined): OrderFlowPreferences | undefined {
  if (!preferences?.bubbles) return preferences
  const { bubbles, ...other } = preferences
  const defaults = bubblePreferenceDefaults([], undefined)
  const appearance = Object.fromEntries(Object.entries(bubbles).filter(([key]) => !Object.hasOwn(defaults, key)))
  if (Object.keys(appearance).length) return { ...other, bubbles: appearance }
  return Object.keys(other).length ? other : undefined
}

export function orderFlowSettings<G extends OrderFlowGroup>(group: G, preferences?: OrderFlowPreferences): GroupValues<G> {
  const defaults = Object.fromEntries(orderFlowFieldEntries(group).map(([key, field]) => [key, field.fallback]))
  if (group === 'bubbles' && preferences?.bubbles?.maxRadius === undefined) {
    defaults.maxRadius = Math.max(orderFlowFields.bubbles.maxRadius.fallback, preferences?.bubbles?.minRadius ?? 0)
  }
  return { ...defaults, ...preferences?.[group] } as GroupValues<G>
}

export function orderFlowFieldEntries(group: OrderFlowGroup): [string, Field][] {
  return Object.entries(orderFlowFields[group])
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 格式无效`)
  return value as Record<string, unknown>
}

export function validateOrderFlowPreferences(value: unknown, previous?: OrderFlowPreferences): OrderFlowPreferences {
  const result = { ...previous }
  for (const [group, patch] of Object.entries(record(value, 'orderFlow'))) {
    if (!Object.hasOwn(orderFlowFields, group)) throw new Error(`orderFlow.${group} 未知`)
    const key = group as OrderFlowGroup
    const fields: Record<string, Field> = orderFlowFields[key]
    const next: Record<string, unknown> = { ...result[key] }
    for (const [name, input] of Object.entries(record(patch, `orderFlow.${group}`))) {
      const field = Object.hasOwn(fields, name) ? fields[name] : undefined
      if (!field) throw new Error(`orderFlow.${group}.${name} 未知`)
      const valid = field.kind === 'number'
        ? typeof input === 'number' && Number.isFinite(input) && input >= field.min && input <= field.max && (field.step !== 1 || Number.isInteger(input))
        : field.kind === 'boolean' ? typeof input === 'boolean'
          : field.kind === 'color' ? isChartColor(input) : typeof input === 'string' && Object.hasOwn(field.options, input)
      if (!valid) throw new Error(`${field.label} 无效（orderFlow.${group}.${name}）`)
      next[name] = input
    }
    Object.assign(result, { [key]: next })
  }
  const footprint = orderFlowSettings('footprint', result)
  if (footprint.maxNotional > 0 && footprint.maxNotional < footprint.minNotional) throw new Error('最高成交额低于最低成交额（orderFlow.footprint）')
  const bubbles = orderFlowSettings('bubbles', result)
  if (bubbles.minRadius > bubbles.maxRadius) throw new Error('最大半径低于最小半径（orderFlow.bubbles）')
  return result
}
