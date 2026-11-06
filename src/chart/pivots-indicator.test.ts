import { describe, expect, it, vi } from 'vitest'
import type { Indicator, IndicatorDrawParams, KLineData } from 'klinecharts'
import type { Datafeed } from '@klinecharts/pro'
import { createPivotCalculator, latestPivotCalculation, drawPivots } from './pivots-indicator'
import { PIVOTS_DEFAULT_PARAMS, type PivotValue } from './pivots'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from './chart-config'

const day = 86_400_000
const start = Date.UTC(2026, 0, 1)
const daily: KLineData[] = [0, 1, 2].map((index) => ({ timestamp: start + index * day, open: 100, high: 120, low: 90, close: 105 }))
const chart: KLineData[] = [daily[1], { ...daily[1], timestamp: start + day + 3_600_000 }]
const period = SUPPORTED_PERIODS.find((item) => item.text === '1h')!

function fixture() {
  const getHistoryKLineData = vi.fn(async () => daily)
  const feed = { getHistoryKLineData } as unknown as Datafeed
  const context = { symbol: DEFAULT_SYMBOL, period, sessionKey: 'one', confirmedUntil: start + day + 3_600_000 }
  return { calculate: createPivotCalculator(feed, () => context), getHistoryKLineData, context }
}

describe('pivot higher-timeframe reads', () => {
  it('reads the extra completed period needed for carry-over with history one', async () => {
    const { calculate, getHistoryKLineData } = fixture()
    const params = [...PIVOTS_DEFAULT_PARAMS]
    params[1] = 'Daily'; params[2] = 1; params[33] = true
    expect((await calculate([daily[2]], params))[0].previousP).toBe(105)
    expect(getHistoryKLineData).toHaveBeenCalledWith(DEFAULT_SYMBOL, expect.objectContaining({ text: '1d' }), start, start + 2 * day, false)
  })

  it('draws prior levels dashed in independent group colors while honoring switches', () => {
    const params = [...PIVOTS_DEFAULT_PARAMS]
    params[4] = false; params[5] = false; params[10] = false; params[33] = true
    let dash: number[] = []
    const strokes: { color: string; dash: number[] }[] = []
    const ctx = {
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {},
      setLineDash(value: number[]) { dash = value }, strokeStyle: '',
      stroke() { strokes.push({ color: this.strokeStyle, dash }) },
    }
    const result: PivotValue[] = [{ segment: {
      start, end: start + day, levels: { P: 100, R1: 110, S1: 90 }, previous: { P: 95, R1: 105, S1: 85 },
    } }]
    drawPivots({ ctx, indicator: { calcParams: params, result }, kLineDataList: daily,
      bounding: { width: 500, height: 200 }, xAxis: { convertToPixel: (i: number) => i * 100 },
      yAxis: { convertToPixel: (value: number) => value },
    } as unknown as IndicatorDrawParams<PivotValue>, '1d')
    expect(strokes).toEqual([
      { color: '#a78bfa', dash: [5, 4] }, { color: '#38bdf8', dash: [5, 4] },
      { color: '#fb8c00', dash: [] }, { color: '#26a69a', dash: [] },
    ])
  })
  it('prevents a slow older calculation from replacing newer parameters or another symbol', async () => {
    const { context } = fixture()
    let resolveOld: (value: PivotValue[]) => void = () => {}
    const old = new Promise<PivotValue[]>((resolve) => { resolveOld = resolve })
    const calculate = vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce([{ P: 110 }])
    const guarded = latestPivotCalculation(calculate, () => context)
    const indicator = { calcParams: [] } as unknown as Indicator<PivotValue>
    const pending = guarded(chart, indicator)
    const stale = expect(pending).rejects.toThrow('Superseded')
    await expect(guarded(chart, indicator)).resolves.toEqual([{ P: 110 }])
    resolveOld([{ P: 100 }])
    await stale

    const switched = latestPivotCalculation(async () => {
      context.symbol = { ...DEFAULT_SYMBOL, ticker: 'ETHUSDT' }
      return [{ P: 100 }]
    }, () => context)
    await expect(switched(chart, indicator)).rejects.toThrow('Superseded')
  })

  it('requests guarded daily history without changing selection and reuses it across ticks/types', async () => {
    const { calculate, getHistoryKLineData } = fixture()
    expect((await calculate(chart, ['Traditional', 'Daily'])).at(-1)?.P).toBe(105)
    await calculate([...chart.slice(0, 1), { ...chart[1], close: 999 }], ['Fibonacci', 'Daily'])
    expect(getHistoryKLineData).toHaveBeenCalledTimes(1)
    expect(getHistoryKLineData).toHaveBeenCalledWith(DEFAULT_SYMBOL, expect.objectContaining({ text: '1d' }), start - 14 * day, start + day, false)
  })

  it('aggregates chart candles without requesting history when daily-based values are disabled', async () => {
    const { calculate, getHistoryKLineData } = fixture()
    const result = await calculate(chart, ['Traditional', 'Daily', 15, false])
    expect(result.at(-1)?.message).toContain('历史不足')
    expect(getHistoryKLineData).not.toHaveBeenCalled()
  })

  it('shares in-flight reads and retains failures until an explicit refresh or new period', async () => {
    const { calculate, getHistoryKLineData } = fixture()
    getHistoryKLineData.mockRejectedValueOnce(new Error('limited'))
    const [first, second] = await Promise.all([calculate(chart, ['Traditional', 'Daily']), calculate(chart, ['Traditional', 'Daily'])])
    expect(first.at(-1)?.message).toContain('读取失败')
    expect(second).toEqual(first)
    await calculate(chart, ['Traditional', 'Daily'])
    expect(getHistoryKLineData).toHaveBeenCalledTimes(1)
    calculate.clearCache()
    expect((await calculate(chart, ['Traditional', 'Daily'])).at(-1)?.P).toBe(105)
    expect(getHistoryKLineData).toHaveBeenCalledTimes(2)
  })

  it('refreshes the current source once at confirmed close and separates replay sessions', async () => {
    const { calculate, getHistoryKLineData, context } = fixture()
    await calculate(chart, ['Traditional', 'Daily'])
    context.confirmedUntil = start + 2 * day
    await calculate([{ ...chart[1], timestamp: start + 2 * day - 3_600_000 }], ['Traditional', 'Daily'])
    expect(getHistoryKLineData).toHaveBeenCalledTimes(2)
    context.sessionKey = 'two'
    await calculate(chart, ['Traditional', 'Daily'])
    expect(getHistoryKLineData).toHaveBeenCalledTimes(3)
  })
})
