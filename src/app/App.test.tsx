import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../chart/ChartWorkspace', () => ({
  ChartWorkspace: () => <div data-testid="chart-host" />,
}))

import App from './App'

afterEach(cleanup)

describe('App', () => {
  it('opens live with replay controls and keeps the position panel hidden', () => {
    render(<App />)
    expect(screen.getByTestId('live-workspace')).toBeVisible()
    expect(screen.getByTestId('replay-controls')).toBeVisible()
    expect(screen.getByTestId('live-status')).toHaveTextContent('只读')
    expect(screen.queryByRole('region', { name: '持仓与复盘面板' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('步进周期')).not.toBeInTheDocument()
  })
})
