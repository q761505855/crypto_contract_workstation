import { describe, expect, it, vi } from 'vitest'
import type { IndicatorDrawParams } from 'klinecharts'
import { validateDrawings } from './drawings'
import { validateChartIndicatorPreferences } from './indicator-preferences'
import { BIG_TRADES, VOLUME_PROFILE_TOOL, VolumeProfileAccumulator, bigTradeColors, bigTradeMode, tradeThresholdValue } from './order-flow'
import { AccumulatedHour, displayedTradeBubbles, includeHour, type TradeBar } from './order-flow-bars'
import { drawTradeBubbleLabel, drawVolumeProfile, filteredTradeBubbles, selectVisibleTradeBubbles, tradeBubbleOpacity, tradeBubbleRadius } from './order-flow-renderers'
import type { BybitTrade } from '../market-data/bybit/trades'
import { calculateFootprint, cumulativeVolumeDelta, dailyTradeVwap, visibleVolumeProfile } from './order-flow-metrics'
import { orderFlowSettings } from './order-flow-preferences'
import { drawFootprint, drawFootprintText, drawVisibleVolumeProfile } from './order-flow-indicators'

const trade = (price: number, size: number, side: BybitTrade['side']): BybitTrade =>
  ({ price, size, side, timeUs: 1000, id: 'fixture' })

describe('Bybit 成交指标', () => {
  it('大单的固定半径和动态透明度独立生效', () => {
    const threshold = { unit: 'quantity' as const, minimum: 2, maximum: 0 }
    const defaults = orderFlowSettings('bubbles')
    expect(tradeBubbleRadius(2, threshold, defaults)).toBe(5)
    expect(tradeBubbleRadius(8, threshold, defaults)).toBe(10)
    expect(tradeBubbleOpacity(2, threshold, defaults)).toBe(1)
    const settings = orderFlowSettings('bubbles', { bubbles: { sizeByVolume: false, fixedRadius: 9, opacityByVolume: true } })
    expect(tradeBubbleRadius(2, threshold, settings)).toBe(9)
    expect(tradeBubbleRadius(8, threshold, settings)).toBe(9)
    expect(tradeBubbleOpacity(2, threshold, settings)).toBeLessThan(tradeBubbleOpacity(8, threshold, settings))
    expect(tradeBubbleOpacity(8, threshold, settings)).toBeLessThanOrEqual(1)
  })

  it('大单数字在可用宽度内缩写、缩小或省略，长数字不会撑过图标', () => {
    const ctx = {
      font: '', fillText: vi.fn(),
      measureText(text: string) { return { width: [...text].length * Number.parseInt(this.font) / 2 } },
    }
    const canvas = ctx as unknown as CanvasRenderingContext2D
    drawTradeBubbleLabel(canvas, 0.00008, 15, 15, 21, 'square')
    expect(ctx.fillText).toHaveBeenLastCalledWith('0.00008', 15, 15, 40)
    drawTradeBubbleLabel(canvas, 123456789, 15, 15, 10, 'circle')
    expect(ctx.fillText).toHaveBeenCalledTimes(2)
    const [text, , , limit] = ctx.fillText.mock.lastCall!
    expect(ctx.measureText(text).width).toBeLessThanOrEqual(limit)
    expect(limit).toBeLessThan(20)
    drawTradeBubbleLabel(canvas, 123456789, 15, 15, 3, 'diamond')
    expect(ctx.fillText).toHaveBeenCalledTimes(2)
  })

  it('大单阈值按所选单位换算，张数只来自 OKX，ETF 代理不换算手数', () => {
    const bybit = trade(100, 2, 'buy')
    const okx = { ...bybit, venue: 'OKX' as const }
    const terms = { contractValue: 0.1, lotSize: 100 }
    expect(tradeThresholdValue(okx, 'notional', terms)).toBe(200)
    expect(tradeThresholdValue(okx, 'quantity', terms)).toBe(2)
    expect(tradeThresholdValue(okx, 'contracts', terms)).toBe(20)
    expect(tradeThresholdValue(bybit, 'contracts', terms)).toBeUndefined()
    expect(tradeThresholdValue(bybit, 'lots', terms)).toBe(0.02)
    expect(tradeThresholdValue(bybit, 'lots', { ...terms, projectToCandle: true })).toBeUndefined()
    expect(tradeThresholdValue(bybit, 'lots', {})).toBeUndefined()
  })

  it('大单阈值在聚合后筛选，并在所选单位应用两端和零上限', () => {
    const first = { ...trade(100, 0.1, 'buy'), id: 'first', venue: 'OKX' as const }
    const second = { ...first, id: 'second', size: 0.2 }
    const bybit = { ...trade(100, 10, 'buy'), id: 'bybit' }
    const points = [first, second, bybit].map(trade => ({ trade }))
    const bar: TradeBar = { cursor: 2000, volume: 10.3, complete: true, pointRanges: [{ points, from: 0, until: 3 }] }
    const filter = { unit: 'contracts' as const, minimum: 3, maximum: 3, contractValue: 0.1 }
    expect([...filteredTradeBubbles(bar, 'volume', filter)]).toEqual([])
    expect([...filteredTradeBubbles(bar, 'aggregate', filter)].map(({ trade, count }) => [trade.id, count])).toEqual([['first', 2]])
    expect([...filteredTradeBubbles(bar, 'aggregate', { ...filter, minimum: 0, maximum: 2 })]).toEqual([])
    expect([...filteredTradeBubbles(bar, 'aggregate', { ...filter, minimum: 0, maximum: 0 })]).toHaveLength(1)
  })

  it('在整个可见范围内按筛选单位保留最大气泡，逐笔与聚合共用上限', () => {
    const bar = (start: number, sizes: number[]): TradeBar => {
      const points = sizes.map((size, index) => ({
        trade: { ...trade(10, size, 'buy'), timeUs: start * 1000 + index * 1000, id: String(start + index) },
      }))
      return { cursor: Infinity, volume: 0, firstPrice: 10, complete: true, pointRanges: [{ points, from: 0, until: points.length }] }
    }
    const left = bar(1000, Array.from({ length: 800 }, (_, index) => index + 1))
    const right = bar(3000, Array.from({ length: 400 }, (_, index) => 801 + index))
    const bars = new Map([[1000, left], [3000, right]])
    const filter = { unit: 'quantity' as const, minimum: 0, maximum: 0 }
    const selected = selectVisibleTradeBubbles(bars, 'volume', filter, 2000)
    expect(selected.get(1000)).toHaveLength(600)
    expect(selected.get(3000)).toHaveLength(400)
    expect(selected.get(1000)?.[0].amount).toBe(201)
    expect(left.pointRanges[0].points).toHaveLength(800)
    const limited = selectVisibleTradeBubbles(bars, 'aggregate', { ...filter, maximum: 801 }, 2)
    expect([...limited.values()].flat().map(point => point.amount)).toEqual([800, 801])
  })

  it('VWAP 按逐笔成交量加权、日切、按进度截断并标记历史缺口', () => {
    const midnight = Date.UTC(2026, 10, 20)
    const minute = 60_000
    const candles = [-minute, 0, minute, 2 * minute].map(offset => ({ timestamp: midnight + offset, open: 100 }))
    const samples = new Map([
      [midnight - minute, [trade(80, 3, 'buy')]],
      [midnight, [trade(100, 2, 'buy'), trade(110, 6, 'sell')]],
      [midnight + minute, [trade(90, 2, 'buy'), trade(120, 10, 'buy')]],
    ])
    const cursor = (midnight + minute) * 1000 + 2000
    const trades = [...samples].flatMap(([start, entries]) => entries.map((entry, index) => ({
      trade: { ...entry, timeUs: start * 1000 + (index + 1) * 1000 },
    })))
    const read = (from: number, until: number) => {
      const points = trades.filter(({ trade }) => trade.timeUs >= from * 1000 && trade.timeUs < until)
      return { cursor: until, volume: points.reduce((total, { trade }) => total + trade.size, 0),
        pointRanges: [{ points, from: 0, until: points.length }], complete: from !== midnight + minute }
    }

    const { values, partial } = dailyTradeVwap(candles, '1m', cursor, read, false)
    expect([...values]).toEqual([
      [midnight - minute, { price: 80, day: midnight - 86_400_000 }],
      [midnight, { price: 107.5, day: midnight }],
      [midnight + minute, { price: 104, day: midnight }],
    ])
    expect(partial).toBe(true)
  })

  it('可见成交分布汇总同价位的主动买卖，单一成交价也有可绘制的档位', () => {
    const points = [trade(710, 4, 'buy'), trade(710, 7, 'sell'), trade(710, 12, 'buy')].map(trade => ({ trade }))
    const bar: TradeBar = { cursor: 3000, volume: 11, firstBybitPrice: 710, complete: true, pointRanges: [{ points, from: 0, until: 2 }] }
    const rows = visibleVolumeProfile([{ bar, open: 100 }], true, 2)
    expect(rows).toEqual([{ low: 99.995, high: 100.005, buy: 4, sell: 7 }])
    expect(visibleVolumeProfile([], false, 2)).toEqual([])
  })

  it('可见成交分布按配置合并档位，保留各档的主动买卖量', () => {
    const points = [trade(100, 1, 'buy'), trade(101, 2, 'sell'), trade(102, 3, 'buy'), trade(103, 4, 'sell')].map(trade => ({ trade }))
    const bar: TradeBar = { cursor: 2000, volume: 10, complete: true, pointRanges: [{ points, from: 0, until: points.length }] }
    expect(visibleVolumeProfile([{ bar, open: 100 }], false, 0, 2)).toEqual([
      { low: 99.5, high: 101.5, buy: 1, sell: 2 }, { low: 101.5, high: 103.5, buy: 3, sell: 4 },
    ])
  })

  it('可见成交分布默认左侧总量、右侧 Delta，支持左置、横向偏移和只显示 Delta', () => {
    const rects: { color: string; x: number; width: number }[] = []
    const ctx = {
      fillStyle: '', save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillText: vi.fn(),
      fillRect(x: number, _y: number, width: number) { rects.push({ color: this.fillStyle, x, width }) },
    }
    const params = {
      ctx, bounding: { width: 400, height: 180 }, yAxis: { convertToPixel: (price: number) => price * 10 },
      indicator: { extendData: { axisInset: () => 64, rows: [
        { low: 4, high: 5, buy: 12, sell: 2 }, { low: 5, high: 6, buy: 2, sell: 5 },
        { low: 6, high: 7, buy: 2, sell: 2 },
      ] } },
    } as unknown as IndicatorDrawParams
    drawVisibleVolumeProfile(params)
    const [buyVolume, positive, sellVolume, negative, balanced] = rects
    expect(rects).toHaveLength(5)
    expect(buyVolume.x + buyVolume.width).toBeLessThan(positive.x)
    expect(sellVolume.x + sellVolume.width).toBeLessThan(negative.x)
    expect(positive.x).toBe(negative.x)
    expect(positive.x + positive.width).toBeLessThanOrEqual(336)
    expect(positive.width).toBeGreaterThan(negative.width)
    expect(positive.color).not.toBe(negative.color)
    expect(balanced.color).toBe(buyVolume.color)

    rects.length = 0
    ctx.fillText.mockClear()
    params.indicator.extendData.settings = orderFlowSettings('visibleProfile', { visibleProfile: {
      placement: 'left', offset: 10, width: 20, type: 'delta', showHeaders: false,
      positiveColor: '#123456', negativeColor: '#654321',
    } })
    drawVisibleVolumeProfile(params)
    expect(rects.map(({ color, x }) => ({ color, x }))).toEqual([
      { color: '#123456', x: 36 }, { color: '#654321', x: 36 },
    ])
    expect(rects[0].width).toBe(66)
    expect(ctx.fillText).not.toHaveBeenCalled()
  })

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
