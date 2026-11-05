import { describe, expect, it } from 'vitest'
import { expandHistoryRange, historyMonths } from './history-ranges'

const minute = 60_000
const now = Date.UTC(2026, 10, 5, 10, 20, 35)

describe('history range expansion', () => {
  it('expands a short historical request to a full UTC natural month', () => {
    expect(expandHistoryRange(Date.UTC(2025, 8, 12), Date.UTC(2025, 8, 14), now)).toEqual({
      from: Date.UTC(2025, 8, 1), to: Date.UTC(2025, 9, 1) - minute,
    })
  })

  it('expands across year and leap-month boundaries', () => {
    expect(expandHistoryRange(Date.UTC(2023, 11, 31), Date.UTC(2024, 1, 2), now)).toEqual({
      from: Date.UTC(2023, 11, 1), to: Date.UTC(2024, 2, 1) - minute,
    })
  })

  it('clamps the current or future end to the last fully closed minute', () => {
    expect(expandHistoryRange(Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 10), now)).toEqual({
      from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 5, 10, 19),
    })
    expect(expandHistoryRange(Date.UTC(2026, 10, 1), now, now - 35_000).to).toBe(Date.UTC(2026, 10, 5, 10, 19))
  })

  it('uses the first whole minute after listing, including a listing across month end', () => {
    expect(expandHistoryRange(Date.UTC(2025, 8, 12), Date.UTC(2025, 9, 1), now, Date.UTC(2025, 8, 20, 0, 0, 1))).toEqual({
      from: Date.UTC(2025, 8, 20, 0, 1), to: Date.UTC(2025, 10, 1) - minute,
    })
    expect(expandHistoryRange(Date.UTC(2025, 8, 12), Date.UTC(2025, 9, 1), now, Date.UTC(2025, 8, 30, 23, 59, 1)).from).toBe(Date.UTC(2025, 9, 1))
  })

  it.each([
    [NaN, 1, now, 0], [0, Infinity, now, 0], [2, 1, now, 0],
    [-1, 1, now, 0], [0, 1, NaN, 0], [0, 1, now, -1],
    [Date.UTC(2027, 0, 1), Date.UTC(2027, 0, 2), now, 0],
    [0, 1, now, now],
  ])('rejects invalid or wholly unavailable range (%s, %s)', (from, to, time, listing) => {
    expect(() => expandHistoryRange(from, to, time, listing)).toThrow()
  })
})

describe('UTC month slices', () => {
  it('returns clipped inclusive minute-open ranges, including December to January', () => {
    expect(historyMonths(Date.UTC(2025, 11, 31, 23, 58, 1), Date.UTC(2026, 0, 1, 0, 2, 59))).toEqual([
      { year: 2025, month: 12, from: Date.UTC(2025, 11, 31, 23, 59), to: Date.UTC(2025, 11, 31, 23, 59) },
      { year: 2026, month: 1, from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 1, 0, 2) },
    ])
  })

  it('does not invent a minute when both bounds are inside the same minute', () => {
    expect(historyMonths(1, 59_999)).toEqual([])
  })

  it('includes an end exactly at the next month open in that month', () => {
    expect(historyMonths(Date.UTC(2024, 1, 29, 23, 59), Date.UTC(2024, 2, 1))).toEqual([
      { year: 2024, month: 2, from: Date.UTC(2024, 1, 29, 23, 59), to: Date.UTC(2024, 1, 29, 23, 59) },
      { year: 2024, month: 3, from: Date.UTC(2024, 2, 1), to: Date.UTC(2024, 2, 1) },
    ])
  })

  it('rejects reversed, negative and invalid dates', () => {
    expect(() => historyMonths(1, 0)).toThrow()
    expect(() => historyMonths(-1, 0)).toThrow()
    expect(() => historyMonths(0, NaN)).toThrow()
    expect(() => historyMonths(0, 9e15)).toThrow()
  })
})
