import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App', () => {
  it('renders the workstation title and mode label', () => {
    render(<App />)
    expect(
      screen.getByRole('heading', { name: '加密货币合约回放工作站' }),
    ).toBeVisible()
    expect(screen.getByText('历史模拟')).toBeVisible()
  })
})
