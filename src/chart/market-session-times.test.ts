import type { IndicatorDrawParams } from 'klinecharts'
import { describe, expect, it, vi } from 'vitest'
import { formatDisplayTime } from '../format-display-time'
import { marketSessionForecast, marketSessionWindows, normalizeMarketSessionParams } from './market-session-times'
import { drawMarketSessions } from './market-sessions-indicator'

function windowsOn(date: string) {
  const from = Date.parse(`${date}T00:00Z`)
  return marketSessionWindows(from, from + 86_400_000 - 1)
}

describe('market session windows', () => {
  it.each([
    ['2026-03-06', '08:00', '14:30'],
    ['2026-03-09', '08:00', '13:30'],
    ['2026-03-30', '07:00', '13:30'],
    ['2026-10-23', '07:00', '13:30'],
    ['2026-10-26', '08:00', '13:30'],
    ['2026-11-02', '08:00', '14:30'],
  ])('uses local time zones when daylight saving differs on %s', (date, london, newYork) => {
    const windows = windowsOn(date)
    for (const [market, open] of [['tokyo', '00:00'], ['london', london], ['newYork', newYork]]) {
      const end = Date.parse(`${date}T${open}Z`)
      expect(windows).toContainEqual(expect.objectContaining({ market, open: end, closed: null }))
    }
  })

  it.each([
    ['2026-03-06', 12, 17],
    ['2026-03-09', 12, 16],
    ['2026-03-30', 11, 16],
  ])('converts each market’s midday markers from local time on %s', (date, londonHour, newYorkHour) => {
    const windows = windowsOn(date)
    const byMarket = new Map(windows.map(window => [window.market, window.midday]))
    const midnight = Date.parse(`${date}T00:00Z`)
    const hour = 3_600_000
    expect(byMarket.get('tokyo')).toEqual([midnight + 2.5 * hour, midnight + 3.5 * hour])
    expect(byMarket.get('london')).toEqual([midnight + londonHour * hour, midnight + (londonHour + 2) * hour])
    expect(byMarket.get('newYork')).toEqual([midnight + newYorkHour * hour, midnight + (newYorkHour + 2) * hour])
  })

  it('keeps Friday New York close across Shanghai midnight and marks exchange weekends', () => {
    const windows = windowsOn('2026-11-20')
    const close = windows.find(window => window.market === 'newYork')!.close
    expect(formatDisplayTime(close, 'Asia/Shanghai')).toBe('2026-11-21 05:00 星期六')
    for (const date of ['2026-11-21', '2026-11-22']) {
      const weekend = windowsOn(date)
      expect(weekend).toHaveLength(3)
      expect(weekend.every(window => window.closed === '周末休市')).toBe(true)
      expect(weekend.every(window => window.midday === null)).toBe(true)
    }
  })

  it('uses the listed market holidays and early closes', () => {
    expect(windowsOn('2026-09-22').find(window => window.market === 'tokyo')?.closed).toBe('节假日休市')
    expect(windowsOn('2026-12-28').find(window => window.market === 'london')?.closed).toBe('节假日休市')
    expect(windowsOn('2026-11-26').find(window => window.market === 'newYork')?.closed).toBe('节假日休市')
    expect(windowsOn('2026-11-26').find(window => window.market === 'newYork')?.midday).toBeNull()
    expect(windowsOn('2026-11-27')).toContainEqual(expect.objectContaining({
      market: 'newYork', close: Date.parse('2026-11-27T18:00Z'), closed: null, midday: null,
    }))
    expect(windowsOn('2026-12-24')).toContainEqual(expect.objectContaining({
      market: 'london', close: Date.parse('2026-12-24T12:30Z'), closed: null, midday: null,
    }))
  })

  it('uses the Tokyo close in effect at the time of a historical replay', () => {
    for (const [date, close] of [['2024-11-01', '06:00'], ['2024-11-05', '06:30']]) {
      expect(windowsOn(date).find(window => window.market === 'tokyo')?.close).toBe(Date.parse(`${date}T${close}Z`))
    }
  })

  it('includes full future blocks for all markets on the next day of a DST change', () => {
    const reference = Date.parse('2026-10-24T15:00Z')
    const forecast = marketSessionForecast(reference)
    expect(forecast.end).toBe(Date.parse('2026-10-25T20:00Z'))
    for (const market of ['tokyo', 'london', 'newYork']) {
      const next = forecast.sessions.find(session => session.market === market && session.open > reference)
      expect(next).toBeDefined()
      expect(next!.closed).toBe('周末休市')
      expect(next!.close).toBeLessThanOrEqual(forecast.end)
    }
    const londonOnly = marketSessionForecast(reference, [false, true, false])
    expect(londonOnly.sessions.map(session => session.market)).toEqual(['london'])
    expect(londonOnly.end).toBe(Date.parse('2026-10-25T16:30Z'))
  })

  it('loads older lead times and removes them from the current configuration', () => {
    expect(normalizeMarketSessionParams([])).toEqual([])
    expect(normalizeMarketSessionParams([0, 1440])).toEqual([])
    for (const params of [[60], [60, null], [60, '30'], [-1, 15], [60, 1441], [60, 1.5]]) {
      expect(() => normalizeMarketSessionParams(params)).toThrow(/MARKET_SESSIONS/)
    }
  })

  it.each([false, true])('draws the full session beyond the last candle with showMidday=%s', showMidday => {
    const base = Date.parse('2026-11-18T22:30Z')
    const fillRect = vi.fn()
    const moveTo = vi.fn()
    const fillText = vi.fn()
    const setLineDash = vi.fn()
    const drawParams = {
      ctx: {
        save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
        fillRect, moveTo, lineTo: vi.fn(), stroke: vi.fn(), setLineDash,
        measureText: () => ({ width: 32 }), fillText, strokeText: vi.fn(),
      },
      indicator: { calcParams: [], styles: { showMidday } },
      kLineDataList: Array.from({ length: 9 }, (_, index) => ({ timestamp: base + index * 15 * 60_000 })),
      visibleRange: { from: 0, to: 9, realFrom: 0, realTo: 34 },
      bounding: { width: 520, height: 180 },
      xAxis: { convertToPixel: (index: number) => index * 15 },
    } as unknown as IndicatorDrawParams
    const reference = Date.parse('2026-11-19T00:30Z')
    drawMarketSessions(drawParams, { timeframe: '15m', confirmedUntil: reference })
    expect(fillRect).toHaveBeenCalledExactlyOnceWith(90, 0, 390, 180)
    expect(moveTo.mock.calls).toEqual(showMidday ? [[90.5, 0], [240.5, 0], [300.5, 0], [480.5, 0]] : [[90.5, 0], [480.5, 0]])
    expect(fillText.mock.calls.map(([label]) => label)).toEqual(['东京开盘', '东京收盘'])
    expect(setLineDash.mock.calls.filter(([dash]) => dash.length !== 0)).toEqual(showMidday ? [[[5, 4]], [[5, 4]]] : [])
  })

  it.each([
    { visibility: [true, false, true], fills: 3, lines: 8,
      labels: ['东京开盘', '东京收盘', '纽约开盘', '纽约收盘', '东京周末休市'] },
    { visibility: [false, false, false], fills: 0, lines: 0, labels: [] },
  ])('draws only enabled markets in historical and future periods ($visibility)', ({ visibility, fills, lines, labels }) => {
    const base = Date.parse('2026-11-20T00:00Z')
    const hour = 3_600_000
    const ctx = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      fillRect: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(),
      measureText: () => ({ width: 32 }), fillText: vi.fn(), strokeText: vi.fn(),
    }
    const params = {
      ctx,
      indicator: { styles: { sessionVisibility: visibility, showMidday: true } },
      kLineDataList: Array.from({ length: 13 }, (_, index) => ({ timestamp: base + index * hour })),
      visibleRange: { realFrom: 0, realTo: 38 },
      bounding: { width: 380, height: 180 },
      xAxis: { convertToPixel: (index: number) => index * 10 },
    } as unknown as IndicatorDrawParams
    drawMarketSessions(params, { timeframe: '1h', confirmedUntil: base + 12 * hour })
    expect(ctx.fillRect).toHaveBeenCalledTimes(fills)
    expect(ctx.stroke).toHaveBeenCalledTimes(lines)
    expect(ctx.fillText.mock.calls.map(([label]) => label)).toEqual(labels)
  })
})
