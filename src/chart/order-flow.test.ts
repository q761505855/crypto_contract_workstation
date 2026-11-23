import { describe, expect, it, vi } from 'vitest'
import type { IndicatorDrawParams } from 'klinecharts'
import { validateDrawings } from './drawings'
import { validateChartIndicatorPreferences } from './indicator-preferences'
import { BIG_TRADES, VOLUME_PROFILE_TOOL, VolumeProfileAccumulator, bigTradeColors, bigTradeMode } from './order-flow'
import { AccumulatedHour, displayedTradeBubbles, includeHour, type TradeBar } from './order-flow-bars'
import { drawVolumeProfile } from './order-flow-renderers'
import type { BybitTrade } from '../market-data/bybit/trades'
import { calculateFootprint, cumulativeVolumeDelta } from './order-flow-metrics'
import { orderFlowSettings } from './order-flow-preferences'
import { drawFootprint, drawFootprintText } from './order-flow-indicators'

const trade = (price: number, size: number, side: BybitTrade['side']): BybitTrade =>
  ({ price, size, side, timeUs: 1000, id: 'fixture' })

describe('Bybit 成交指标', () => {
  it('按回放切片、价位和主动方向计算足迹，订单笔数模式沿用相同筛选', () => {
    const samples = new AccumulatedHour()
    samples.add({ ...trade(100, 2, 'sell'), timeUs: 1000 }, 0, 0)
    samples.add({ ...trade(101, 7, 'buy'), timeUs: 2000 }, 0, 0)
    samples.add({ ...trade(101, 1, 'sell'), timeUs: 3000 }, 0, 0)
    const bar: TradeBar = { cursor: 3000, volume: 0, pointRanges: [], complete: true }
    includeHour(bar, samples, 0, 0, bar.cursor)
    const settings = orderFlowSettings('footprint', { footprint: { grouping: 'manual' } })
    const prices = (item: BybitTrade) => item.price
    expect(calculateFootprint(bar, settings, 0, prices)).toEqual([
      { low: 99.5, high: 100.5, buy: 0, sell: 2, poc: false, askImbalance: false, bidImbalance: false },
      { low: 100.5, high: 101.5, buy: 7, sell: 0, poc: true, askImbalance: true, bidImbalance: false },
    ])
    expect(calculateFootprint(bar, { ...settings, input: 'count', minNotional: 300 }, 0, prices))
      .toEqual([{ low: 100.5, high: 101.5, buy: 1, sell: 0, poc: true, askImbalance: false, bidImbalance: false }])
    samples.add({ ...trade(100, 1, 'buy'), timeUs: 4000 }, 0, 0)
    const later: TradeBar = { cursor: 5000, volume: 0, pointRanges: [], complete: true }
    includeHour(later, samples, 0, 0, later.cursor)
    expect(calculateFootprint(later, { ...settings, input: 'count' }, 0, prices).find(row => row.poc)?.low).toBe(100.5)
  })

  it('CVD 在 UTC 跨日和缺口按设置重新累计', () => {
    const start = Date.UTC(2026, 10, 20)
    const timestamps = [start, start + 60_000, start + 86_400_000, start + 86_460_000, start + 86_520_000]
    const samples = new AccumulatedHour()
    samples.add(trade(100, 2, 'buy'), 0, 0)
    const bar: TradeBar = { cursor: 2000, volume: 0, pointRanges: [], complete: true }
    includeHour(bar, samples, 0, 0, bar.cursor)
    const candles = timestamps.map(timestamp => ({ timestamp }))
    const read = (timestamp: number) => timestamp === timestamps[3] ? undefined : bar
    expect([...cumulativeVolumeDelta(candles, read, true).values()]).toEqual([2, 4, 2, 2])
    expect([...cumulativeVolumeDelta(candles, read, false).values()]).toEqual([2, 4, 6, 2])
  })

  it('足迹图单独保存数值与图形内容，旧档缺图形内容时沿用本机或跟随数值', () => {
    const legacy = { schemaVersion: 1, main: [], sub: [], orderFlow: { footprint: { type: 'bidAsk', layout: 'histogram' } } }
    const mixed = { ...legacy, orderFlow: { footprint: { ...legacy.orderFlow.footprint, plotType: 'delta' } } }
    const validated = validateChartIndicatorPreferences(mixed)
    expect(validated).toEqual(mixed)
    expect(validateChartIndicatorPreferences(legacy, validated)).toEqual(mixed)
    expect(orderFlowSettings('footprint', validateChartIndicatorPreferences(legacy).orderFlow))
      .toMatchObject({ type: 'bidAsk', plotType: 'matchText', layout: 'histogram' })
    for (const plotType of [null, '', 'unknown']) {
      expect(() => validateChartIndicatorPreferences({ ...legacy, orderFlow: { footprint: { plotType } } }, validated))
        .toThrow(/orderFlow.footprint.plotType/)
    }
  })

  it('按 Delta 画横条，在同一价位行叠加独立的 Bid / Ask 数值', () => {
    const ctx = {
      save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), restore: vi.fn(),
      fillStyle: '',
      fillRect: vi.fn(), fillText: vi.fn(function (this: { fillStyle: string }, _text: string, _x: number) { return this.fillStyle }),
    }
    const rows = new Map([[1000, [
      { low: 2, high: 4, buy: 12, sell: 5, poc: false, askImbalance: true, bidImbalance: false },
      { low: 4, high: 6, buy: 6, sell: 20, poc: false, askImbalance: false, bidImbalance: true },
    ]]])
    const settings = orderFlowSettings('footprint', { footprint: { type: 'bidAsk', plotType: 'delta', layout: 'histogram' } })
    const params = {
      ctx, barSpace: { bar: 110 }, bounding: { width: 200, height: 100 },
      indicator: { extendData: { rows, settings }, drawForeground: drawFootprintText }, kLineDataList: [{ timestamp: 1000 }],
      visibleRange: { from: 0, to: 1 }, xAxis: { convertToPixel: () => 20 }, yAxis: { convertToPixel: (price: number) => price * 10 },
    } as unknown as IndicatorDrawParams

    drawFootprint(params)
    expect(ctx.fillRect.mock.calls.filter(([, , width]) => width > 2))
      .toEqual([[26, 20, 48, 19.5], [26, 40, 96, 19.5]])
    expect(ctx.fillText).not.toHaveBeenCalled()
    ctx.fillRect.mockClear()
    drawFootprintText(params)
    expect(ctx.fillRect).not.toHaveBeenCalled()
    expect(ctx.fillText.mock.calls.map(([text, x]) => [text, x]))
      .toEqual([['5', 49.75], ['12', 98.25], ['20', 49.75], ['6', 98.25]])
    expect(ctx.fillText.mock.results.map(result => result.value))
      .toEqual([settings.textColor, settings.imbalanceColor, settings.imbalanceColor, settings.textColor])

    settings.plotType = 'matchText'
    settings.showImbalance = false
    ctx.fillRect.mockClear()
    ctx.fillText.mockClear()
    drawFootprint(params)
    drawFootprintText(params)
    expect(ctx.fillRect).toHaveBeenCalledTimes(4)
    expect(ctx.fillText.mock.results.map(result => result.value)).toEqual(Array(4).fill(settings.textColor))

    params.indicator.drawForeground = undefined
    ctx.fillText.mockClear()
    drawFootprint(params)
    expect(ctx.fillText).toHaveBeenCalledTimes(4)
  })

  it('足迹行比设定字号矮时仍绘制可读的数字，并在过密时留出间距', () => {
    const ctx = { save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), restore: vi.fn(), fillText: vi.fn(), font: '' }
    const rows = new Map([[1000, Array.from({ length: 6 }, (_, index) => ({
      low: index + 1, high: index + 2, buy: index + 11, sell: index + 1,
      poc: false, askImbalance: false, bidImbalance: false,
    }))]])
    const settings = orderFlowSettings('footprint', { footprint: { type: 'bidAsk', plotType: 'delta', layout: 'histogram', fontSize: 14 } })
    const params = {
      ctx, barSpace: { bar: 85 }, bounding: { width: 200, height: 100 },
      indicator: { extendData: { rows, settings } }, kLineDataList: [{ timestamp: 1000 }],
      visibleRange: { from: 0, to: 1 }, xAxis: { convertToPixel: () => 20 }, yAxis: { convertToPixel: (price: number) => price * 8 },
    } as unknown as IndicatorDrawParams

    drawFootprintText(params)
    expect(ctx.font).toBe('8px system-ui')
    expect(ctx.fillText.mock.calls.map(([value]) => value)).toEqual(['1', '11', '2', '12', '3', '13', '4', '14', '5', '15', '6', '16'])

    ctx.fillText.mockClear()
    params.yAxis.convertToPixel = (price: number) => price * 4
    drawFootprintText(params)
    expect(ctx.fillText.mock.calls.map(([value]) => value)).toEqual(['1', '11', '3', '13', '5', '15'])
  })

  it('保留旧档缺失的订单流设置与显式的零和 false，拒绝非法项', () => {
    const legacy = { schemaVersion: 1, main: [], sub: [] }
    const orderFlow = { footprint: { showText: false, minNotional: 0 }, profile: { valueArea: 80 } }
    const current = validateChartIndicatorPreferences({ ...legacy, orderFlow })
    expect(current).toEqual({ ...legacy, orderFlow })
    expect(validateChartIndicatorPreferences(legacy, current)).toEqual(current)
    expect(validateChartIndicatorPreferences({ ...legacy, orderFlow: { footprint: { showText: true } } }, current).orderFlow)
      .toEqual({ footprint: { showText: true, minNotional: 0 }, profile: { valueArea: 80 } })
    expect(orderFlowSettings('bubbles', validateChartIndicatorPreferences({ ...legacy, orderFlow: { bubbles: { minRadius: 25 } } }).orderFlow))
      .toMatchObject({ minRadius: 25, maxRadius: 25 })
    for (const bad of [null, [], { footprint: { minNotional: null } }, { profile: { valueArea: 101 } },
      { bubbles: { minRadius: 25, maxRadius: 3 } }, { cvd: { reset: 'invalid' } }]) {
      expect(() => validateChartIndicatorPreferences({ ...legacy, orderFlow: bad }, current)).toThrow(/orderFlow/)
    }
  })

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

  it('气泡模式默认逐笔，旧档缺少模式时沿用本机选择', () => {
    const legacy = { schemaVersion: 1, main: [{ name: BIG_TRADES, calcParams: [0], visible: false, styles: {} }], sub: [] }
    expect(bigTradeMode(validateChartIndicatorPreferences(legacy).main[0].styles)).toBe('volume')
    const aggregate = { ...legacy, main: [{ ...legacy.main[0], styles: { bubbleMode: 'aggregate' } }] }
    expect(validateChartIndicatorPreferences(legacy, validateChartIndicatorPreferences(aggregate))).toEqual(aggregate)
    const volume = { ...legacy, main: [{ ...legacy.main[0], styles: { bubbleMode: 'volume' } }] }
    expect(validateChartIndicatorPreferences(volume, validateChartIndicatorPreferences(aggregate))).toEqual(volume)
    for (const bubbleMode of [null, '', 0, false, [], {}, 'Aggregate']) {
      expect(() => validateChartIndicatorPreferences({ ...legacy, main: [{ ...legacy.main[0], styles: { bubbleMode } }] }))
        .toThrow(/BIG_TRADES.*bubbleMode/)
    }
  })

  it('Aggregate 只合并当前可见范围内同交易所、同毫秒、同价同向的成交', () => {
    const samples = new AccumulatedHour()
    const first = { ...trade(100, 2, 'buy'), id: 'first' }
    const second = { ...first, id: 'second', timeUs: 1100 }
    const otherTrades = [
      { ...second, id: 'sell', side: 'sell' as const },
      { ...second, id: 'different-price', price: 101 },
      { ...second, id: 'okx', venue: 'OKX' as const },
      { ...second, id: 'next-ms', timeUs: 2000 },
    ]
    for (const row of [first, second, ...otherTrades]) samples.add(row, 0, 0)
    const read = (cursor: number) => {
      const bar: TradeBar = { cursor, volume: 0, pointRanges: [], complete: true }
      // Two separate data ranges may contribute to the same millisecond.
      includeHour(bar, samples, 0, 0, Math.min(1100, cursor))
      if (cursor > 1100) includeHour(bar, samples, 0, 1100, cursor)
      return bar
    }
    expect([...displayedTradeBubbles(read(1100), 'aggregate', 300)]).toEqual([])
    const bar = read(3000)
    expect([...displayedTradeBubbles(bar, 'aggregate', 300)]).toEqual([{ trade: { ...first, size: 4 }, count: 2 }])
    expect([...displayedTradeBubbles(bar, 'aggregate', 401)]).toEqual([])
    expect([...displayedTradeBubbles(bar, 'aggregate', 0)].map(point => point.trade.id))
      .toEqual(['first', ...otherTrades.map(row => row.id)])
    expect([...displayedTradeBubbles(bar, 'volume', 0)].map(point => point.trade)).toEqual([first, second, ...otherTrades])
    expect(bar.volume).toBe(12)
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
