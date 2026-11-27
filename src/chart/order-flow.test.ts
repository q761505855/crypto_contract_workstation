import { describe, expect, it, vi } from 'vitest'
import type { IndicatorDrawParams } from 'klinecharts'
import { validateDrawings } from './drawings'
import { validateChartIndicatorPreferences } from './indicator-preferences'
import { BIG_TRADES, VOLUME_PROFILE_TOOL, VolumeProfileLevels, bigTradeColors, bigTradeMode, tradeThresholdValue, volumeProfileBarColor } from './order-flow'
import { AccumulatedHour, displayedTradeBubbles, includeHour, type TradeBar } from './order-flow-bars'
import { drawTradeBubbleLabel, drawVolumeProfile, tradeBubbleOpacity, tradeBubbleRadius } from './order-flow-renderers'
import { filteredTradeBubbles, selectVisibleTradeBubbles } from './order-flow-bubbles'
import type { BybitTrade } from '../market-data/bybit/trades'
import { calculateFootprint, cumulativeVolumeDelta, dailyTradeVwap, tradeBarProfileLevels, visibleVolumeProfile } from './order-flow-metrics'
import { orderFlowSettings, validateOrderFlowPreferences } from './order-flow-preferences'
import { drawCandleVolumeProfile, drawCandleVolumeProfileLevels, drawFootprint, drawFootprintText, drawVisibleVolumeProfile } from './order-flow-indicators'

const trade = (price: number, size: number, side: BybitTrade['side']): BybitTrade =>
  ({ price, size, side, timeUs: 1000, id: 'fixture' })

describe('Bybit 成交指标', () => {
  it('大单的固定半径和动态透明度独立生效', () => {
    const threshold = { unit: 'quantity' as const, minimum: 2, maximum: 0 }
    const defaults = orderFlowSettings('bubbles')
    expect(tradeBubbleRadius(2, threshold, defaults)).toBe(5)
    expect(tradeBubbleRadius(8, threshold, defaults)).toBe(10)
    expect(tradeBubbleRadius(800, threshold, defaults)).toBe(20)
    const larger = orderFlowSettings('bubbles', validateOrderFlowPreferences({ bubbles: { maxRadius: 80 } }))
    expect(tradeBubbleRadius(200, threshold, larger)).toBe(50)
    expect(tradeBubbleRadius(800, threshold, larger)).toBe(80)
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
    const settings = orderFlowSettings('profile')
    const profile = visibleVolumeProfile([{ bar, open: 100 }], true, 100, settings)
    expect(profile).toEqual({ poc: 100, vah: 100, val: 100, rows: [{ low: 100, high: 100, buy: 4, sell: 7 }] })
    expect(visibleVolumeProfile([], false, 100, settings)).toBeUndefined()
  })

  it('可见成交分布使用最新价决定档宽，保留各档的主动买卖量', () => {
    const points = [trade(100, 1, 'buy'), trade(100.99, 2, 'sell'), trade(101, 3, 'buy'), trade(101.75, 4, 'sell')].map(trade => ({ trade }))
    const bar: TradeBar = { cursor: 2000, volume: 10, complete: true, pointRanges: [{ points, from: 0, until: points.length }] }
    expect(visibleVolumeProfile([{ bar, open: 100 }], false, 10_000, orderFlowSettings('profile'))?.rows).toEqual([
      { low: 100, high: 101, buy: 1, sell: 2 }, { low: 101, high: 101.75, buy: 3, sell: 4 },
    ])
  })

  it('可见和框选共用逐根价位统计，框选边缘按逐笔时间切片', () => {
    const points = [trade(100, 11, 'sell'), trade(105, 7, 'buy'), trade(110, 2, 'sell'), trade(120, 50, 'buy')]
      .map((trade, index) => ({ trade: { ...trade, timeUs: 1000 + index * 100 } }))
    const bar: TradeBar = { cursor: 1300, volume: 20, firstBybitPrice: 100, complete: true, pointRanges: [{ points, from: 0, until: 3 }] }
    const whole = tradeBarProfileLevels(bar, 200, true)
    const visible = visibleVolumeProfile([{ bar, open: 200 }], true, 200, orderFlowSettings('profile'))
    expect(tradeBarProfileLevels(bar, 200, true)).toBe(whole)
    expect(visible?.rows).toHaveLength(3)
    expect(visible).toMatchObject({ poc: 200, val: 200, vah: 210 })
    expect(tradeBarProfileLevels(bar, 200, true, 1050, 1200).pack()).toEqual(new Float64Array([210, 7, 0]))
  })

  it('同一段逐笔成交的框选、逐根和可见范围使用相同分档和价位', () => {
    const points = [trade(100.25, 1, 'buy'), trade(100.75, 8, 'sell'), trade(101.25, 7, 'buy'), trade(105.5, 2, 'buy')]
      .map((trade, index) => ({ trade: { ...trade, timeUs: 1000 + index * 100 } }))
    const bar: TradeBar = { cursor: 1400, volume: 18, complete: true, pointRanges: [{ points, from: 0, until: points.length }] }
    const preferences = { profile: { rows: 4, valueArea: 70 }, candleProfile: { rows: 18, valueArea: 80 }, visibleProfile: { rows: 48, valueArea: 90 } }
    const frame = orderFlowSettings('candleProfile', preferences)
    const selection = orderFlowSettings('profile', preferences)
    const visible = orderFlowSettings('visibleProfile', preferences)
    const grouped = tradeBarProfileLevels(bar, 100, false).profile(10_000, { ...selection, valueArea: frame.valueArea })
    const selected = tradeBarProfileLevels(bar, 100, false, 1000, 1400).profile(10_000, selection)
    const inView = visibleVolumeProfile([{ bar, open: 100 }], false, 10_000, { ...selection, valueArea: visible.valueArea })

    expect(grouped).toEqual({ poc: 100.75, vah: 101.25, val: 100.25, rows: [
      { low: 100.25, high: 101, buy: 1, sell: 8 },
      { low: 101, high: 102, buy: 7, sell: 0 },
      { low: 105, high: 105.5, buy: 2, sell: 0 },
    ] })
    expect(selected).toEqual(grouped)
    expect(inView).toEqual(grouped)
  })

  it('基准价变化按 0.001% 重新分档，分档边界上的成交归入下一档', () => {
    const levels = new VolumeProfileLevels()
    levels.add(49_998.25, 6)
    levels.add(49_998.5, 4)
    levels.add(49_998.75, 3)
    const settings = { rowSizePercent: 0.001, valueArea: 70 }
    expect(levels.profile(50_000, settings)).toEqual({ poc: 49_998.5, val: 49_998.25, vah: 49_998.75, rows: [
      { low: 49_998.25, high: 49_998.5, buy: 6, sell: 0 },
      { low: 49_998.5, high: 49_998.75, buy: 7, sell: 0 },
    ] })
    expect(levels.profile(100_000, settings)).toEqual({ poc: 49_998.25, val: 49_998.25, vah: 49_998.75, rows: [
      { low: 49_998.25, high: 49_998.75, buy: 13, sell: 0 },
    ] })
    expect(levels.profile(undefined, settings)).toBeUndefined()
  })

  it('旧档缺少框选价值区比例时沿用逐根、可见范围及默认值', () => {
    for (const group of ['profile', 'candleProfile', 'visibleProfile'] as const) {
      expect(orderFlowSettings(group, { candleProfile: { valueArea: 65 }, visibleProfile: { valueArea: 75 } }).valueArea).toBe(65)
      expect(orderFlowSettings(group, { visibleProfile: { valueArea: 75 } }).valueArea).toBe(75)
      expect(orderFlowSettings(group).valueArea).toBe(70)
    }
  })

  it('默认档宽为最新价的 0.01%，自定义比例以百分数保存和计算', () => {
    const levels = new VolumeProfileLevels()
    levels.add(49_998.25, 6)
    levels.add(49_998.5, 4)
    levels.add(49_998.75, 3)
    const defaultSettings = orderFlowSettings('profile')
    expect(defaultSettings.rowSizePercent).toBe(0.01)
    expect(levels.profile(50_000, defaultSettings)).toMatchObject({ poc: 49_998.25, rows: [
      { low: 49_998.25, high: 49_998.75, buy: 13, sell: 0 },
    ] })
    const saved = validateOrderFlowPreferences({ profile: { rowSizePercent: 0.001 } })
    expect(levels.profile(50_000, orderFlowSettings('profile', saved))?.rows).toHaveLength(2)
  })

  it('价值区包含整数边界时高亮下一个档位', () => {
    const prices = { poc: 102, vah: 102, val: 102 }
    const colors = { showValueArea: true, valueAreaColor: '#ffcc70', volumeColor: '#123456' }
    expect(volumeProfileBarColor({ low: 101, high: 102 }, prices, colors)).toBe('#123456')
    expect(volumeProfileBarColor({ low: 102, high: 103 }, prices, colors)).toBe('#ffcc70')
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

    rects.length = 0
    Object.assign(params.indicator.extendData.settings, { showDelta: false, showHeaders: true })
    drawVisibleVolumeProfile(params)
    expect(rects.map(({ color }) => color)).toEqual(Array(3).fill(params.indicator.extendData.settings.volumeColor))
    expect(ctx.fillText.mock.calls.map(([label]) => label)).toEqual(['成交量'])
  })

  it('逐根分布沿用框选的柱条方向和配色，关闭文字仍显示价值区、VAH、POC 和 VAL', () => {
    const rects: { x: number; y: number; width: number; height: number; color: string }[] = []
    const lineLayers: string[] = []
    const ctx = {
      fillStyle: '', save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillText: vi.fn(),
      globalAlpha: 1, globalCompositeOperation: 'destination-over',
      setLineDash: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      stroke() { lineLayers.push(this.globalCompositeOperation) },
      fillRect(x: number, y: number, width: number, height: number) { rects.push({ x, y, width, height, color: this.fillStyle }) },
    }
    const settings = orderFlowSettings('candleProfile', {
      profile: { volumeColor: '#403322', valueAreaColor: '#ffbe52', askColor: '#609da9' },
      candleProfile: { bidColor: '#ef8c89', showLabels: false, width: 100 },
    })
    const profiles = new Map([
      [100, { rows: [{ low: 1, high: 2, buy: 9, sell: 1 }, { low: 2, high: 3, buy: 0, sell: 2 }],
        poc: 1.5, vah: 1.95, val: 1 }],
      [200, { rows: [{ low: 3, high: 4, buy: 0, sell: 2 }], poc: 3.5, vah: 4, val: 3 }],
    ])
    const params = { ctx, bounding: { width: 300, height: 200 }, barSpace: { bar: 100 }, visibleRange: { from: 0, to: 2 },
      kLineDataList: [{ timestamp: 100 }, { timestamp: 200 }], xAxis: { convertToPixel: (index: number) => 90 + index * 100 },
      yAxis: { convertToPixel: (price: number) => 150 - price * 20 },
      indicator: { drawForeground: drawCandleVolumeProfileLevels, extendData: { profiles, settings, precision: 2 } },
    } as unknown as IndicatorDrawParams
    for (const type of ['volumeDelta', 'bidAsk', 'delta', 'volume'] as const) {
      rects.length = 0
      ctx.setLineDash.mockClear()
      ctx.moveTo.mockClear()
      ctx.lineTo.mockClear()
      settings.type = type
      const origin = type === 'volume' ? 40 : 62
      const reference = drawVolumeProfile({
        overlay: { extendData: { profile: profiles.get(100), settings } },
        coordinates: [{ x: origin, y: 100 }, { x: 84, y: 130 }],
        bounding: params.bounding, yAxis: params.yAxis, precision: { price: 2, volume: 0 },
      } as Parameters<typeof drawVolumeProfile>[0])
      const bars = reference.filter(figure => figure.type === 'rect').slice(1)
        .map(figure => ({ ...figure.attrs, color: figure.styles?.color }))
      drawCandleVolumeProfile(params)
      expect(lineLayers).toEqual([])
      drawCandleVolumeProfileLevels(params)
      expect(lineLayers.splice(0)).toEqual(Array(6).fill('source-over'))
      expect(rects.slice(0, bars.length)).toEqual(bars)
      expect(rects[bars.length]).toEqual({ x: origin, y: 111, width: 84 - origin, height: 19, color: '#ffbe52' })
      expect(rects.at(-1)!.x - origin).toBe(100)
      expect(ctx.setLineDash.mock.calls.slice(0, 3)).toEqual([[[4, 3]], [[]], [[4, 3]]])
      expect(ctx.moveTo.mock.calls.slice(0, 3)).toEqual([[origin, 111], [origin, 120], [origin, 130]])
      expect(ctx.lineTo.mock.calls).toEqual([[140, 111], [140, 120], [140, 130], [240, 70], [240, 80], [240, 90]])
      expect(ctx.fillText).not.toHaveBeenCalled()
    }

    rects.length = 0
    Object.assign(settings, { showDelta: false, type: 'delta', showValues: true })
    drawCandleVolumeProfile(params)
    expect(rects.map(({ color }) => color)).toEqual(['#ffbe52', '#403322', '#ffbe52', '#ffbe52', '#ffbe52'])
    expect(ctx.fillText.mock.calls.map(([label]) => label)).toEqual(['10', '2', '2'])

    rects.length = 0
    Object.assign(settings, { showDelta: true, type: 'volumeDelta', width: 5, showValueArea: false })
    drawCandleVolumeProfile(params)
    expect(rects).toHaveLength(6)
    expect(rects[0].color).toBe('#403322')
  })

  it('可见成交分布只在分布条左侧绘制 POC、VAH 和 VAL，并区分价值区内外的成交量', () => {
    const rects: string[] = []
    const ctx = {
      fillStyle: '', save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillText: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), measureText: () => ({ width: 45 }),
      fillRect() { rects.push(this.fillStyle) },
    }
    const rows = [
      { low: 4, high: 5, buy: 16, sell: 2 },
      { low: 5, high: 6, buy: 0, sell: 0 },
      { low: 6, high: 7, buy: 2, sell: 2 },
    ]
    const settings = orderFlowSettings('visibleProfile', { visibleProfile: { type: 'volume', showHeaders: false } })
    const display = { axisInset: () => 64, settings, rows, prices: { poc: 4.5, vah: 5, val: 4 }, precision: 2 }
    const params = { ctx, bounding: { width: 400, height: 180 }, yAxis: { convertToPixel: (price: number) => 100 - price * 10 },
      indicator: { extendData: display } } as unknown as IndicatorDrawParams
    drawVisibleVolumeProfile(params)
    expect(rects.slice(0, 2)).toEqual([settings.valueAreaColor, settings.volumeColor])
    expect(ctx.setLineDash.mock.calls).toEqual([[[4, 3]], [[]], [[4, 3]]])
    expect(ctx.moveTo.mock.calls).toEqual([[248, 50], [248, 55], [248, 60]])
    expect(ctx.lineTo.mock.calls).toEqual([[0, 50], [0, 55], [0, 60]])
    expect(ctx.restore.mock.invocationCallOrder[0]).toBeLessThan(ctx.moveTo.mock.invocationCallOrder[0])
    expect(ctx.fillText.mock.calls.map(([label]) => label)).toEqual(['VAH 5.00', 'POC 4.50', 'VAL 4.00'])
    ctx.fillText.mockClear()
    ctx.stroke.mockClear()
    rects.length = 0
    ctx.moveTo.mockClear()
    ctx.lineTo.mockClear()
    display.settings = { ...settings, placement: 'left', offset: 10, showValueArea: false, showLabels: false }
    drawVisibleVolumeProfile(params)
    expect(rects).toEqual([settings.volumeColor, settings.volumeColor])
    expect(ctx.stroke).toHaveBeenCalledTimes(1)
    expect(ctx.moveTo).toHaveBeenCalledWith(36, 55)
    expect(ctx.lineTo).toHaveBeenCalledWith(0, 55)
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
    const levels = new VolumeProfileLevels()
    const settings = orderFlowSettings('profile')
    expect(levels.profile(10_000, settings)).toBeUndefined()
    for (const [price, size] of [[100, 2], [101.5, 4], [101.5, -2], [102.5, -3], [104, 1]]) levels.add(price, size)
    const result = levels.profile(10_000, settings)!
    expect(result).toMatchObject({ poc: 101.5, vah: 102.5, val: 101.5 })
    expect(result.rows[1]).toEqual({ low: 101, high: 102, buy: 4, sell: 2 })
    expect(result.rows[3]).toEqual({ low: 104, high: 104, buy: 1, sell: 0 })
    expect(levels.profile(10_000, { ...settings, valueArea: 100 })).toMatchObject({ poc: 101.5, vah: 104, val: 100 })
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
    const levels = new VolumeProfileLevels()
    const settings = orderFlowSettings('profile')
    levels.add(100, 4)
    levels.add(103, -0.5)
    levels.add(103.5, -0.5)
    const params = {
      overlay: { extendData: { profile: levels.profile(10_000, settings), settings } },
      coordinates: [{ x: 50, y: 88 }, { x: 250, y: 92 }],
      yAxis: { convertToPixel: (price: number) => (103.5 - price) * 50 + 20 },
      precision: { price: 2, volume: 0 },
    } as Parameters<typeof drawVolumeProfile>[0]
    const figures = drawVolumeProfile(params)
    expect(figures[0].attrs).toEqual({ x: 50, width: 200, y: 20, height: 175 })
    expect(figures.filter(figure => figure.type === 'rect').slice(1).map(figure => figure.styles?.color))
      .toEqual(['#5e93d67a', '#49d4ae66', '#3b54766b', '#ff827e66'])
    expect(figures.filter(figure => figure.type === 'line')).toHaveLength(3)

    Object.assign(params.overlay.extendData.settings, { showDelta: false, showValues: true })
    const volumeOnly = drawVolumeProfile(params)
    expect(volumeOnly.filter(figure => figure.type === 'rect').slice(1).map(figure => figure.styles?.color))
      .toEqual(['#5e93d67a', '#3b54766b'])
    expect(volumeOnly.filter(figure => figure.type === 'text').slice(0, 3).map(figure => (figure.attrs as { text: string }).text))
      .toEqual(['成交量', '4', '1'])
    expect(volumeOnly.filter(figure => figure.type === 'line')).toHaveLength(3)
  })

  it('逐笔统计尚未完成时，选区仍按价格高低点绘制', () => {
    const figures = drawVolumeProfile({
      overlay: { extendData: { bounds: { low: 101, high: 103 }, message: '读取区间成交…' } },
      coordinates: [{ x: 30, y: 10 }, { x: 80, y: 170 }],
      bounding: { height: 200 },
      yAxis: { convertToPixel: (price: number) => (104 - price) * 20 },
    } as Parameters<typeof drawVolumeProfile>[0])
    expect(figures[0].attrs).toEqual({ x: 30, width: 50, y: 20, height: 40 })
  })

  it('价格超出主图可见范围时，选区贴在价格边界', () => {
    const bounds = { low: 101, high: 103 }
    const coords = [{ x: 30, y: -200 }, { x: 80, y: 400 }]
    const figures = (convertToPixel: (value: number) => number) => drawVolumeProfile({
      overlay: { extendData: { bounds } }, coordinates: coords, bounding: { height: 200 },
      yAxis: { convertToPixel },
    } as Parameters<typeof drawVolumeProfile>[0])
    expect(figures(value => -value)[0].attrs).toEqual({ x: 30, width: 50, y: 0, height: 6 })
    expect(figures(value => 500 - value)[0].attrs).toEqual({ x: 30, width: 50, y: 194, height: 6 })
    expect(figures(value => (102 - value) * 150 + 100)[0].attrs).toEqual({ x: 30, width: 50, y: 0, height: 200 })
  })
})
