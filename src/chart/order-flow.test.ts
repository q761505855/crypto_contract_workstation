import { describe, expect, it } from 'vitest'
import { validateDrawings } from './drawings'
import { validateChartIndicatorPreferences } from './indicator-preferences'
import { BIG_TRADES, VOLUME_PROFILE_TOOL, VolumeProfileAccumulator } from './order-flow'
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
})
