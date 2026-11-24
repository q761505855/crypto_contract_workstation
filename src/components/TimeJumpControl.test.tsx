import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TimeJumpControl } from './TimeJumpControl'

afterEach(cleanup)

describe('chart time navigation', () => {
  it('opens the date picker at the current archive position', () => {
    const onJump = vi.fn()
    const onLocateLatest = vi.fn()
    const first = new Date('2024-02-03T14:25').getTime()
    const second = new Date('2024-02-04T05:10').getTime()
    const { rerender } = render(<TimeJumpControl compact defaultTimestamp={first} onJump={onJump} onLocateLatest={onLocateLatest} />)
    fireEvent.click(screen.getByRole('button', { name: '时间定位' }))
    expect(screen.getByLabelText('图表跳转时间')).toHaveValue('2024-02-03T14:25')
    fireEvent.click(screen.getByRole('button', { name: '跳转' }))
    expect(onJump).toHaveBeenCalledWith(first)
    rerender(<TimeJumpControl compact defaultTimestamp={second} onJump={onJump} onLocateLatest={onLocateLatest} />)
    fireEvent.click(screen.getByRole('button', { name: '时间定位' }))
    expect(screen.getByLabelText('图表跳转时间')).toHaveValue('2024-02-04T05:10')
  })

  it('locates latest independently of an empty date input', () => {
    const onJump = vi.fn()
    const onLocateLatest = vi.fn()
    render(<TimeJumpControl onJump={onJump} onLocateLatest={onLocateLatest} />)
    fireEvent.change(screen.getByLabelText('图表跳转时间'), { target: { value: '' } })
    expect(screen.getByRole('button', { name: '跳转' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '定位最新' }))
    expect(onLocateLatest).toHaveBeenCalledOnce()
    expect(onJump).not.toHaveBeenCalled()
  })

  it('disables both navigation actions while locked', () => {
    const onLocateLatest = vi.fn()
    render(<TimeJumpControl disabled onJump={vi.fn()} onLocateLatest={onLocateLatest} />)
    expect(screen.getByRole('button', { name: '跳转' })).toBeDisabled()
    const latest = screen.getByRole('button', { name: '定位最新' })
    expect(latest).toBeDisabled()
    fireEvent.click(latest)
    expect(onLocateLatest).not.toHaveBeenCalled()
  })
})
