import { describe, expect, it } from 'vitest'
import type { Indicator, IndicatorStyle, KLineData } from 'klinecharts'
import { calculateTtmSqueeze, ttmSqueezeIndicator, type TtmSqueezeValue } from './ttm-squeeze'

const candles: KLineData[] = [
  [11, 9, 10], [12, 10, 11], [13, 11, 12], [17, 15, 16],
  [18, 16, 17], [13, 11, 12], [12, 10, 11],
].map(([high, low, close], index) => ({ timestamp: index * 60_000, open: close, high, low, close }))

describe('TTM Squeeze', () => {
  it('detects compression and release using population deviation and shared KC', () => {
    const result = calculateTtmSqueeze(candles, 3, 2, 1)
    expect(result.slice(0, 2)).toEqual([{}, {}])
    expect(result[2]).toEqual({ squeeze: true, dot: 0 })
    expect(result[3]).toEqual({ squeeze: false, dot: 0 })
    // At bar 2 population sigma * 2 < 2; sample sigma * 2 = 2 would fail strict containment.
    const flat = candles.map(c => ({ ...c, high: 10, low: 10, close: 10, open: 10 }))
    expect(calculateTtmSqueeze(flat, 3, 2, 1)[2]).toEqual({ squeeze: false, dot: 0 })
  })

  it('matches hand-calculated rolling linear regression endpoints after full warmup', async () => {
    const result = calculateTtmSqueeze(candles, 3, 2, 1)
    expect(result[3].momentum).toBeUndefined()
    expect(result[4].momentum).toBeCloseTo(2.625, 12)
    expect(result[5].momentum).toBeCloseTo(-2, 12)
    expect(result[6].momentum).toBeCloseTo(-253 / 72, 12)
    const configured = { calcParams: [3, 2, 1] } as Parameters<typeof ttmSqueezeIndicator.calc>[1]
    expect((await ttmSqueezeIndicator.calc(candles, configured))[4].momentum).toBeCloseTo(2.625, 12)
  })

  it('has zero finite momentum for flat data and supports period one', () => {
    const flat = Array.from({ length: 40 }, (_, timestamp) => ({ timestamp, open: 10, high: 10, low: 10, close: 10 }))
    const result = calculateTtmSqueeze(flat)
    expect(result[37].momentum).toBeUndefined()
    expect(result[38].momentum).toBe(0)
    expect(calculateTtmSqueeze(flat, 1)[0]).toEqual({ squeeze: false, dot: 0, momentum: 0 })
  })

  it('rejects invalid parameters defensively and preserves the past during live updates', () => {
    expect(calculateTtmSqueeze([])).toEqual([])
    for (const params of [[0, 2, 1], [1.5, 2, 1], [3, 0, 1], [3, 2, Infinity]]) {
      expect(calculateTtmSqueeze(candles, ...params as [number, number, number])).toEqual(candles.map(() => ({})))
    }
    const original = structuredClone(candles)
    const full = calculateTtmSqueeze(candles, 3, 2, 1)
    for (let end = 1; end <= candles.length; end++) {
      expect(calculateTtmSqueeze(candles.slice(0, end), 3, 2, 1)).toEqual(full.slice(0, end))
    }
    const live = calculateTtmSqueeze([...candles.slice(0, -1), { ...candles.at(-1)!, high: 30, close: 29 }], 3, 2, 1)
    expect(live.slice(0, -1)).toEqual(full.slice(0, -1))
    expect(live.at(-1)?.momentum).not.toBe(full.at(-1)?.momentum)
    expect(candles).toEqual(original)
  })

  it('colors the four momentum states independently of squeeze dot colors', () => {
    const figure = ttmSqueezeIndicator.figures!.find(f => f.key === 'momentum')!
    const indicator = { styles: null } as unknown as Indicator<TtmSqueezeValue>
    for (const [previous, current, color] of [[1, 2, '#00bcd4'], [2, 1, '#2962ff'], [-1, -2, '#ef5350'], [-2, -1, '#ffca28']] as const) {
      expect(figure.styles!({ prev: { indicatorData: { momentum: previous } }, current: { indicatorData: { momentum: current } }, next: {} }, indicator, {} as IndicatorStyle).color)
        .toBe(color)
    }
    const dot = ttmSqueezeIndicator.figures!.find(f => f.key === 'dot')!
    for (const [squeeze, color] of [[true, '#ef5350'], [false, '#26a69a']] as const) {
      expect(dot.styles!({ prev: {}, current: { indicatorData: { squeeze, dot: 0 } }, next: {} }, indicator, {} as IndicatorStyle).color).toBe(color)
    }
  })
})
