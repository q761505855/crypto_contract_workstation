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

  it('keeps the chart but removes trading controls in live mode', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '实时行情' }))

    expect(screen.getByTestId('chart-host')).toBeVisible()
    expect(screen.queryByTestId('simulation-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('replay-controls')).not.toBeInTheDocument()
    expect(screen.getByTestId('live-status')).toHaveTextContent('只读')
  })
})
