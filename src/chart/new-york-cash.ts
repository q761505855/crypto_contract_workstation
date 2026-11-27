import type { Chart, KLineData } from 'klinecharts'
import type { TradeBar } from './order-flow-bars'
import { NEW_YORK_CASH } from './candle-preferences'
import { newYorkCashWindows } from './market-session-times'

type TimeRange = readonly [from: number, until: number]

export function cashRanges(from: number, until: number): TimeRange[] {
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) return []
  return Array.from(newYorkCashWindows(from, until), ({ open, close }) => [Math.max(from, open), Math.min(until, close)])
}

export function cashTradeRanges(fromUs: number, untilUs: number) {
  return cashRanges(fromUs / 1000, untilUs / 1000).map(([from, until]) => ({
    fromUs: Math.max(fromUs, Math.round(from * 1000)),
    untilUs: Math.min(untilUs, Math.round(until * 1000)),
  }))
}

export function cashTradeEnd(start: number, untilUs: number): number | undefined {
  return cashTradeRanges(start * 1000, untilUs).at(-1)?.untilUs
}

export function mergeCashCandles(timestamp: number, rows: readonly KLineData[], ranges: readonly TimeRange[]): KLineData | undefined {
  let result: KLineData | undefined
  let range = 0
  for (const row of rows) {
    while (range < ranges.length && row.timestamp >= ranges[range][1]) range++
    if (range === ranges.length) break
    if (row.timestamp < ranges[range][0]) continue
    if (!result) {
      result = { ...row, timestamp }
    } else {
      result.high = Math.max(result.high, row.high)
      result.low = Math.min(result.low, row.low)
      result.close = row.close
      if (row.volume !== undefined) result.volume = (result.volume ?? 0) + row.volume
      if (row.turnover !== undefined) result.turnover = (result.turnover ?? 0) + row.turnover
      result.ctraderClosed = row.ctraderClosed
    }
  }
  return result
}

export function readCashTradeBar(from: number, untilUs: number,
  read: (from: number, untilUs: number) => TradeBar | undefined): TradeBar | undefined {
  const ranges = cashTradeRanges(from * 1000, untilUs)
  if (!ranges.length) return { cursor: untilUs, volume: 0, complete: true, pointRanges: [] }
  const bars = ranges.map(range => read(range.fromUs / 1000, range.untilUs))
  if (bars.length === 1) return bars[0]
  const first = bars[0]
  const previous = first && combinedTradeBars.get(first)
  if (previous?.bar.cursor === untilUs && previous.inputs.length === bars.length &&
      bars.every((bar, index) => previous.inputs[index] === bar)) return previous.bar
  const combined: TradeBar = { cursor: untilUs, volume: 0, complete: true, pointRanges: [] }
  for (const bar of bars) {
    combined.complete &&= !!bar?.complete
    if (!bar) continue
    combined.volume += bar.volume
    combined.firstPrice ??= bar.firstPrice
    combined.firstBybitPrice ??= bar.firstBybitPrice
    combined.pointRanges.push(...bar.pointRanges)
  }
  if (first) combinedTradeBars.set(first, { inputs: bars, bar: combined })
  return combined
}

const combinedTradeBars = new WeakMap<TradeBar, { inputs: (TradeBar | undefined)[]; bar: TradeBar }>()

export function isCashChart(chart: Chart): boolean {
  return chart.getStyles().candle.type === NEW_YORK_CASH
}

export function displayCandles(chart: Chart): readonly (KLineData | undefined)[] {
  return chart.getDisplayDataList?.() ?? chart.getDataList()
}

export function latestDisplayCandle(chart: Chart): KLineData | undefined {
  return chart.getLatestDisplayData ? chart.getLatestDisplayData() : chart.getDataList().at(-1)
}
