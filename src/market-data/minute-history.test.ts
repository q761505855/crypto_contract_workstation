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
function setup(month: MarketCandle[] | null = candles()) {
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
    loadMonth: vi.fn(async (): Promise<{tradeCandles:MarketCandle[];markCandles:MarketCandle[]}|null> => null),
    saveMonth: vi.fn(async (..._args: unknown[]) => {}), canWrite: () => true,
  }
  const service = new MarketDataService(rest as unknown as BinanceRestClient, store, { archives, cloud, now: () => now })
  return { store, archives, rest, cloud, service }
}

describe('canonical minute history', () => {
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
    await replay.getHistoryKLineData({ticker:'BTCUSDT'},{text:'1w',multiplier:1,timespan:'week'},Date.UTC(2019,0,1),currentTime)
    expect(archives.loadMonth.mock.calls.length).toBeGreaterThan(0)
    expect(archives.loadMonth.mock.calls.every(call=>Date.UTC(call[2],call[3]-1)>=Date.UTC(2025,7,1))).toBe(true)
  })
  it('does not rewrite unchanged trade minutes when fetching the other cloud price kind', async () => {
    const {service,store,cloud} = setup()
    cloud.loadMonth.mockResolvedValue({tradeCandles:candles(),markCandles:[]})
    const put = vi.spyOn(store,'putCandles')
    await service.loadCandles('trade','BTCUSDT','1m',start,start)
    service.resetReplayRequests()
    await service.loadCandles('mark','BTCUSDT','1m',start,start)
    expect(put.mock.calls.filter(([kind,rows]) => kind==='trade' && rows.length>0)).toHaveLength(1)
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
    await store.deleteSeries('mark','BTCUSDT','1m')
    await service.loadCandles('trade','BTCUSDT','1m',start,start)
    expect(archives.loadMonth).toHaveBeenCalledTimes(2)
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

  it('prepares both price types for the entire expanded month and uploads the cache', async () => {
    const { service, cloud, archives } = setup()
    const range = await service.prepareHistory('BTCUSDT', start + 12 * 86_400_000, start + 13 * 86_400_000)
    expect(range).toEqual({ from: start, to: end })
    expect(archives.loadMonth.mock.calls.map((call) => call[0])).toEqual(['trade', 'mark'])
    await service.retryPendingUploads()
    expect(cloud.saveMonth).toHaveBeenCalled()
    const uploaded = cloud.saveMonth.mock.calls.at(-1)!
    expect(uploaded[3]).toHaveLength(43_200)
    expect(uploaded[4]).toHaveLength(43_200)
  })

  it('uses cloud minutes before Binance, including the other price type', async () => {
    const { service, cloud, archives, rest } = setup()
    cloud.loadMonth.mockResolvedValue({ tradeCandles: candles(), markCandles: candles() } as never)
    await service.loadCandles('trade', 'BTCUSDT', '1h', start, start)
    await service.loadCandles('mark', 'BTCUSDT', '1m', start, start)
    expect(cloud.loadMonth).toHaveBeenCalledOnce()
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
    expect(archives.loadDay).toHaveBeenCalled()
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
