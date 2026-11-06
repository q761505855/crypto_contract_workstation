import type {
  ChartPro,
  ChartProOptions,
  Period,
  SymbolInfo,
} from '@klinecharts/pro'
import type { Chart } from 'klinecharts'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@klinecharts/pro', () => ({ KLineChartPro: vi.fn() }))
import { ProChartAdapter } from './pro-chart-adapter'
import { validateChartIndicatorPreferences } from './indicator-preferences'

function fakeChart(coreChart?: Chart): ChartPro {
  return {
    getLocale: vi.fn(() => 'zh-CN'),
    getPeriod: vi.fn(() => ({
      multiplier: 15,
      timespan: 'minute',
      text: '15m',
    })),
    getStyles: vi.fn(() => ({}) as ReturnType<ChartPro['getStyles']>),
    getSymbol: vi.fn(() => ({ ticker: 'BTCUSDT' })),
    getTheme: vi.fn(() => 'dark'),
    getTimezone: vi.fn(() => 'Asia/Shanghai'),
    getChart: vi.fn(
      () =>
        coreChart ??
        ({
          createOverlay: vi.fn(),
          removeOverlay: vi.fn(),
        } as unknown as Chart),
    ),
    setLocale: vi.fn(),
    setPeriod: vi.fn(),
    setStyles: vi.fn(),
    setSymbol: vi.fn(),
    setTheme: vi.fn(),
    setTimezone: vi.fn(),
  }
}

describe('ProChartAdapter', () => {
  it('keeps native separator extremes valid without archiving compressed display heights', () => {
    let viewportHeight = 1000
    let height = 160
    let onDrag: (() => void) | undefined
    const core = {
      getIndicatorByPaneId: () => new Map([['candle_pane', new Map()], ['rsi', new Map([['RSI', { name: 'RSI', calcParams: [6, 12, 24], visible: true, styles: null }]])]]),
      getSize: (id?: string) => ({ height: id === undefined ? viewportHeight : id === 'x_axis_pane' ? 24 : height }),
      setPaneOptions: (options: { height: number }) => { height = options.height },
      subscribeAction: (type: string, callback: () => void) => { if (type === 'onPaneDrag') onDrag = callback },
    } as unknown as Chart
    const adapter = new ProChartAdapter(() => fakeChart(core))
    adapter.mount({ container: document.createElement('div'), symbol: { ticker: 'BTCUSDT' }, period: { multiplier: 15, timespan: 'minute', text: '15m' }, datafeed: { searchSymbols: async () => [], getHistoryKLineData: async () => [], subscribe() {}, unsubscribe() {} } })
    adapter.layoutSubPanes(0)
    height = 0
    onDrag?.()
    expect(adapter.getIndicatorPaneSizes()[0].height).toBe(60)
    expect(height).toBe(60)
    expect(() => validateChartIndicatorPreferences(adapter.getIndicatorPreferences())).not.toThrow()
    height = 900
    onDrag?.()
    expect(adapter.getIndicatorPaneSizes()[0].height).toBe(600)
    expect(height).toBe(600)
    height = 120.6
    onDrag?.()
    expect(adapter.getIndicatorPaneSizes()[0].height).toBe(121)
    expect(height).toBe(121)
    viewportHeight = 250
    adapter.layoutSubPanes(80)
    expect(height).toBeLessThan(60)
    onDrag?.()
    expect(adapter.getIndicatorPaneSizes()[0].height).toBe(121)
    expect(adapter.getIndicatorPreferences().sub[0].height).toBe(121)
    height = 0
    onDrag?.()
    expect(adapter.getIndicatorPreferences().sub[0].height).toBe(60)
    expect(height).toBeGreaterThan(0)
    expect(height).toBeLessThan(60)
    viewportHeight = 1000
    adapter.layoutSubPanes(0)
    expect(height).toBe(60)
  })

  it('archives explicit slider pane sizing across responsive transitions without losing indicator settings', () => {
    let height = 100
    const indicator = { name: 'RSI', calcParams: [6, 12, 24], visible: false, styles: { lines: [{ color: '#123456' }] } }
    const core = {
      getIndicatorByPaneId: () => new Map([['candle_pane', new Map()], ['rsi', new Map([['RSI', indicator]])]]),
      getSize: (id?: string) => ({ height: id === undefined ? 1000 : height }),
      setPaneOptions: (options: { height: number }) => { height = options.height },
    } as unknown as Chart
    const adapter = new ProChartAdapter(() => fakeChart(core))
    adapter.mount({ container: document.createElement('div'), symbol: { ticker: 'BTCUSDT' }, period: { multiplier: 15, timespan: 'minute', text: '15m' }, datafeed: { searchSymbols: async () => [], getHistoryKLineData: async () => [], subscribe: () => {}, unsubscribe: () => {} } })
    adapter.layoutSubPanes(200)
    adapter.setIndicatorPaneHeight('rsi', 260)
    adapter.layoutSubPanes(200)
    expect(height).toBe(260)
    expect(adapter.getIndicatorPaneSizes()).toEqual([{ id: 'rsi', label: 'RSI', height: 260 }])
    expect(adapter.getIndicatorPreferences().sub).toEqual([{ height: 260, indicators: [indicator] }])
    adapter.layoutSubPanes(0)
    expect(height).toBe(260)
    adapter.setIndicatorPaneHeight('rsi', 60)
    adapter.layoutSubPanes(80)
    expect(height).toBe(80)
    expect(adapter.getIndicatorPreferences().sub[0].height).toBe(60)
    adapter.layoutSubPanes(0)
    expect(height).toBe(60)
    for (const invalid of [0, 59, 601, 100.5, NaN]) expect(() => adapter.setIndicatorPaneHeight('rsi', invalid)).toThrow()
  })

  it('reserves room for the candle pane while retaining desired sizes through compact layouts and explicit changes', () => {
    let viewportHeight = 400
    const heights = new Map([['vol', 180], ['macd', 200], ['rsi', 320]])
    const panes = new Map([['candle_pane', new Map()], ...['vol', 'macd', 'rsi'].map((id) => [id, new Map([[id.toUpperCase(), { name: id.toUpperCase(), calcParams: [], visible: true, styles: null }]])] as const)])
    const core = {
      getIndicatorByPaneId: () => panes,
      getSize: (id?: string) => ({ height: id === undefined ? viewportHeight : id === 'x_axis_pane' ? 24 : heights.get(id) ?? 180 }),
      setPaneOptions: ({ id, height }: { id: string; height: number }) => { heights.set(id, height) },
    } as unknown as Chart
    const adapter = new ProChartAdapter(() => fakeChart(core))
    adapter.mount({ container: document.createElement('div'), symbol: { ticker: 'BTCUSDT' }, period: { multiplier: 15, timespan: 'minute', text: '15m' }, datafeed: { searchSymbols: async () => [], getHistoryKLineData: async () => [], subscribe: () => {}, unsubscribe: () => {} } })
    expect(adapter.layoutSubPanes(80)).toBeLessThanOrEqual(196)
    expect([...heights.values()].every((height) => height > 0 && height < 180)).toBe(true)
    expect(adapter.getIndicatorPreferences().sub.map(({ height }) => height)).toEqual([180, 200, 320])
    adapter.setIndicatorPaneHeight('macd', 600)
    adapter.layoutSubPanes(80)
    expect(adapter.getIndicatorPreferences().sub.map(({ height }) => height)).toEqual([180, 600, 320])
    expect(adapter.layoutSubPanes(0)).toBeLessThanOrEqual(196)
    viewportHeight = 1600
    adapter.layoutSubPanes(0)
    expect([...heights.values()]).toEqual([180, 600, 320])
    viewportHeight = 400
    adapter.layoutSubPanes(80)
    viewportHeight = 1600
    adapter.layoutSubPanes(0)
    expect(adapter.getIndicatorPaneSizes().map(({ height }) => height)).toEqual([180, 600, 320])
  })

  it('expands narrow-screen subpanes without overwriting saved heights and tracks explicit user resizing', () => {
    const indicator = { name: 'VOL', calcParams: [], visible: true, styles: null }
    const panes = new Map([
      ['candle_pane', new Map()],
      ['volume', new Map([['VOL', indicator]])],
      ['oscillator', new Map([['MACD', { ...indicator, name: 'MACD' }]])],
    ])
    const heights = new Map([['volume', 100], ['oscillator', 280]])
    let onDrag: (() => void) | undefined
    const core = {
      getIndicatorByPaneId: () => panes,
      getSize: (id?: string) => ({ height: id === undefined ? 1000 : id === 'x_axis_pane' ? 24 : heights.get(id) ?? 500 }),
      setPaneOptions: ({ id, height }: { id: string; height: number }) => { heights.set(id, height) },
      subscribeAction: (type: string, callback: () => void) => { if (type === 'onPaneDrag') onDrag = callback },
    } as unknown as Chart
    const adapter = new ProChartAdapter(() => fakeChart(core))
    adapter.mount({
      container: document.createElement('div'),
      symbol: { ticker: 'BTCUSDT' },
      period: { multiplier: 15, timespan: 'minute', text: '15m' },
      datafeed: { searchSymbols: async () => [], getHistoryKLineData: async () => [], subscribe: () => {}, unsubscribe: () => {} },
    })
    expect(adapter.layoutSubPanes(200)).toBe(484)
    expect(heights.get('volume')).toBe(200)
    expect(adapter.getIndicatorPreferences().sub.map(({ height }) => height)).toEqual([100, 280])
    heights.set('oscillator', 320)
    onDrag?.()
    expect(adapter.getIndicatorPreferences().sub.map(({ height }) => height)).toEqual([100, 320])
    adapter.layoutSubPanes(0)
    expect(heights.get('volume')).toBe(100)
    expect(heights.get('oscillator')).toBe(320)
    adapter.layoutSubPanes(200)
    panes.delete('volume')
    expect(adapter.layoutSubPanes(200)).toBe(322)
    panes.set('new-pane', new Map([['RSI', { ...indicator, name: 'RSI' }]]))
    heights.set('new-pane', 100)
    expect(adapter.layoutSubPanes(200)).toBe(524)
  })

  it('keeps compact subpanes stable when chart height grows and preserves archived sizes', () => {
    let viewportHeight = 600
    const heights = new Map([['vol', 100], ['macd', 180], ['rsi', 100]])
    const panes = new Map([['candle_pane', new Map()], ...[...heights.keys()].map(id => [id, new Map([[id, { name: id.toUpperCase(), calcParams: [], visible: true, styles: null }]])] as const)])
    const core = {
      getIndicatorByPaneId: () => panes,
      getSize: (id?: string) => ({ height: id === undefined ? viewportHeight : id === 'x_axis_pane' ? 24 : heights.get(id) ?? 180 }),
      setPaneOptions: ({ id, height }: { id: string; height: number }) => { heights.set(id, height) },
    } as unknown as Chart
    const adapter = new ProChartAdapter(() => fakeChart(core))
    adapter.mount({ container: document.createElement('div'), symbol: { ticker: 'BTCUSDT' }, period: { multiplier: 15, timespan: 'minute', text: '15m' }, datafeed: { searchSymbols: async () => [], getHistoryKLineData: async () => [], subscribe() {}, unsubscribe() {} } })
    const total = adapter.layoutSubPanes(60, 200)
    const compactHeights = [...heights.values()]
    expect(total).toBeLessThanOrEqual(206)
    viewportHeight = 1200
    expect(adapter.layoutSubPanes(60, 200)).toBe(total)
    expect([...heights.values()]).toEqual(compactHeights)
    expect(adapter.getIndicatorPreferences().sub.map(pane => pane.height)).toEqual([100, 180, 100])
    adapter.layoutSubPanes(0)
    expect([...heights.values()]).toEqual([100, 180, 100])
  })

  it('only toggles main indicator legends while preserving candle and subpane tooltips', () => {
    const setStyles = vi.fn()
    const core = { setStyles } as unknown as Chart
    const adapter = new ProChartAdapter(() => fakeChart(core))
    adapter.mount({ container: document.createElement('div'), datafeed: { getHistoryKLineData: async () => [], searchSymbols: async () => [], subscribe() {}, unsubscribe() {} }, period: { multiplier: 15, timespan: 'minute', text: '15m' }, symbol: { ticker: 'BTCUSDT' } })
    adapter.setIndicatorInfoVisible(false)
    expect(setStyles).toHaveBeenLastCalledWith({ candle: { tooltip: { showIndicator: false } } })
    adapter.setIndicatorInfoVisible(true)
    expect(setStyles).toHaveBeenLastCalledWith({ candle: { tooltip: { showIndicator: true } } })
  })

  it('mounts once and delegates public updates', () => {
    const chart = fakeChart()
    const factory = vi.fn((_options: ChartProOptions) => chart)
    const adapter = new ProChartAdapter(factory)
    const options = {
      container: document.createElement('div'),
      datafeed: {
        getHistoryKLineData: vi.fn(async () => []),
        searchSymbols: vi.fn(async () => []),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
      },
      period: { multiplier: 15, timespan: 'minute', text: '15m' },
      symbol: { ticker: 'BTCUSDT' },
    } satisfies ChartProOptions

    adapter.mount(options)
    expect(adapter.getSymbol()).toEqual({ ticker: 'BTCUSDT' })
    expect(adapter.getPeriod()).toEqual({
      multiplier: 15,
      timespan: 'minute',
      text: '15m',
    })
    adapter.setTheme('light')
    adapter.setTimezone('UTC')
    adapter.setSymbol({ ticker: 'ETHUSDT' } satisfies SymbolInfo)
    adapter.setPeriod({
      multiplier: 1,
      timespan: 'hour',
      text: '1h',
    } satisfies Period)

    expect(factory).toHaveBeenCalledOnce()
    expect(chart.setTheme).toHaveBeenCalledWith('light')
    expect(chart.setTimezone).toHaveBeenCalledWith('UTC')
    expect(chart.setSymbol).toHaveBeenCalledWith({ ticker: 'ETHUSDT' })
    expect(chart.setPeriod).toHaveBeenCalledWith({
      multiplier: 1,
      timespan: 'hour',
      text: '1h',
    })
    expect(() => adapter.mount(options)).toThrow('already mounted')
  })

  it('replaces the complete chart dataset on an explicit reload', async () => {
    const candles = [
      { timestamp: 60_000, open: 1, high: 2, low: 0.5, close: 1.5 },
    ]
    const datafeed = {
      getHistoryKLineData: vi.fn(async () => candles),
      searchSymbols: vi.fn(async () => []),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    }
    const coreChart = {
      applyNewData: vi.fn(),
      createOverlay: vi.fn(),
      removeOverlay: vi.fn(),
    } as unknown as Chart
    const adapter = new ProChartAdapter(() => fakeChart(coreChart))
    adapter.mount({
      container: document.createElement('div'),
      datafeed,
      period: { multiplier: 1, timespan: 'minute', text: '1m' },
      symbol: { ticker: 'BTCUSDT' },
    })

    await adapter.reloadData()

    expect(datafeed.getHistoryKLineData).toHaveBeenCalledWith(
      { ticker: 'BTCUSDT' },
      { multiplier: 15, timespan: 'minute', text: '15m' },
      Number.MIN_SAFE_INTEGER,
      expect.any(Number),
      true,
      expect.any(AbortSignal),
    )
    expect(coreChart.applyNewData).toHaveBeenCalledWith(candles, true)
  })

  it('reports the rightmost visible candle and retains later candles when jumping to a requested time', async () => {
    const target = 1_800_000
    const candles = [
      { timestamp: 900_000, open: 1, high: 2, low: 0.5, close: 1.5 },
      { timestamp: target, open: 2, high: 3, low: 1.5, close: 2.5 },
      { timestamp: 2_700_000, open: 3, high: 4, low: 2.5, close: 3.5 },
    ]
    let onDataReady: (() => void) | undefined
    let currentData = [{ timestamp: 0 }, { timestamp: 60_000 }, { timestamp: 120_000 }]
    const applyNewData = vi.fn((rows) => { currentData = rows; onDataReady?.() })
    const coreChart = {
      getDataList: vi.fn(() => currentData),
      getVisibleRange: vi.fn(() => ({
        from: 0,
        to: 1.8,
        realFrom: 0,
        realTo: 1.8,
      })),
      applyNewData,
      subscribeAction: vi.fn((_type, callback) => { onDataReady = callback }),
      unsubscribeAction: vi.fn(() => { onDataReady = undefined }),
      scrollToTimestamp: vi.fn(),
      getBarSpace: vi.fn(() => 10),
      scrollByDistance: vi.fn(),
      createOverlay: vi.fn(),
      removeOverlay: vi.fn(),
    } as unknown as Chart
    const datafeed = {
      getHistoryKLineData: vi.fn(async (
        _symbol: SymbolInfo,
        _period: Period,
        _from: number,
        _to: number,
      ) => candles),
      searchSymbols: vi.fn(async () => []),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    }
    const adapter = new ProChartAdapter(() => fakeChart(coreChart))
    adapter.mount({
      container: document.createElement('div'),
      datafeed,
      period: { multiplier: 15, timespan: 'minute', text: '15m' },
      symbol: { ticker: 'BTCUSDT' },
    })

    expect(adapter.getRightmostVisibleCandleTime()).toBe(60_000)
    await expect(adapter.jumpToTime(target)).resolves.toBe(target)
    const historyCall = vi.mocked(datafeed.getHistoryKLineData).mock.calls[0]
    expect(historyCall[2]).toBeLessThan(target)
    expect(historyCall[3]).toBeGreaterThan(target)
    expect(applyNewData).toHaveBeenCalledWith(
      candles,
      true,
    )
    expect(coreChart.subscribeAction).toHaveBeenCalledWith('onDataReady', expect.any(Function))
    expect(coreChart.unsubscribeAction).toHaveBeenCalledWith('onDataReady', expect.any(Function))
    expect(coreChart.scrollToTimestamp).toHaveBeenCalledWith(target, 0)
    expect(coreChart.scrollByDistance).toHaveBeenCalledWith(10, 0)
  })

  it('captures and restores indicator selection, parameters, styles, and pane height', () => {
    const indicators = new Map([
      [
        'candle_pane',
        new Map([
          [
            'MA',
            {
              name: 'MA',
              calcParams: [7, 25, 99],
              visible: true,
              styles: { lines: [{ color: '#f00' }] },
            },
          ],
        ]),
      ],
      [
        'indicator_pane_1',
        new Map([
          [
            'RSI',
            {
              name: 'RSI',
              calcParams: [6, 12, 24],
              visible: false,
              styles: { lines: [{ color: '#0f0' }] },
            },
          ],
        ]),
      ],
    ])
    const coreChart = {
      getIndicatorByPaneId: vi.fn(() => indicators),
      getSize: vi.fn((paneId: string) =>
        paneId === 'indicator_pane_1' ? { height: 160 } : { height: 400 },
      ),
      overrideIndicator: vi.fn(),
      setPaneOptions: vi.fn(),
      createOverlay: vi.fn(),
      removeOverlay: vi.fn(),
    } as unknown as Chart
    const adapter = new ProChartAdapter(() => fakeChart(coreChart))
    adapter.mount({
      container: document.createElement('div'),
      datafeed: {
        getHistoryKLineData: vi.fn(async () => []),
        searchSymbols: vi.fn(async () => []),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
      },
      period: { multiplier: 1, timespan: 'minute', text: '1m' },
      symbol: { ticker: 'BTCUSDT' },
    })

    const preferences = adapter.getIndicatorPreferences()
    expect(preferences).toEqual({
      schemaVersion: 1,
      main: [
        {
          name: 'MA',
          calcParams: [7, 25, 99],
          visible: true,
          styles: { lines: [{ color: '#f00' }] },
        },
      ],
      sub: [
        {
          height: 160,
          indicators: [
            {
              name: 'RSI',
              calcParams: [6, 12, 24],
              visible: false,
              styles: { lines: [{ color: '#0f0' }] },
            },
          ],
        },
      ],
    })

    adapter.applyIndicatorPreferences(preferences)

    expect(coreChart.overrideIndicator).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'MA',
        calcParams: [7, 25, 99],
        visible: true,
      }),
      'candle_pane',
    )
    expect(coreChart.overrideIndicator).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'RSI',
        calcParams: [6, 12, 24],
        visible: false,
      }),
      'indicator_pane_1',
    )
    expect(coreChart.setPaneOptions).toHaveBeenCalledWith({
      id: 'indicator_pane_1',
      height: 160,
    })
  })

  it('renders simulation lines and trade annotations through core overlays', () => {
    const coreChart = {
      createOverlay: vi.fn(),
      removeOverlay: vi.fn(),
    } as unknown as Chart
    const chart = fakeChart(coreChart)
    const adapter = new ProChartAdapter(() => chart)
    adapter.mount({
      container: document.createElement('div'),
      datafeed: {
        getHistoryKLineData: vi.fn(async () => []),
        searchSymbols: vi.fn(async () => []),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
      },
      period: { multiplier: 1, timespan: 'minute', text: '1m' },
      symbol: { ticker: 'BTCUSDT' },
    })

    adapter.setSimulationOverlays({
      currentTime: 60_000,
      positions: [{ side: 'long', entryPrice: 100, takeProfitPrice: 110, stopLossPrice: 90, liquidationPrice: 80 }],
      trades: [
        {
          id: 'trade-1',
          timestamp: 60_000,
          price: 100,
          label: '开多 1 @ 100',
          tooltip: '时间 · 多仓 · 开仓 · 手续费 0.04',
          color: '#00ff00',
        },
      ],
    })

    expect(coreChart.removeOverlay).toHaveBeenCalledWith({
      groupId: 'simulation',
    })
    expect(coreChart.createOverlay).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'simulation-long-entry',
          name: 'simulationPriceLine',
          extendData: '多仓开仓均价',
        }),
        expect.objectContaining({
          id: 'simulation-trade-trade-1',
          name: 'simpleAnnotation',
        }),
      ]),
      'candle_pane',
    )
    const createdOverlays = vi.mocked(coreChart.createOverlay).mock
      .calls[0][0]
    if (!Array.isArray(createdOverlays)) {
      throw new Error('Expected an overlay array')
    }
    const tradeOverlay = createdOverlays.find(
      (overlay) =>
        typeof overlay !== 'string' &&
        overlay.id === 'simulation-trade-trade-1',
    )
    if (typeof tradeOverlay === 'string' || tradeOverlay === undefined) {
      throw new Error('Expected trade overlay')
    }
    tradeOverlay.onMouseEnter?.({
      overlay: {} as never,
      pageX: 100,
      pageY: 100,
    })
    expect(document.querySelector('[role="tooltip"]')).toHaveTextContent(
      '手续费 0.04',
    )
    tradeOverlay.onMouseLeave?.({ overlay: {} as never })
    expect(document.querySelector('[role="tooltip"]')).not.toBeVisible()
  })

  it('turns position and risk lines into draggable price controls', () => {
    const coreChart = {
      createOverlay: vi.fn(),
      removeOverlay: vi.fn(),
    } as unknown as Chart
    const adapter = new ProChartAdapter(() => fakeChart(coreChart))
    adapter.mount({
      container: document.createElement('div'),
      datafeed: {
        getHistoryKLineData: vi.fn(async () => []),
        searchSymbols: vi.fn(async () => []),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
      },
      period: { multiplier: 1, timespan: 'minute', text: '1m' },
      symbol: { ticker: 'BTCUSDT' },
    })
    const onShortStopLossDrag = vi.fn()
    const onEntryPriceDrag = vi.fn()
    const onTakeProfitPriceDrag = vi.fn()
    const onStopLossPriceDrag = vi.fn()

    adapter.setSimulationOverlays({
      currentTime: 60_000,
      positions: [
        { side: 'long', entryPrice: 100, takeProfitPrice: 110, stopLossPrice: 90, liquidationPrice: 80, onEntryPriceDrag, onTakeProfitPriceDrag, onStopLossPriceDrag },
        { side: 'short', entryPrice: 100, takeProfitPrice: 85, stopLossPrice: 115, liquidationPrice: 125, onStopLossPriceDrag: onShortStopLossDrag },
      ],
      trades: [],
    })

    const overlays = vi.mocked(coreChart.createOverlay).mock.calls[0][0]
    if (!Array.isArray(overlays)) throw new Error('Expected overlay array')
    const entry = overlays.find(
      (overlay) =>
        typeof overlay !== 'string' && overlay.id === 'simulation-long-entry',
    )
    const takeProfit = overlays.find(
      (overlay) =>
        typeof overlay !== 'string' &&
        overlay.id === 'simulation-long-take-profit',
    )
    const stopLoss = overlays.find(
      (overlay) =>
        typeof overlay !== 'string' &&
        overlay.id === 'simulation-long-stop-loss',
    )
    if (
      entry === undefined ||
      takeProfit === undefined ||
      stopLoss === undefined ||
      typeof entry === 'string' ||
      typeof takeProfit === 'string' ||
      typeof stopLoss === 'string'
    ) {
      throw new Error('Expected draggable price overlays')
    }
    expect(entry.lock).toBe(false)
    expect(takeProfit.lock).toBe(false)
    expect(stopLoss.lock).toBe(false)

    entry.onPressedMoveEnd?.({
      overlay: { points: [{ value: 105 }] },
    } as never)
    takeProfit.onPressedMoveEnd?.({
      overlay: { points: [{ value: 115 }] },
    } as never)
    stopLoss.onPressedMoveEnd?.({
      overlay: { points: [{ value: 85 }] },
    } as never)

    expect(onEntryPriceDrag).toHaveBeenCalledWith(105)
    expect(onTakeProfitPriceDrag).toHaveBeenCalledWith(115)
    expect(onStopLossPriceDrag).toHaveBeenCalledWith(85)
    const shortStop = overlays.find(overlay => typeof overlay !== 'string' && overlay.id === 'simulation-short-stop-loss')
    if (typeof shortStop !== 'object' || shortStop === null) throw new Error('Expected short stop overlay')
    shortStop.onPressedMoveEnd?.({ overlay: { points: [{ value: 116 }] } } as never)
    expect(onShortStopLossDrag).toHaveBeenCalledWith(116)
    expect(onStopLossPriceDrag).toHaveBeenCalledTimes(1)
    expect(overlays).toHaveLength(9)
    expect(new Set(overlays.map(overlay => typeof overlay === 'string' ? overlay : overlay.id)).size).toBe(9)
  })
})
