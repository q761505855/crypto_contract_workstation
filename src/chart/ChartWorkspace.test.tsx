import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@klinecharts/pro', () => ({ KLineChartPro: vi.fn() }))

import type { ChartAdapterPort } from './pro-chart-adapter'
import { ChartWorkspace } from './ChartWorkspace'

describe('ChartWorkspace', () => {
  it('mounts one adapter into a stable chart host', async () => {
    const adapter: ChartAdapterPort = {
      mount: vi.fn(),
      setPeriod: vi.fn(),
      setSymbol: vi.fn(),
      setTheme: vi.fn(),
      setTimezone: vi.fn(),
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
})
