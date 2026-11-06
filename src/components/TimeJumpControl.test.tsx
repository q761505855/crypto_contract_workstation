import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TimeJumpControl } from './TimeJumpControl'

afterEach(cleanup)

describe('chart time navigation', () => {
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
