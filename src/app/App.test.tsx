import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../chart/ChartWorkspace', () => ({
  ChartWorkspace: () => <div data-testid="chart-host" />,
}))

import App from './App'

afterEach(cleanup)

describe('App', () => {
  it('shows simulator and replay controls in history mode', () => {
    render(<App />)
    expect(screen.getByTestId('simulation-panel')).toBeVisible()
    expect(screen.getByTestId('replay-controls')).toBeVisible()
    expect(screen.queryByTestId('live-status')).not.toBeInTheDocument()
  })

  it('keeps the exact chart host node across repeated mode switches', () => {
    render(<App />)
    const initialChartHost = screen.getByTestId('chart-host')
    const historyButton = screen.getByRole('button', {
      name: '\u5386\u53f2\u6a21\u62df',
    })
    const liveButton = screen.getByRole('button', {
      name: '\u5b9e\u65f6\u884c\u60c5',
    })

    fireEvent.click(liveButton)
    expect(screen.getByTestId('chart-host')).toBe(initialChartHost)
    expect(screen.queryByTestId('simulation-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('replay-controls')).not.toBeInTheDocument()
    expect(screen.getByTestId('live-status')).toHaveTextContent('\u53ea\u8bfb')

    fireEvent.click(historyButton)
    expect(screen.getByTestId('chart-host')).toBe(initialChartHost)
    expect(screen.getByTestId('simulation-panel')).toBeVisible()
    expect(screen.getByTestId('replay-controls')).toBeVisible()

    fireEvent.click(liveButton)
    expect(screen.getByTestId('chart-host')).toBe(initialChartHost)
    expect(screen.getByTestId('live-status')).toHaveTextContent('\u53ea\u8bfb')
  })
})
