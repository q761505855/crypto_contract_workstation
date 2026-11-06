import { describe, expect, it, vi } from 'vitest'
import type { ChartPro, ChartProOptions, Datafeed, Period, SymbolInfo } from '@klinecharts/pro'
import type { Chart, KLineData } from 'klinecharts'
import { alignOpenTime, nextOpenTime } from '../market-data/intervals'
import { readIndicatorHistory } from '../market-data/indicator-history'
vi.mock('@klinecharts/pro', () => ({ KLineChartPro: vi.fn() }))
import { ProChartAdapter } from './pro-chart-adapter'

const anchor = Date.UTC(2025, 8, 15, 12, 17)
const period = (text: string): Period => ({ text, multiplier: Number.parseInt(text), timespan: text.endsWith('m') ? 'minute' : text.endsWith('h') ? 'hour' : 'day' })
const row = (timestamp: number): KLineData => ({ timestamp, open: 10, high: 12, low: 9, close: 11, volume: 1 })
function fixture() {
  let currentPeriod = period('1m')
  let currentSymbol: SymbolInfo = { ticker: 'BTCUSDT' }
  let liveCallback: ((candle: KLineData) => void) | undefined
  let data = [row(anchor - 60_000), row(anchor), row(anchor + 60_000)]
  let visibleTo = 2
  let wrapped: Datafeed
  let libraryGeneration = 0
  let autoLoad = true
  let context: { currentTime: number; timeframe: string } | null = null
  const actions = new Map<string, Set<() => void>>()
  const core = {
    getDataList: () => data,
    getVisibleRange: () => ({ from: 0, to: visibleTo }),
    subscribeAction: (name: string, callback: () => void) => { const set = actions.get(name) ?? new Set(); set.add(callback); actions.set(name, set) },
    unsubscribeAction: (name: string, callback: () => void) => actions.get(name)?.delete(callback),
    applyNewData: vi.fn((rows: KLineData[]) => { data = rows; visibleTo = data.length; for (const callback of [...actions.get('onDataReady') ?? []]) callback() }),
    getBarSpace: () => 10,
    scrollToTimestamp: vi.fn((timestamp: number) => { visibleTo = data.findIndex(row => row.timestamp === timestamp) + 1 }),
    scrollByDistance: vi.fn(),
  } as unknown as Chart
  const history = vi.fn(async (_symbol: unknown, selected: Period, from: number, to: number, _notifySelection?: boolean, _signal?: AbortSignal): Promise<KLineData[]> => {
    const result: KLineData[] = []
    for (let at = alignOpenTime(from, selected.text, 'ceil'); at <= to; at = nextOpenTime(at, selected.text)) result.push(row(at))
    return result
  })
  const feed = { getHistoryKLineData: history, searchSymbols: async () => [], subscribe: vi.fn((_symbol: SymbolInfo, _period: Period, callback: (candle: KLineData) => void) => { liveCallback = callback }), unsubscribe: vi.fn(), getReplayContext: () => context }
  const cancelHistoryRequests = vi.fn(() => { libraryGeneration++ })
  const chart = {
    getChart: () => core, getPeriod: () => currentPeriod, getSymbol: () => currentSymbol,
    setPeriod: (selected: Period) => {
      currentPeriod = selected
      const generation = ++libraryGeneration
      if (!autoLoad) return
      void wrapped.getHistoryKLineData({ ticker: 'BTCUSDT' }, selected, 0, Date.now()).then(rows => {
        if (generation === libraryGeneration) core.applyNewData(rows, true)
      })
    },
    setSymbol: (symbol: SymbolInfo) => { currentSymbol = symbol }, cancelHistoryRequests,
  } as unknown as ChartPro
  const adapter = new ProChartAdapter((options: ChartProOptions) => { wrapped = options.datafeed; return chart })
  adapter.mount({ container: document.createElement('div'), symbol: { ticker: 'BTCUSDT' }, period: currentPeriod, datafeed: feed })
  return { adapter, history, core, feed, actions, cancelHistoryRequests, emitLive: (candle: KLineData) => liveCallback?.(candle), wrapped: () => wrapped, pauseLibrary: () => { autoLoad = false }, setContext: (next: typeof context) => { context = next }, panTo: (timestamp: number) => { visibleTo = data.findIndex(row => row.timestamp === timestamp) + 1 } }
}

describe('chart viewport navigation', () => {
  it('hides the previous dataset immediately while a replay reset reloads its safe boundary', async () => {
    const { adapter, core, history, setContext } = fixture()
    setContext({ currentTime: anchor, timeframe: '1m' })
    let release!: (rows: KLineData[]) => void
    history.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const loading = adapter.reloadData()
    expect(core.getDataList()).toHaveLength(0)
    release([row(anchor)])
    await loading
    expect(core.getDataList().at(-1)?.timestamp).toBe(anchor)
  })
  it('forwards silent indicator reads without consuming the chart viewport restore', async () => {
    const { adapter, history, pauseLibrary, wrapped } = fixture()
    pauseLibrary()
    adapter.setPeriod(period('1h'))
    await readIndicatorHistory(wrapped(), { ticker: 'BTCUSDT' }, period('1h'), anchor - 1000, anchor)
    expect(history.mock.calls[0].slice(2)).toEqual([anchor - 1000, anchor, false])
    await wrapped().getHistoryKLineData({ ticker: 'BTCUSDT' }, period('1h'), 0, Date.now())
    expect(history.mock.calls[1][2]).toBeGreaterThan(0)
    expect(history.mock.calls[1][3]).toBeLessThan(Date.UTC(2025, 9, 1))
  })

  it('does not leave a pending anchor when reselecting the current period', async () => {
    const { adapter, history, core, panTo } = fixture()
    adapter.setPeriod(period('1m'))
    expect(history).not.toHaveBeenCalled()
    const panned = anchor - 3_600_000
    core.applyNewData([row(panned)], true)
    panTo(panned)
    adapter.setPeriod(period('1h'))
    await vi.waitFor(() => expect(core.scrollToTimestamp).toHaveBeenLastCalledWith(alignOpenTime(panned, '1h', 'floor'), 0))
  })

  it('retains the live websocket candle when minute history ends at the preceding closed candle', async () => {
    const { adapter, core, wrapped, emitLive } = fixture()
    const latest = alignOpenTime(Date.now(), '1m', 'floor')
    wrapped().subscribe({ ticker: 'BTCUSDT' }, period('1m'), candle => core.applyNewData([candle], true))
    emitLive({ ...row(latest), close: 123 })
    await adapter.jumpToTime(Date.now())
    expect(core.getDataList().at(-1)?.close).toBe(123)
    expect(core.scrollToTimestamp).toHaveBeenLastCalledWith(latest, 0)
  })

  it('does not carry a previous instrument websocket bar into the newly selected instrument', async () => {
    const { adapter, core, wrapped, emitLive } = fixture()
    const latest = alignOpenTime(Date.now(), '1m', 'floor')
    wrapped().subscribe({ ticker: 'BTCUSDT' }, period('1m'), candle => core.applyNewData([candle], true))
    emitLive({ ...row(latest), close: 123 })
    adapter.setSymbol({ ticker: 'ETHUSDT' })
    await adapter.jumpToTime(Date.now())
    expect(core.getDataList().some(candle => candle.close === 123)).toBe(false)
  })

  it('rejects an obsolete manual jump as cancellation after a period A to B to A switch', async () => {
    const { adapter, history, core } = fixture()
    let release!: (rows: KLineData[]) => void
    history.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const old = adapter.jumpToTime(anchor)
    const cancelled = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    adapter.setPeriod(period('1h'))
    adapter.setPeriod(period('1m'))
    await vi.waitFor(() => expect(core.scrollToTimestamp).toHaveBeenLastCalledWith(anchor, 0))
    release([row(anchor)])
    await cancelled
  })

  it('anchors the initial new-period request and retains intrabar time across coarse and fine periods', async () => {
    const { adapter, history, core } = fixture()
    adapter.setPeriod(period('1d'))
    await vi.waitFor(() => expect(core.scrollToTimestamp).toHaveBeenLastCalledWith(Date.UTC(2025, 8, 15), 0))
    expect(history).toHaveBeenCalledOnce()
    expect(history.mock.calls[0][3]).toBeLessThan(Date.UTC(2025, 9, 1))
    adapter.setPeriod(period('1m'))
    await vi.waitFor(() => expect(core.scrollToTimestamp).toHaveBeenLastCalledWith(anchor, 0))
    expect(adapter.getRightmostVisibleCandleTime()).toBe(anchor)
  })

  it('uses a new user-panned location instead of an obsolete sticky anchor', async () => {
    const { adapter, core, panTo } = fixture()
    adapter.setPeriod(period('1h'))
    await vi.waitFor(() => expect(core.scrollToTimestamp).toHaveBeenCalledOnce())
    const panned = Date.UTC(2025, 8, 12, 9)
    panTo(panned)
    adapter.setPeriod(period('1m'))
    await vi.waitFor(() => expect(core.scrollToTimestamp).toHaveBeenLastCalledWith(panned, 0))
  })

  it('inherits the original anchor during rapid switches and discards late positioning', async () => {
    const { adapter, history, core, actions } = fixture()
    let release!: (rows: KLineData[]) => void
    history.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    adapter.setPeriod(period('1h'))
    adapter.setPeriod(period('1d'))
    adapter.setPeriod(period('1m'))
    expect(history.mock.calls[0][5]?.aborted).toBe(true)
    expect(history.mock.calls[1][5]?.aborted).toBe(true)
    expect(history.mock.calls[2][5]?.aborted).toBe(false)
    await vi.waitFor(() => expect(core.scrollToTimestamp).toHaveBeenLastCalledWith(anchor, 0))
    release([row(Date.UTC(2025, 8, 15, 12))])
    await Promise.resolve()
    expect(core.scrollToTimestamp).toHaveBeenCalledOnce()
    expect(actions.get('onDataReady')?.size ?? 0).toBe(0)
  })

  it('caps explicit future jumps at the revealed source candle end and invalidates old library loads', async () => {
    const { adapter, history, core, cancelHistoryRequests, setContext } = fixture()
    setContext({ currentTime: Date.UTC(2025, 8, 15, 12), timeframe: '15m' })
    await adapter.jumpToTime(Date.UTC(2026, 10, 5))
    expect(history.mock.calls[0][3]).toBe(Date.UTC(2025, 8, 15, 12, 15) - 1)
    expect(core.scrollToTimestamp).toHaveBeenLastCalledWith(Date.UTC(2025, 8, 15, 12, 14), 0)
    expect(cancelHistoryRequests).toHaveBeenCalledOnce()
  })

  it('lets an explicit jump win over an unfinished period restore without leftover listeners', async () => {
    const { adapter, history, core, actions } = fixture()
    let release!: (rows: KLineData[]) => void
    history.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    adapter.setPeriod(period('1h'))
    const target = Date.UTC(2025, 8, 10, 9)
    await adapter.jumpToTime(target)
    release([row(Date.UTC(2025, 8, 15, 12))])
    await Promise.resolve()
    expect(core.scrollToTimestamp).toHaveBeenLastCalledWith(target, 0)
    expect(core.scrollToTimestamp).toHaveBeenCalledOnce()
    expect(actions.get('onDataReady')?.size ?? 0).toBe(0)
  })
})
