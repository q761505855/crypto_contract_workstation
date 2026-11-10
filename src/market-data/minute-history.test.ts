import { describe, expect, it, vi } from 'vitest'
import type { MarketDataStore } from '../storage/market-data-store'
import { MarketDataService } from './market-data-service'
import type { BinanceRestClient } from './rest-client'
import type { CandleKind, MarketCandle } from './models'
import { findMissingRanges } from './gaps'
import { ReplayDatafeed } from '../replay/replay-datafeed'
import type { Datafeed } from '@klinecharts/pro'

const minute = 60_000
const start = Date.UTC(2025, 8, 1)
const end = Date.UTC(2025, 9, 1) - minute
const now = Date.UTC(2026, 10, 5, 12)
function candles(from = start, to = end): MarketCandle[] {
  return Array.from({ length: Math.max(0, (to - from) / minute + 1) }, (_, i) => ({
    symbol: 'BTCUSDT', timeframe: '1m', openTime: from + i * minute,
    closeTime: from + (i + 1) * minute - 1, open: '100', high: '110', low: '90', close: '101',
    volume: '0.1', quoteVolume: '10.1', tradeCount: 1, isClosed: true, source: 'binance',
  }))
}
function setup(month: MarketCandle[] | null = candles(), clock = () => now) {
  const rows: Record<CandleKind, Map<string, MarketCandle>> = { trade: new Map(), mark: new Map() }
  const store: MarketDataStore = {
    putSymbols: async () => {}, getSymbols: async () => [],
    putCandles: async (kind, candles) => { for (const row of candles) rows[kind].set(`${row.symbol}/${row.timeframe}/${row.openTime}`, row) },
    getCandles: async (kind, symbol, timeframe, from, to) => [...rows[kind].values()].filter(row => row.symbol === symbol && row.timeframe === timeframe && row.openTime >= from && row.openTime <= to).sort((a,b) => a.openTime-b.openTime),
    getSeriesSummary: async (kind, symbol, timeframe) => {
      const list = await store.getCandles(kind, symbol, timeframe, 0, Number.MAX_SAFE_INTEGER)
      return { count:list.length, firstOpenTime:list[0]?.openTime ?? null, lastOpenTime:list.at(-1)?.openTime ?? null,
        gaps:list.length ? findMissingRanges(list, timeframe, list[0].openTime, list.at(-1)!.openTime) : [] }
    },
    deleteSeries: async (kind, symbol, timeframe) => { for (const [key,row] of rows[kind]) if(row.symbol===symbol && row.timeframe===timeframe) rows[kind].delete(key) },
  }
  const archives = { loadMonth: vi.fn(async (_kind: CandleKind, _symbol: string, _year: number, _month: number, _options?: unknown) => month), loadDay: vi.fn(async () => null) }
  const rest = { downloadRange: vi.fn(async (..._args: unknown[]): Promise<MarketCandle[]> => []) }
  const cloud = {
    loadMonth: vi.fn(async (): Promise<{tradeCandles:MarketCandle[];markCandles?:MarketCandle[]}|null> => null),
    saveMonth: vi.fn(async (..._args: unknown[]) => {}), canWrite: () => true,
  }
  const service = new MarketDataService(rest as unknown as BinanceRestClient, store, { archives, cloud, now: clock })
  return { store, archives, rest, cloud, service }
}

describe('canonical minute history', () => {
  it('stops a cancelled archive before writing a retired month after an overlapping cache read', async () => {
    const { service, store, archives, cloud } = setup()
    const controller = new AbortController()
    const read = store.getCandles.bind(store)
    const put = vi.spyOn(store, 'putCandles')
    vi.spyOn(store, 'getCandles').mockImplementation(async (...args) => {
      if (archives.loadMonth.mock.calls.length > 0 && args[3] === start && args[4] === end) controller.abort()
      return read(...args)
    })
    await expect(service.loadCandles('trade', 'BTCUSDT', '1m', start, start, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(put).not.toHaveBeenCalled()
    expect(cloud.saveMonth).not.toHaveBeenCalled()
  })

  it('does not turn an aborted replay preparation into a permanent failure for the next navigation', async () => {
    const { service, archives } = setup()
    const controller = new AbortController()
    archives.loadMonth.mockImplementationOnce(async () => { controller.abort(); throw new DOMException('retired', 'AbortError') })
    const warn = vi.fn()
    await expect(service.loadReplayCandles('trade', 'BTCUSDT', '1m', start, start, { signal: controller.signal, onWarning: warn })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(service.loadReplayCandles('trade', 'BTCUSDT', '1m', start, start)).resolves.toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
    expect(archives.loadMonth).toHaveBeenCalledTimes(2)
  })
  it('prepares replay through one monthly lookup rather than 499-bar requests', async () => {
    const {service,cloud,archives,rest} = setup(null)
    cloud.loadMonth.mockResolvedValue({tradeCandles:candles(),markCandles:candles()})
    const load = vi.spyOn(service,'loadCandles')
    const to = start + 20 * 86_400_000
    const result = await service.loadReplayCandles('trade','BTCUSDT','15m',start,to,{prefetchTo:to})
    expect(result).toHaveLength(20*96+1)
    expect(load).toHaveBeenCalledOnce()
    expect(cloud.loadMonth).toHaveBeenCalledOnce()
    expect(archives.loadMonth).not.toHaveBeenCalled()
    expect(archives.loadDay).not.toHaveBeenCalled()
    expect(rest.downloadRange).not.toHaveBeenCalled()
  })

  it('keeps recent Git month lookups when a new replay resets its batch state', async () => {
    const {service,cloud} = setup(null)
    await expect(service.loadCandles('trade','BTCUSDT','1m',start,start)).rejects.toThrow()
    service.resetReplayRequests()
    await expect(service.loadCandles('trade','BTCUSDT','1m',start,start)).rejects.toThrow()
    expect(cloud.loadMonth).toHaveBeenCalledOnce()
  })

  it('deduplicates known missing month and daily archives across repeated gap reads', async () => {
    const {service,archives} = setup(null)
    for (let i=0;i<2;i++) await expect(service.loadCandles('trade','BTCUSDT','1m',start,start)).rejects.toThrow()
    expect(archives.loadMonth).toHaveBeenCalledOnce()
    expect(archives.loadDay).toHaveBeenCalledOnce()
  })

  it('rechecks missing archives after the short absence cache expires', async () => {
    let time = now
    const {service,archives} = setup(null,()=>time)
    await expect(service.loadCandles('trade','BTCUSDT','1m',start,start)).rejects.toThrow()
    time += 60_001
    await expect(service.loadCandles('trade','BTCUSDT','1m',start,start)).rejects.toThrow()
    expect(archives.loadMonth).toHaveBeenCalledTimes(2)
    expect(archives.loadDay).toHaveBeenCalledTimes(2)
  })

  it('does not cache network failures as missing archives', async () => {
    const {service,archives} = setup(null)
    archives.loadMonth.mockRejectedValueOnce(new Error('network offline'))
    await expect(service.loadCandles('trade','BTCUSDT','1m',start,start)).rejects.toThrow('network offline')
    await expect(service.loadCandles('trade','BTCUSDT','1m',start,start)).rejects.toThrow(/归档/)
    expect(archives.loadMonth).toHaveBeenCalledTimes(2)
  })

  it('repairs a recent gap in a Git month through minute API and reuploads the merged month', async () => {
    const {service,cloud,rest} = setup(null)
    const gap = Date.UTC(2026,9,28)
    const before = candles(gap-minute,gap-minute)
    cloud.loadMonth.mockResolvedValue({tradeCandles:before,markCandles:[]})
    rest.downloadRange.mockResolvedValue(candles(gap,gap+4*minute))
    const result = await service.loadCandles('trade','BTCUSDT','1m',gap,gap+4*minute)
    expect(result).toHaveLength(5)
    expect(rest.downloadRange).toHaveBeenCalledWith('trade','BTCUSDT','1m',gap,gap+4*minute,expect.any(Object))
    await service.retryPendingUploads()
    expect(cloud.saveMonth.mock.calls.at(-1)?.slice(0,3)).toEqual(['BTCUSDT',2026,10])
    expect(cloud.saveMonth.mock.calls.at(-1)?.[3]).toEqual([...before,...candles(gap,gap+4*minute)])
  })

  it('keeps dates beyond the recent 30-day window out of REST', async () => {
    const {service,rest} = setup(null)
    const old = Date.UTC(2026,9,5)
    await expect(service.loadCandles('trade','BTCUSDT','1m',old,old)).rejects.toThrow()
    expect(rest.downloadRange).not.toHaveBeenCalled()
  })

  it('returns complete cached history without waiting behind an unrelated month download', async () => {
    const {service,archives} = setup()
    await service.loadCandles('trade','BTCUSDT','1m',start,start)
    let release!: (value: MarketCandle[]) => void
    archives.loadMonth.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const october = Date.UTC(2025,9,1)
    const pending = service.loadCandles('trade','BTCUSDT','1m',october,october)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    let cached: MarketCandle[] | undefined
    const hit = service.loadCandles('trade','BTCUSDT','1h',start,start).then(rows => { cached = rows })
    try {
      await vi.waitFor(() => expect(cached).toHaveLength(1), {timeout:300})
      expect(cached![0]).toMatchObject({openTime:start,timeframe:'1h',isClosed:true})
    } finally {
      release(candles(october,october))
      await Promise.all([pending,hit])
    }
  })

  it('bounds replay chart period switches instead of silently preparing years of minutes', async () => {
    const {service,archives} = setup()
    await service.loadCandles('trade','BTCUSDT','1m',start,start)
    archives.loadMonth.mockClear()
    const replay = new ReplayDatafeed({} as Datafeed, service)
    const currentTime = Date.UTC(2025,8,15)
    replay.setReplayContext({sessionId:'bounded-replay',symbol:'BTCUSDT',timeframe:'1m',currentTime,endTime:end})
    await replay.getHistoryKLineData({ticker:'BTCUSDT'},{text:'1d',multiplier:1,timespan:'day'},Date.UTC(2019,0,1),currentTime)
    expect(archives.loadMonth.mock.calls.length).toBeGreaterThan(0)
    expect(archives.loadMonth.mock.calls.every(call=>Date.UTC(call[2],call[3]-1)>=Date.UTC(2025,7,1))).toBe(true)
  })

  it.each([
    ['3d', Date.UTC(2025, 8, 1), Date.UTC(2025, 8, 4)],
    ['1w', Date.UTC(2025, 8, 1), Date.UTC(2025, 8, 8)],
    ['1M', Date.UTC(2025, 8, 1), Date.UTC(2025, 9, 1)],
  ])('loads and reuses native %s bars without reading or uploading minute archives', async (timeframe, from, end) => {
    const { service, rest, archives, cloud } = setup(null)
    const row = { ...candles(from, from)[0], timeframe, closeTime: end - 1 }
    rest.downloadRange.mockResolvedValue([row])
    await expect(service.loadReplayCandles('trade', 'BTCUSDT', timeframe, from, from)).resolves.toEqual([row])
    await expect(service.loadCandles('trade', 'BTCUSDT', timeframe, from, from)).resolves.toEqual([row])
    expect(rest.downloadRange).toHaveBeenCalledExactlyOnceWith('trade', 'BTCUSDT', timeframe, from, from, expect.any(Object))
    expect(archives.loadMonth).not.toHaveBeenCalled()
    expect(cloud.loadMonth).not.toHaveBeenCalled()
    expect(cloud.saveMonth).not.toHaveBeenCalled()
  })
  it('only writes missing ordinary minutes when cloud data overlaps the local cache', async () => {
    const {service,store,cloud} = setup()
    await store.putCandles('trade', candles(start + minute, end))
    cloud.loadMonth.mockResolvedValue({tradeCandles:candles(),markCandles:[]})
    const put = vi.spyOn(store,'putCandles')
    await service.loadCandles('trade','BTCUSDT','1m',start,start)
    expect(put.mock.calls.filter(([kind,rows]) => kind==='trade' && rows.length>0)).toHaveLength(1)
    expect(put.mock.calls[0][1]).toEqual(candles(start, start))
  })
  it('builds a replay partial bar from revealed minutes despite a full future month in cache', async () => {
    const month = candles()
    month[2] = {...month[2], high:'9999',close:'9999'}
    const {service} = setup(month)
    await service.loadCandles('trade','BTCUSDT','1m',start,start)
    const replay = new ReplayDatafeed({} as Datafeed, service)
    replay.setReplayContext({sessionId:'replay',symbol:'BTCUSDT',timeframe:'1m',currentTime:start+minute,endTime:end})
    const rows = await replay.getHistoryKLineData({ticker:'BTCUSDT'},{text:'5m',multiplier:5,timespan:'minute'},start,start)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({high:110, close:101,volume:0.2})
  })
  it('reads a newly uploaded month from cloud after local cache deletion', async () => {
    const {service,store,cloud,archives} = setup()
    await service.prepareHistory('BTCUSDT',start,end)
    await service.retryPendingUploads()
    cloud.loadMonth.mockResolvedValue({tradeCandles:candles(),markCandles:candles()})
    await store.deleteSeries('trade','BTCUSDT','1m')
    await service.loadCandles('trade','BTCUSDT','1m',start,start)
    expect(archives.loadMonth).toHaveBeenCalledOnce()
  })
  it('retries a month after an aborted cloud read instead of retaining the rejected promise', async () => {
    const { service, cloud } = setup()
    const controller = new AbortController()
    cloud.loadMonth.mockImplementationOnce(async () => {
      controller.abort()
      throw new DOMException('cancelled', 'AbortError')
    })
    await expect(service.loadCandles('trade', 'BTCUSDT', '1m', start, start, {signal:controller.signal})).rejects.toMatchObject({name:'AbortError'})
    cloud.loadMonth.mockResolvedValue({tradeCandles:candles(), markCandles:[]})
    await expect(service.loadCandles('trade', 'BTCUSDT', '1m', start, start)).resolves.toHaveLength(1)
    expect(cloud.loadMonth).toHaveBeenCalledTimes(2)
  })

  it('completes local preparation while a background upload is still pending', async () => {
    const { service, cloud } = setup()
    let release!: () => void
    cloud.saveMonth.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    let prepared = false
    const task = service.prepareHistory('BTCUSDT', start, end).then(() => { prepared = true })
    try {
      await vi.waitFor(() => expect(prepared).toBe(true))
      expect(service.getPendingUploadCount()).toBe(1)
    } finally {
      cloud.saveMonth.mockResolvedValue(undefined)
      release?.()
      await task
      await service.retryPendingUploads()
    }
  })
  it('loads a whole monthly archive once, aggregates chart periods and reuses the cache', async () => {
    const { service, archives, rest } = setup()
    const five = await service.loadCandles('trade', 'BTCUSDT', '5m', start, start + 9 * minute)
    expect(five).toHaveLength(2)
    expect(five[0]).toMatchObject({ timeframe: '5m', volume: '0.5', tradeCount: 5 })
    const one = await service.loadCandles('trade', 'BTCUSDT', '1m', start + 30 * minute, start + 31 * minute)
    expect(one).toHaveLength(2)
    expect(archives.loadMonth).toHaveBeenCalledOnce()
    expect(rest.downloadRange).not.toHaveBeenCalled()
    expect((await service.inspectSeries('trade', 'BTCUSDT', '1m')).count).toBe(43_200)
  })

  it('prepares and uploads only ordinary minutes for the entire expanded month', async () => {
    const { service, store, cloud, archives } = setup()
    await store.putCandles('mark', candles())
    const get = vi.spyOn(store, 'getCandles')
    const put = vi.spyOn(store, 'putCandles')
    const range = await service.prepareHistory('BTCUSDT', start + 12 * 86_400_000, start + 13 * 86_400_000)
    expect(range).toEqual({ from: start, to: end })
    expect(archives.loadMonth.mock.calls.map((call) => call[0])).toEqual(['trade'])
    await service.retryPendingUploads()
    expect(cloud.saveMonth).toHaveBeenCalled()
    const uploaded = cloud.saveMonth.mock.calls.at(-1)!
    expect(uploaded[3]).toHaveLength(43_200)
    expect(uploaded).toHaveLength(5)
    expect(uploaded[4]).toBeUndefined()
    expect(get.mock.calls.every(([kind]) => kind === 'trade')).toBe(true)
    expect(put.mock.calls.every(([kind]) => kind === 'trade')).toBe(true)
  })

  it('uses ordinary cloud minutes before Binance and ignores retired prices', async () => {
    const { service, store, cloud, archives, rest } = setup()
    cloud.loadMonth.mockResolvedValue({ tradeCandles: candles(), markCandles: candles() } as never)
    await service.loadCandles('trade', 'BTCUSDT', '1h', start, start)
    await service.loadCandles('trade', 'BTCUSDT', '1m', start, start)
    expect(cloud.loadMonth).toHaveBeenCalledOnce()
    expect(archives.loadMonth).not.toHaveBeenCalled()
    expect(rest.downloadRange).not.toHaveBeenCalled()
    expect(await store.getCandles('mark', 'BTCUSDT', '1m', start, end)).toHaveLength(0)
  })

  it('rejects retired price requests before reading caches or requesting history', async () => {
    const { service, store, cloud, archives, rest } = setup()
    await store.putCandles('mark', candles(start, start))
    const get = vi.spyOn(store, 'getCandles')
    const put = vi.spyOn(store, 'putCandles')
    await expect(service.loadCandles('mark', 'BTCUSDT', '1m', start, start)).rejects.toThrow(/普通价格/)
    await expect(service.loadCachedCandles('mark', 'BTCUSDT', '1m', start, start)).rejects.toThrow(/普通价格/)
    await expect(service.loadReplayCandles('mark', 'BTCUSDT', '1m', start, start)).rejects.toThrow(/普通价格/)
    await expect(service.refreshCandles('mark', 'BTCUSDT', '1m', start, start)).rejects.toThrow(/普通价格/)
    await expect(service.saveRealtimeCandle('mark', candles(start, start)[0])).rejects.toThrow(/普通价格/)
    expect(get).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
    expect(cloud.loadMonth).not.toHaveBeenCalled()
    expect(archives.loadMonth).not.toHaveBeenCalled()
    expect(rest.downloadRange).not.toHaveBeenCalled()
  })

  it('rejects an incomplete selected range including its tail instead of shortening it', async () => {
    const { service, rest } = setup(candles(start, end - minute))
    await expect(service.prepareHistory('BTCUSDT', start, end)).rejects.toThrow(/缺失|缺口|不完整/)
    expect(rest.downloadRange).not.toHaveBeenCalled()
  })

  it('never sends old missing history to REST when all archives are absent', async () => {
    const { service, archives, rest } = setup(null)
    await expect(service.prepareHistory('BTCUSDT', start, end)).rejects.toThrow(/归档|缺失/)
    expect(archives.loadDay).toHaveBeenCalled()
    expect(rest.downloadRange).not.toHaveBeenCalled()
  })

  it('only falls back to minute REST for recent unarchived data', async () => {
    const { service, archives, rest } = setup(null)
    const from = now - 5 * minute
    rest.downloadRange.mockResolvedValue(candles(from, now - minute) as never)
    const result = await service.loadCandles('trade', 'BTCUSDT', '1m', from, now)
    expect(result).toHaveLength(5)
    expect(archives.loadDay).not.toHaveBeenCalled()
    expect(rest.downloadRange).toHaveBeenCalledWith('trade', 'BTCUSDT', '1m', from, now - minute, expect.any(Object))
  })

  it('retains local data and a retryable pending upload when cloud writes fail', async () => {
    const { service, cloud } = setup()
    cloud.saveMonth.mockRejectedValue(new Error('offline'))
    await service.prepareHistory('BTCUSDT', start, end)
    await service.retryPendingUploads()
    expect(service.getPendingUploadCount()).toBe(1)
    expect((await service.loadCachedCandles('trade', 'BTCUSDT', '1m', start, end))).toHaveLength(43_200)
    cloud.saveMonth.mockResolvedValue(undefined)
    await service.retryPendingUploads()
    expect(service.getPendingUploadCount()).toBe(0)
  })

  it('shares overlapping requests across chart periods without duplicate archive downloads', async () => {
    const { service, archives } = setup()
    await Promise.all([
      service.loadCandles('trade', 'BTCUSDT', '5m', start, start + 5 * minute),
      service.loadCandles('trade', 'BTCUSDT', '15m', start, start),
    ])
    expect(archives.loadMonth).toHaveBeenCalledOnce()
  })
})
