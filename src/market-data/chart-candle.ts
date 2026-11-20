import type { KLineData } from 'klinecharts'
import type { MarketCandle } from './models'

export function toChartCandle(candle: MarketCandle): KLineData {
  const { openTime, open, high, low, close, source, tickVolume } = candle
  return {
    timestamp: openTime,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    ...(source === 'ctrader'
      ? { volume: tickVolume, volumeKind: 'quotes', ctraderClosed: candle.isClosed }
      : { volume: Number(candle.volume), turnover: Number(candle.quoteVolume) }),
  }
}
