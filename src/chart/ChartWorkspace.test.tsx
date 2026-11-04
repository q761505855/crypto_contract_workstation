import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@klinecharts/pro', () => ({ KLineChartPro: vi.fn() }))

import type { ChartAdapterPort } from './pro-chart-adapter'
import { ChartWorkspace } from './ChartWorkspace'
import {
  CHART_INDICATORS_PREFERENCE,
  type ChartIndicatorPreferences,
} from './indicator-preferences'

const indicatorPreferences: ChartIndicatorPreferences = {
  schemaVersion: 1,
  main: [
    {
      name: 'MA',
      calcParams: [7, 25, 99],
      visible: true,
      styles: null,
    },
  ],
  sub: [
    {
      height: 160,
      indicators: [
        {
          name: 'RSI',
          calcParams: [6, 12, 24],
          visible: true,
          styles: null,
        },
      ],
    },
  ],
}

afterEach(() => {
  localStorage.clear()
  vi.useRealTimers()
})

describe('ChartWorkspace', () => {
  it('mounts one adapter into a stable chart host', async () => {
    const adapter: ChartAdapterPort = {
      mount: vi.fn(),
      getPeriod: vi.fn(() => ({
        multiplier: 15,
        timespan: 'minute',
        text: '15m',
      })),
      getSymbol: vi.fn(() => ({ ticker: 'BTCUSDT' })),
      reloadData: vi.fn(async () => undefined),
      setPeriod: vi.fn(),
      setSymbol: vi.fn(),
      setTheme: vi.fn(),
      setTimezone: vi.fn(),
      setSimulationOverlays: vi.fn(),
    }

    const { rerender } = render(
      <ChartWorkspace createAdapter={() => adapter} />,
    )
    rerender(<ChartWorkspace createAdapter={() => adapter} />)

    const host = screen.getByTestId('chart-host')
    expect(host).toBeVisible()
    await waitFor(() => expect(adapter.mount).toHaveBeenCalledOnce())
    expect(adapter.mount).toHaveBeenCalledWith(
      expect.objectContaining({ container: host }),
    )
  })

  it('reloads data when the replay context changes without a symbol change', async () => {
    const symbol = { ticker: 'BTCUSDT' }
    const adapter: ChartAdapterPort = {
      mount: vi.fn(),
      getPeriod: vi.fn(() => ({
        multiplier: 1,
        timespan: 'minute',
        text: '1m',
      })),
      getSymbol: vi.fn(() => symbol),
      reloadData: vi.fn(async () => undefined),
      setPeriod: vi.fn(),
      setSymbol: vi.fn(),
      setTheme: vi.fn(),
      setTimezone: vi.fn(),
      setSimulationOverlays: vi.fn(),
    }
    const { rerender } = render(
      <ChartWorkspace
        createAdapter={() => adapter}
        reloadKey={0}
        symbol={symbol}
      />,
    )

    rerender(
      <ChartWorkspace
        createAdapter={() => adapter}
        reloadKey={1}
        symbol={symbol}
      />,
    )

    await waitFor(() => expect(adapter.reloadData).toHaveBeenCalledOnce())
    expect(adapter.setSymbol).not.toHaveBeenCalled()
  })

  it('changes the chart period through the compact selector', async () => {
    const symbol = { ticker: 'BTCUSDT' }
    const setPeriod = vi.fn()
    const onSelectionChange = vi.fn()
    const adapter: ChartAdapterPort = {
      mount: vi.fn(),
      getPeriod: vi.fn(() => ({
        multiplier: 15,
        timespan: 'minute',
        text: '15m',
      })),
      getSymbol: vi.fn(() => symbol),
      reloadData: vi.fn(async () => undefined),
      setPeriod,
      setSymbol: vi.fn(),
      setTheme: vi.fn(),
      setTimezone: vi.fn(),
      setSimulationOverlays: vi.fn(),
    }

    const { container } = render(
      <ChartWorkspace
        createAdapter={() => adapter}
        onSelectionChange={onSelectionChange}
        symbol={symbol}
      />,
    )
    const compactSelector = container.querySelector(
      'button[aria-label="图表周期"]',
    )
    expect(compactSelector).not.toBeNull()
    fireEvent.click(compactSelector!)
    fireEvent.click(screen.getByRole('button', { name: '选择周期 1h' }))

    expect(setPeriod).toHaveBeenCalledWith(
      expect.objectContaining({ text: '1h' }),
    )
    expect(onSelectionChange).toHaveBeenCalledWith({
      symbol,
      period: expect.objectContaining({ text: '1h' }),
    })
  })

  it('restores saved indicator preferences when mounting the chart', async () => {
    localStorage.setItem(
      CHART_INDICATORS_PREFERENCE,
      JSON.stringify(indicatorPreferences),
    )
    const adapter: ChartAdapterPort = {
      mount: vi.fn(),
      applyIndicatorPreferences: vi.fn(),
      getPeriod: vi.fn(() => ({
        multiplier: 15,
        timespan: 'minute',
        text: '15m',
      })),
      getSymbol: vi.fn(() => ({ ticker: 'BTCUSDT' })),
      reloadData: vi.fn(async () => undefined),
      setPeriod: vi.fn(),
      setSymbol: vi.fn(),
      setTheme: vi.fn(),
      setTimezone: vi.fn(),
      setSimulationOverlays: vi.fn(),
    }

    render(<ChartWorkspace createAdapter={() => adapter} />)

    await waitFor(() =>
      expect(adapter.mount).toHaveBeenCalledWith(
        expect.objectContaining({
          mainIndicators: ['MA'],
          subIndicators: ['RSI'],
        }),
      ),
    )
    expect(adapter.applyIndicatorPreferences).toHaveBeenCalledWith(
      indicatorPreferences,
    )
  })

  it('saves indicator changes detected from the chart', () => {
    vi.useFakeTimers()
    let current = indicatorPreferences
    const adapter: ChartAdapterPort = {
      mount: vi.fn(),
      getIndicatorPreferences: vi.fn(() => current),
      getPeriod: vi.fn(() => ({
        multiplier: 15,
        timespan: 'minute',
        text: '15m',
      })),
      getSymbol: vi.fn(() => ({ ticker: 'BTCUSDT' })),
      reloadData: vi.fn(async () => undefined),
      setPeriod: vi.fn(),
      setSymbol: vi.fn(),
      setTheme: vi.fn(),
      setTimezone: vi.fn(),
      setSimulationOverlays: vi.fn(),
    }
    const { unmount } = render(
      <ChartWorkspace createAdapter={() => adapter} />,
    )
    current = {
      ...indicatorPreferences,
      main: [
        {
          ...indicatorPreferences.main[0],
          calcParams: [10, 30, 60],
        },
      ],
    }

    act(() => vi.advanceTimersByTime(250))

    expect(
      JSON.parse(
        localStorage.getItem(CHART_INDICATORS_PREFERENCE) ?? 'null',
      ),
    ).toEqual(current)
    unmount()
  })
})
