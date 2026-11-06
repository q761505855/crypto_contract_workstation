import {
  act,
  cleanup,
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
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('disposes the previous chart when configuration restore remounts the workspace', () => {
  const dispose = vi.fn()
  const adapter = {
    mount: vi.fn(), dispose,
    getSymbol: () => ({ ticker: 'BTCUSDT' }), getPeriod: () => ({ multiplier: 15, timespan: 'minute', text: '15m' }),
    setSimulationOverlays: vi.fn(), setTheme: vi.fn(), setTimezone: vi.fn(),
  } as unknown as ChartAdapterPort
  const view = render(<ChartWorkspace createAdapter={() => adapter} />)
  view.unmount()
  expect(dispose).toHaveBeenCalledOnce()
})

describe('ChartWorkspace', () => {
  it('saves changed candle types without overwriting an imported preference from a stale chart', () => {
    vi.useFakeTimers()
    let type: 'candle_solid' | 'heikin_ashi' = 'candle_solid'
    const adapter = { ...sizingAdapter(), getCandleType: () => type }
    render(<ChartWorkspace createAdapter={() => adapter} />)
    act(() => { type = 'heikin_ashi'; vi.advanceTimersByTime(100) })
    expect(localStorage.getItem('chart.candleType.v1')).toBe('"heikin_ashi"')
    expect(screen.getByRole('note')).toHaveTextContent('真实行情')
    localStorage.setItem('chart.candleType.v1', '"candle_stroke"')
    act(() => { vi.advanceTimersByTime(1000); window.dispatchEvent(new Event('beforeunload')) })
    expect(localStorage.getItem('chart.candleType.v1')).toBe('"candle_stroke"')
  })
  function sizingAdapter(): ChartAdapterPort {
    let height = 160
    return {
      mount: () => {},
      getPeriod: () => ({ multiplier: 15, timespan: 'minute', text: '15m' }),
      getSymbol: () => ({ ticker: 'BTCUSDT' }),
      reloadData: async () => {},
      setPeriod: () => {}, setSymbol: () => {}, setTheme: () => {}, setTimezone: () => {}, setSimulationOverlays: () => {},
      getIndicatorPaneSizes: () => [{ id: 'rsi', label: 'RSI', height }],
      setIndicatorPaneHeight: (_id, next) => { height = next },
      getIndicatorPreferences: () => ({ ...indicatorPreferences, sub: [{ ...indicatorPreferences.sub[0], height }] }),
    }
  }

  it('uses the newly resized core viewport when restoring or compressing indicator panes', () => {
    let notifyResize = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notifyResize = callback }
      observe() {}
      disconnect() {}
    })
    let hostHeight = 321
    let coreHeight = 321
    let displayedPaneHeight = 0
    const adapter: ChartAdapterPort = {
      ...sizingAdapter(),
      resize: () => { coreHeight = hostHeight },
      layoutSubPanes: () => {
        displayedPaneHeight = coreHeight >= 600 ? 195 : 60
        return displayedPaneHeight
      },
    }
    render(<ChartWorkspace createAdapter={() => adapter} />)
    expect(displayedPaneHeight).toBe(60)
    hostHeight = 622
    act(() => notifyResize())
    expect(displayedPaneHeight).toBe(195)
    hostHeight = 321
    act(() => notifyResize())
    expect(displayedPaneHeight).toBe(60)
  })

  it('changes chart and indicator heights through accessible sliders and preserves complete indicator preferences', () => {
    const adapter = sizingAdapter()
    const changeHeight = vi.fn()
    render(<ChartWorkspace createAdapter={() => adapter} layoutSettingsOpen chartHeight={600} onChartHeightChange={changeHeight} />)
    fireEvent.change(screen.getByRole('slider', { name: '图表区域高度' }), { target: { value: '720' } })
    expect(changeHeight).toHaveBeenCalledWith(720)
    fireEvent.click(screen.getByRole('button', { name: '自动适配' }))
    expect(changeHeight).toHaveBeenLastCalledWith(null)
    fireEvent.change(screen.getByRole('slider', { name: 'RSI 高度' }), { target: { value: '240' } })
    expect(screen.getByText('240 px')).toBeVisible()
    expect(JSON.parse(localStorage.getItem(CHART_INDICATORS_PREFERENCE)!)).toEqual({ ...indicatorPreferences, sub: [{ ...indicatorPreferences.sub[0], height: 240 }] })
  })

  it('restores the opener focus when height settings close with Escape or the close button', () => {
    const adapter = sizingAdapter()
    const close = vi.fn()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { rerender } = render(<ChartWorkspace createAdapter={() => adapter} layoutSettingsOpen onCloseLayoutSettings={close} />)
    expect(screen.getByRole('button', { name: '关闭图表尺寸设置' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
    rerender(<ChartWorkspace createAdapter={() => adapter} layoutSettingsOpen={false} onCloseLayoutSettings={close} />)
    expect(opener).toHaveFocus()
    opener.focus()
    rerender(<ChartWorkspace createAdapter={() => adapter} layoutSettingsOpen onCloseLayoutSettings={close} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭图表尺寸设置' }))
    expect(close).toHaveBeenCalledTimes(2)
    rerender(<ChartWorkspace createAdapter={() => adapter} layoutSettingsOpen={false} />)
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('resizes with pointer capture and keyboard while clamping chart height', () => {
    const changeHeight = vi.fn()
    render(<ChartWorkspace createAdapter={sizingAdapter} chartHeight={600} onChartHeightChange={changeHeight} />)
    const handle = screen.getByRole('separator', { name: '图表高度' })
    const capture = vi.fn()
    const release = vi.fn()
    handle.setPointerCapture = capture
    handle.releasePointerCapture = release
    handle.hasPointerCapture = () => true
    const pointer = (type: string, clientY: number) => {
      const event = new Event(type, { bubbles: true })
      Object.assign(event, { pointerId: 7, clientY, button: 0 })
      fireEvent(handle, event)
    }
    pointer('pointerdown', 200)
    pointer('pointermove', 300)
    expect(capture).toHaveBeenCalledWith(7)
    expect(changeHeight).toHaveBeenCalledWith(700)
    pointer('pointerup', 300)
    expect(release).toHaveBeenCalledWith(7)
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(changeHeight).toHaveBeenLastCalledWith(580)
    fireEvent.keyDown(handle, { key: 'End' })
    expect(changeHeight).toHaveBeenLastCalledWith(1600)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(changeHeight).toHaveBeenLastCalledWith(280)
  })

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
