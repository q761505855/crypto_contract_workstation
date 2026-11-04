import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PeriodSelector } from './PeriodSelector'
import { PINNED_PERIODS_KEY } from './period-preferences'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it('provides common shortcuts and keeps every period in the dropdown', () => {
  const onChange = vi.fn()
  render(<PeriodSelector value="15m" onChange={onChange} />)
  const shortcuts = screen.getByRole('group', { name: '快捷周期' })
  expect(within(shortcuts).getAllByRole('button').map((button) => button.textContent)).toEqual(['5m', '15m', '1h', '4h'])
  fireEvent.click(within(shortcuts).getByRole('button', { name: '快捷周期 1h' }))
  expect(onChange).toHaveBeenCalledWith('1h')
  fireEvent.click(screen.getByRole('button', { name: '图表周期' }))
  expect(screen.getAllByRole('button', { name: /^选择周期 / })).toHaveLength(15)
  fireEvent.click(screen.getByRole('button', { name: '选择周期 1M' }))
  expect(onChange).toHaveBeenLastCalledWith('1M')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('pins and unpins without changing the current period and restores saved shortcuts', () => {
  const onChange = vi.fn()
  const view = render(<PeriodSelector value="15m" onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: '图表周期' }))
  fireEvent.click(screen.getByRole('button', { name: '固定周期 1d' }))
  fireEvent.click(screen.getByRole('button', { name: '取消固定周期 5m' }))
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeVisible()
  expect(JSON.parse(localStorage.getItem(PINNED_PERIODS_KEY)!)).toEqual(['15m', '1h', '4h', '1d'])
  view.unmount()
  render(<PeriodSelector value="15m" onChange={onChange} />)
  expect(screen.getByRole('button', { name: '快捷周期 1d' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '快捷周期 5m' })).not.toBeInTheDocument()
})

it('preserves an intentionally empty shortcut list', () => {
  localStorage.setItem(PINNED_PERIODS_KEY, '[]')
  render(<PeriodSelector value="15m" onChange={vi.fn()} />)
  expect(within(screen.getByRole('group', { name: '快捷周期' })).queryAllByRole('button')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '图表周期' }))
  expect(screen.getAllByRole('button', { name: /^选择周期 / })).toHaveLength(15)
})

it('falls back from corrupt preferences and closes on Escape or an outside press', () => {
  localStorage.setItem(PINNED_PERIODS_KEY, '{broken')
  render(<PeriodSelector value="15m" onChange={vi.fn()} />)
  const trigger = screen.getByRole('button', { name: '图表周期' })
  expect(screen.getByRole('button', { name: '快捷周期 5m' })).toBeVisible()
  fireEvent.click(trigger)
  expect(screen.getByRole('button', { name: '选择周期 15m' })).toHaveFocus()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
  fireEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
