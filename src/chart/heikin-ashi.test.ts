import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

describe('Heikin Ashi display candles', () => {
  it('draws the HA body and wicks on the main pane and keeps subpane OHLC raw', () => {
    const source = readFileSync('node_modules/klinecharts/dist/index.esm.js', 'utf8')
    const marker = 'CandleBarView.prototype.drawImp = '
    const start = source.indexOf(marker) + marker.length
    const end = source.indexOf('    CandleBarView.prototype.getCandleBarOptions', start)
    const draw = runInNewContext(`(${source.slice(start, end).trim().replace(/;$/, '')})`, {
      PaneIdConstants: { CANDLE: 'candle_pane' },
      CandleType: { HeikinAshi: 'heikin_ashi', CandleSolid: 'candle_solid' },
      isValid: (value: unknown) => value !== null && value !== undefined,
    })
    const raw = { open: 90, high: 95, low: 80, close: 85 }
    const ha = { open: 114, high: 114, low: 80, close: 87.5 }
    let paneId = 'candle_pane'
    const bars: unknown[][] = []
    const store = { getHeikinAshiData: () => ha }
    const view = {
      getWidget: () => ({ getPane: () => ({
        getId: () => paneId,
        getChart: () => ({ getChartStore: () => store }),
        getAxisComponent: () => ({ convertToPixel: (price: number) => 200 - price }),
      }) }),
      getCandleBarOptions: () => ({ type: paneId === 'candle_pane' ? 'heikin_ashi' : 'candle_solid', styles: { downColor: 'red' } }),
      eachChildren: (callback: (...args: unknown[]) => void) => callback({ data: raw, dataIndex: 2, x: 20 }, {}),
      _createSolidBar: (...args: unknown[]) => { bars.push(args); return [] },
    }
    draw.call(view, {})
    expect(bars).toEqual([[20, [86, 86, 112.5, 120], {}, ['red', undefined, undefined]]])
    paneId = 'subpane'
    draw.call(view, {})
    expect(bars[1]).toEqual([20, [105, 110, 115, 120], {}, ['red', undefined, undefined]])
    expect(raw).toEqual({ open: 90, high: 95, low: 80, close: 85 })
  })

  it('uses prior HA bodies, includes synthetic extremes and never mutates trade candles', () => {
    const source = readFileSync('node_modules/klinecharts/dist/index.esm.js', 'utf8')
    const marker = 'ChartStore.prototype.getHeikinAshiData = '
    expect(source.includes(marker)).toBe(true)
    const start = source.indexOf(marker) + marker.length
    const end = source.indexOf('\n    };', start) + 7
    const get = runInNewContext(`(${source.slice(start, end).trim().replace(/;$/, '')})`)
    const raw = [
      { timestamp: 1, open: 100, high: 110, low: 98, close: 108, volume: 5 },
      { timestamp: 2, open: 120, high: 130, low: 118, close: 128, volume: 8 },
      { timestamp: 3, open: 90, high: 95, low: 80, close: 85, volume: 3 },
    ]
    const before = structuredClone(raw)
    const store = { _dataList: raw, _heikinAshiData: [] }
    expect(get.call(store, 0)).toEqual({ ...raw[0], open: 104, high: 110, low: 98, close: 104 })
    expect(get.call(store, 1)).toEqual({ ...raw[1], open: 104, high: 130, low: 104, close: 124 })
    expect(get.call(store, 2)).toEqual({ ...raw[2], open: 114, high: 114, low: 80, close: 87.5 })
    expect(raw).toEqual(before)
    expect(get.call(store, 2)).toBe(get.call(store, 2))
  })
})
