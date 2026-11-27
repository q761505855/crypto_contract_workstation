import type { Datafeed, Period, SymbolInfo } from '@klinecharts/pro'
import type { Chart, KLineData } from 'klinecharts'
import { readIndicatorHistory } from '../market-data/indicator-history'
import { klineCloseBoundary } from '../market-data/intervals'
import { cashRanges, isCashChart, mergeCashCandles } from './new-york-cash'

const minute = 60_000
const minutePeriod: Period = { text: '1m', multiplier: 1, timespan: 'minute' }
const halfHourPeriod: Period = { text: '30m', multiplier: 30, timespan: 'minute' }
const pageBars = 360

interface DetailPage {
  from: number
  until: number
  period: Period
  refreshAt: number
}

export class CashCandleHistory {
  private readonly pages = new Map<string, { rows: KLineData[]; refreshAt: number }>()
  private readonly pending = new Map<string, AbortController>()

  constructor(private readonly chart: Chart, private readonly feed: Datafeed,
    private readonly selection: () => { symbol: SymbolInfo; period: Period; until: number } | undefined,
    private readonly onDetailsLoaded: () => void) {}

  reset(): void {
    for (const request of this.pending.values()) request.abort()
    this.pending.clear()
    this.pages.clear()
  }

  private range(candle: KLineData, period: Period, until: number) {
    const start = candle.timestamp
    const end = klineCloseBoundary(start, period.text)
    const ranges = cashRanges(start, end)
    const whole = ranges.length === 1 && ranges[0][0] === start && ranges[0][1] === end
    const revealed = whole ? ranges : ranges.filter(([from]) => from < until).map(([from, to]) => [from, Math.min(to, until)] as const)
    const detail = start % (30 * minute) === 0 && end % (30 * minute) === 0 ? halfHourPeriod : minutePeriod
    return { whole, ranges: revealed, detail }
  }

  private *detailPages(ranges: ReturnType<typeof cashRanges>, period: Period, until: number): Iterable<DetailPage> {
    const step = period.multiplier * minute
    const span = step * pageBars
    let previous = -Infinity
    for (const [start, end] of ranges) {
      for (let from = Math.floor(start / span) * span; from < end; from += span) {
        if (from === previous) continue
        previous = from
        const pageEnd = Math.min(from + span, until)
        const lastCashEnd = cashRanges(from, pageEnd).at(-1)?.[1] ?? pageEnd
        const refreshAt = pageEnd === from + span ? Infinity : Math.floor(lastCashEnd / minute) * minute
        yield { from, until: lastCashEnd, period, refreshAt }
      }
    }
  }

  private key(page: DetailPage): string {
    return `${page.period.text}:${page.from}`
  }

  project(candles: readonly KLineData[], period: Period, until: number): (KLineData | undefined)[] {
    return candles.map(candle => this.projectCandle(candle, period, until))
  }

  private projectCandle(candle: KLineData, period: Period, until: number): KLineData | undefined {
    const { whole, ranges, detail } = this.range(candle, period, until)
    if (whole) return candle
    if (!ranges.length) return
    const rows: KLineData[] = []
    for (const page of this.detailPages(ranges, detail, until)) {
      const cached = this.pages.get(this.key(page))
      if (!cached) return
      const start = ranges[0][0]
      const end = ranges.at(-1)![1]
      for (const row of cached.rows) if (row.timestamp >= start && row.timestamp < end) rows.push(row)
    }
    return mergeCashCandles(candle.timestamp, rows, ranges)
  }

  loadVisible(): void {
    if (!isCashChart(this.chart)) return
    const selection = this.selection()
    if (!selection) return
    const { period, symbol, until } = selection
    const raw = this.chart.getDataList()
    const { from, to } = this.chart.getVisibleRange()
    const start = Math.max(0, from - (period.timespan === 'week' || period.timespan === 'month' ? 1 : 100))
    for (let index = Math.min(to, raw.length) - 1; index >= start; index--) {
      const { whole, ranges, detail } = this.range(raw[index], period, until)
      if (whole) continue
      for (const page of this.detailPages(ranges, detail, until)) {
        if (this.pending.size >= 2) return
        const key = this.key(page)
        if (this.pending.has(key) || (this.pages.get(key)?.refreshAt ?? -Infinity) >= page.refreshAt) continue
        const request = new AbortController()
        this.pending.set(key, request)
        void readIndicatorHistory(this.feed, symbol, page.period, page.from, page.until - 1, request.signal)
          .then(rows => {
            if (request.signal.aborted) return
            this.pages.set(key, { rows, refreshAt: page.refreshAt })
            this.chart.refreshCashCandles?.()
            if (isCashChart(this.chart)) this.onDetailsLoaded()
          }).catch(() => {
            if (!request.signal.aborted) this.pages.set(key, { rows: [], refreshAt: page.refreshAt })
          }).finally(() => {
            if (request.signal.aborted) return
            this.pending.delete(key)
            this.loadVisible()
          })
      }
    }
  }
}
