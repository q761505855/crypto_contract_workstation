import { describe, expect, it } from 'vitest'
import type { Indicator, IndicatorStyle, KLineData } from 'klinecharts'
import { calculateTtmWave, ttmWaveIndicators, type TtmWaveValue } from './ttm-wave'

const candles: KLineData[] = [10, 12, 8, 13].map((close, timestamp) => ({ timestamp, open: close, high: close, low: close, close }))

describe('TTM Wave ABC', () => {
  it('matches hand-calculated first-close EMA and signal EMA for both histograms', () => {
    // fast=1; slow1=2(alpha=2/3); slow2=3(alpha=1/2).
    const result = calculateTtmWave(candles, 'A', 1, 2, 3)
    expect(result[0]).toEqual({ wave1: 0, wave2: 0, zero: 0 })
    expect(result[1].wave1).toBeCloseTo(0.5, 12)
    expect(result[1].wave2).toBeCloseTo(2 / 9, 12)
    expect(result[2].wave1).toBeCloseTo(-1, 12)
    // slow EMA = 82/9, D = -10/9, signal EMA = -16/27, H = -14/27.
    expect(result[2].wave2).toBeCloseTo(-14 / 27, 12)
    expect(calculateTtmWave(candles, 'B', 1, 2, 3)).toEqual(result)
  })

  it('uses the raw long EMA difference for C wave1 instead of a second histogram', () => {
    const result = calculateTtmWave(candles, 'C', 1, 2, 3)
    expect(result[1].wave1).toBeCloseTo(1, 12)
    expect(result[2].wave1).toBeCloseTo(-1.5, 12)
    expect(result[2].wave2).toBeCloseTo(-14 / 27, 12)
  })

  it('registers independent defaults, honors edited parameters and colors', async () => {
    expect(ttmWaveIndicators.map(i => [i.name, i.calcParams])).toEqual([
      ['TTM_WAVE_A', [8, 34, 55]], ['TTM_WAVE_B', [8, 89, 144]], ['TTM_WAVE_C', [8, 233, 377]],
    ])
    for (const indicator of ttmWaveIndicators) {
      const configured = { calcParams: [1, 2, 3], styles: { bars: [{ noChangeColor: '#123456' }] } } as Indicator<TtmWaveValue>
      const result = await indicator.calc(candles, configured)
      expect(result[2].wave2).toBeCloseTo(-14 / 27, 12)
      expect(indicator.figures![0].styles!({ prev: {}, current: {}, next: {} }, configured, {} as IndicatorStyle).color).toBe('#123456')
    }
  })

  it('handles empty and flat data, rejects invalid periods, and never uses future candles', () => {
    const original = structuredClone(candles)
    for (const wave of ['A', 'B', 'C'] as const) {
      expect(calculateTtmWave([], wave)).toEqual([])
      expect(calculateTtmWave(candles.map(c => ({ ...c, close: 10 })), wave)).toEqual(candles.map(() => ({ wave1: 0, wave2: 0, zero: 0 })))
      for (const params of [[0, 2, 3], [1, 2.5, 3], [1, 3, 2], [1, 2, 2], [1, 2, Infinity]]) {
        expect(calculateTtmWave(candles, wave, ...params as [number, number, number])).toEqual(candles.map(() => ({})))
      }
      const result = calculateTtmWave(candles, wave)
      for (let end = 1; end <= candles.length; end++) expect(calculateTtmWave(candles.slice(0, end), wave)).toEqual(result.slice(0, end))
      const live = calculateTtmWave([...candles.slice(0, -1), { ...candles.at(-1)!, close: 20 }], wave)
      expect(live.slice(0, -1)).toEqual(result.slice(0, -1))
      expect(live.at(-1)).not.toEqual(result.at(-1))
    }
    expect(candles).toEqual(original)
  })

  it('colors each wave by its own sign and preserves legacy colors above zero', () => {
    for (const template of ttmWaveIndicators) {
      const legacy = { styles: { bars: [{ noChangeColor: '#123456' }, { noChangeColor: '#abcdef' }] } } as Indicator<TtmWaveValue>
      for (const [index, key, positive, negative] of [
        [0, 'wave1', '#123456', { TTM_WAVE_A: '#d93654', TTM_WAVE_B: '#dc4940', TTM_WAVE_C: '#d33e62' }[template.name]],
        [1, 'wave2', '#abcdef', { TTM_WAVE_A: '#ffadba', TTM_WAVE_B: '#ffc0aa', TTM_WAVE_C: '#ffb3ce' }[template.name]],
      ] as const) {
        const figure = template.figures![index]
        for (const [value, expected] of [[1, positive], [0, positive], [-1, negative]] as const) {
          expect(figure.styles!({ prev: {}, current: { indicatorData: { [key]: value } }, next: {} }, legacy, {} as IndicatorStyle).color).toBe(expected)
        }
      }
      const signed = { styles: { bars: [{ positiveColor: '#aabbcc', negativeColor: '#ddeeff' }] } } as unknown as Indicator<TtmWaveValue>
      expect(template.figures![0].styles!({ prev: {}, current: { indicatorData: { wave1: -2, wave2: 3 } }, next: {} }, signed, {} as IndicatorStyle).color).toBe('#ddeeff')
      expect(template.figures![0].styles!({ prev: {}, current: { indicatorData: { wave1: 2, wave2: -3 } }, next: {} }, signed, {} as IndicatorStyle).color).toBe('#aabbcc')
    }
  })

  it('keeps both overlapping C waves visible with centered wide and narrow bars', () => {
    const figures = ttmWaveIndicators[2].figures!
    const args = {
      coordinate: { current: { x: 20, wave1: 30, wave2: 40 } },
      barSpace: { gapBar: 8 }, yAxis: { convertToPixel: () => 100 },
    } as unknown as Parameters<NonNullable<typeof figures[0]['attrs']>>[0]
    expect(figures[0].attrs!(args)).toEqual({ x: 16, y: 30, width: 8, height: 70 })
    expect(figures[1].attrs!(args)).toEqual({ x: 18, y: 40, width: 4, height: 60 })
  })
})
