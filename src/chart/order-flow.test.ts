import { describe, expect, it } from 'vitest'
import { validateDrawings } from './drawings'
import { validateChartIndicatorPreferences } from './indicator-preferences'
import { BIG_TRADES, VOLUME_PROFILE_TOOL, VolumeProfileAccumulator, bigTradeColors } from './order-flow'
import { drawVolumeProfile } from './order-flow-renderers'
import type { BybitTrade } from '../market-data/bybit/trades'

const trade = (price: number, size: number, side: BybitTrade['side']): BybitTrade =>
  ({ price, size, side, timeUs: 1000, id: 'fixture' })

describe('Bybit 成交指标', () => {
  it('按价位计算双侧成交量、POC 和 70% 价值区', () => {
    const accumulator = new VolumeProfileAccumulator(100, 104, 4)
    expect(accumulator.profile()).toBeUndefined()
    for (const item of [trade(100, 2, 'buy'), trade(101.5, 4, 'buy'), trade(101.5, 2, 'sell'),
      trade(102.5, 3, 'sell'), trade(104, 1, 'buy'), trade(105, 10, 'buy')]) accumulator.add(item)
    const result = accumulator.profile()!
    expect(result).toMatchObject({ poc: 101.5, vah: 103, val: 101 })
    expect(result.rows[1]).toEqual({ low: 101, high: 102, buy: 4, sell: 2 })
    expect(result.rows[3]).toEqual({ low: 103, high: 104, buy: 1, sell: 0 })
  })

  it('接受档案里的两个时间价格锚点', () => {
    const drawing = { id: 'drawing-profile', scope: 'live:BYBIT:SPYUSDT', name: VOLUME_PROFILE_TOOL,
      points: [{ timestamp: 1000, value: 600 }, { timestamp: 6000, value: 610 }] }
    expect(validateDrawings([drawing])).toEqual([drawing])
    expect(() => validateDrawings([{ ...drawing, points: [] }])).toThrow()
  })

  it('保留零门槛与隐藏状态，拒绝非法最低成交额', () => {
    const valid = { schemaVersion: 1, main: [{ name: BIG_TRADES, calcParams: [0], visible: false, styles: null }], sub: [] }
    expect(validateChartIndicatorPreferences(valid)).toEqual(valid)
    expect(validateChartIndicatorPreferences({ ...valid, main: [] }).main).toEqual([])
    for (const calcParams of [[-1], [NaN], [], ['100'], [null]]) {
      expect(() => validateChartIndicatorPreferences({ ...valid, main: [{ ...valid.main[0], calcParams }] })).toThrow()
    }
  })

  it('大单气泡颜色保留透明色，旧档缺少样式时沿用本地设置', () => {
    const appearance = { bubbleColors: ['#01234500', '#23456780', 'transparent', '#456789'].map(color => ({ color })) }
    const settings = { schemaVersion: 1, main: [{ name: BIG_TRADES, calcParams: [0], visible: false, styles: appearance }], sub: [] }
    const validated = validateChartIndicatorPreferences(settings)
    expect(validated).toEqual(settings)
    expect(bigTradeColors(validated.main[0].styles)).toEqual({
      buy: { fill: '#01234500', outline: 'transparent' }, sell: { fill: '#23456780', outline: '#456789' },
    })
    expect(bigTradeColors(null)).toEqual({
      buy: { fill: '#49d4ae6b', outline: '#49d4aee6' }, sell: { fill: '#ff827e6b', outline: '#ff827ee6' },
    })
    for (const styles of [null, {}]) {
      const legacy = { ...settings, main: [{ ...settings.main[0], styles }] }
      expect(validateChartIndicatorPreferences(legacy, validated)).toEqual(settings)
      expect(validateChartIndicatorPreferences(legacy)).toEqual(legacy)
    }
    for (const bubbleColors of [[], null, [1, 2, 3, 4], [{ color: '#fff' }], [{ color: '#fff' }, {}, {}, {}]]) {
      expect(() => validateChartIndicatorPreferences({ ...settings, main: [{ ...settings.main[0], styles: { bubbleColors } }] }))
        .toThrow(/BIG_TRADES.*bubbleColors/)
    }
  })

  it('成交量和 Delta 横条使用半透明颜色，保留价位线', () => {
    const accumulator = new VolumeProfileAccumulator(100, 104, 4)
    accumulator.add(trade(101.5, 4, 'buy'))
    accumulator.add(trade(103.5, 1, 'sell'))
    const figures = drawVolumeProfile({
      overlay: { extendData: { profile: accumulator.profile() } },
      coordinates: [{ x: 50, y: 20 }, { x: 250, y: 220 }],
      yAxis: { convertToPixel: (price: number) => (104 - price) * 50 + 20 },
      precision: { price: 2, volume: 0 },
    } as Parameters<typeof drawVolumeProfile>[0])
    expect(figures.filter(figure => figure.type === 'rect').slice(1).map(figure => figure.styles?.color))
      .toEqual(['#5e93d67a', '#49d4ae66', '#3b54766b', '#ff827e66'])
    expect(figures.filter(figure => figure.type === 'line')).toHaveLength(3)
  })
})
