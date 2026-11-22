import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { BYBIT_DAY_MS, BYBIT_HOUR_MS, type BybitTrade } from '../market-data/bybit/trades'
import { tradeBubbles } from './order-flow-bars'
import { ReplayOrderFlow } from './order-flow-replay'

it('预读整份 UTC 日档，K 线内逐步揭示成交时直接查已算好的气泡与累计成交量', async () => {
  const day = Date.UTC(2026, 10, 20)
  const start = day * 1000
  const trade = (id: string, offset: number, size: number): BybitTrade =>
    ({ id, timeUs: start + offset, size, price: 100, side: 'buy' })
  const source = {
    downloadAnchorUs: (day + 14 * BYBIT_HOUR_MS + 20 * 60_000) * 1000,
    hasArchivedDay: vi.fn().mockResolvedValue(true),
    readArchivedHour: vi.fn(async (hour: number) => {
      if (hour === day) return [trade('small', 1000, 2), trade('first', 1100, 5), trade('next', 2000, 6)]
      if (hour === day + 22 * BYBIT_HOUR_MS) return [trade('later', 22 * BYBIT_HOUR_MS * 1000, 7)]
      return []
    }),
    readSocketTrades: vi.fn().mockReturnValue([]),
    capturedFromUs: Infinity,
    capturedUntilUs: 0,
  }
  const flow = new ReplayOrderFlow('test-replay-flow', 300)
  const update = vi.fn()
  const prepare = () => flow.prepare([day], source, new AbortController().signal, update)
  await prepare()
  expect(source.readArchivedHour).toHaveBeenCalledTimes(24)
  expect(source.readArchivedHour.mock.calls.map(([hour]) => (hour - day) / BYBIT_HOUR_MS)).toEqual([
    14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 15, 16, 17, 18, 19, 20, 21, 22, 23,
  ])
  expect(update.mock.calls[0]).toEqual([{ fromUs: (day + 14 * BYBIT_HOUR_MS) * 1000, untilUs: (day + 15 * BYBIT_HOUR_MS) * 1000 }])
  expect(update).toHaveBeenCalledTimes(48)
  const view = (cursor: number) => {
    const bar = flow.read(day, start + cursor, source)
    return [bar.volume, [...tradeBubbles(bar)].map(point => point.trade.id)]
  }
  expect(view(1000)).toEqual([0, []])
  expect(view(2000)).toEqual([7, ['first']])
  expect(view(3000)).toEqual([13, ['first', 'next']])
  expect(view(2000)).toEqual([7, ['first']])
  expect(view(BYBIT_DAY_MS * 1000)).toEqual([20, ['first', 'next', 'later']])
  await prepare()
  expect(source.readArchivedHour).toHaveBeenCalledTimes(24)
  expect(source.readSocketTrades).not.toHaveBeenCalled()

  const migrated = new ReplayOrderFlow('test-period-independent-flow', 300, [flow.key])
  await migrated.prepare([day], source, new AbortController().signal, update)
  expect(source.readArchivedHour).toHaveBeenCalledTimes(24)
  expect([...tradeBubbles(migrated.read(day, start + 2000, source))].map(point => point.trade.id)).toEqual(['first'])
})
