import type {
  ChartPro,
  ChartProOptions,
  Period,
  SymbolInfo,
} from '@klinecharts/pro'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@klinecharts/pro', () => ({ KLineChartPro: vi.fn() }))

import { ProChartAdapter } from './pro-chart-adapter'

function fakeChart(): ChartPro {
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
    setLocale: vi.fn(),
    setPeriod: vi.fn(),
    setStyles: vi.fn(),
    setSymbol: vi.fn(),
    setTheme: vi.fn(),
    setTimezone: vi.fn(),
  }
}

describe('ProChartAdapter', () => {
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
})
