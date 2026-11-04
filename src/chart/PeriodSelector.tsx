import { useEffect, useRef, useState } from 'react'
import { SUPPORTED_PERIODS } from './chart-config'
import { readPinnedPeriods, savePinnedPeriods } from './period-preferences'

interface PeriodSelectorProps {
  value: string
  onChange: (period: string) => void
}

export function PeriodSelector({ value, onChange }: PeriodSelectorProps) {
  const [pinned, setPinned] = useState(readPinnedPeriods)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: number; x: number; y: number; scrollLeft: number } | null>(null)
  const draggedRef = useRef(false)

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(.period-pin)')?.focus()
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  function togglePin(text: string): void {
    const next = SUPPORTED_PERIODS.filter((candidate) =>
      candidate.text === text ? !pinned.includes(text) : pinned.includes(candidate.text),
    ).map((candidate) => candidate.text)
    setPinned(next)
    try {
      savePinnedPeriods(next)
    } catch {
      // Pinning still works for this visit without storage.
    }
  }

  return (
    <div className="period-controls" ref={containerRef}>
      <div
        className="pinned-periods"
        role="group"
        aria-label="快捷周期"
        onPointerDown={(event) => {
          draggedRef.current = false
          if (event.pointerType === 'mouse') return
          dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, scrollLeft: event.currentTarget.scrollLeft }
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (drag === null || drag.id !== event.pointerId) return
          const distance = event.clientX - drag.x
          if (!draggedRef.current && Math.abs(distance) > 5 && Math.abs(distance) > Math.abs(event.clientY - drag.y)) {
            draggedRef.current = true
            event.currentTarget.setPointerCapture(event.pointerId)
          }
          if (draggedRef.current) event.currentTarget.scrollLeft = drag.scrollLeft - distance
        }}
        onPointerUp={() => { dragRef.current = null }}
        onPointerCancel={() => {
          dragRef.current = null
          draggedRef.current = false
        }}
        onClickCapture={(event) => {
          if (draggedRef.current && event.detail > 0) {
            event.preventDefault()
            event.stopPropagation()
          }
          draggedRef.current = false
        }}
      >
        {pinned.map((text) => (
          <button
            aria-label={`快捷周期 ${text}`}
            aria-pressed={value === text}
            key={text}
            onClick={() => onChange(text)}
            type="button"
          >{text}</button>
        ))}
      </div>
      <button
        aria-label="图表周期"
        aria-expanded={open}
        aria-haspopup="dialog"
        className="period-dropdown-trigger"
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        type="button"
      >{value}<span aria-hidden="true">▾</span></button>
      {open && (
        <div aria-label="选择图表周期" className="period-dropdown" ref={menuRef} role="dialog">
          <p>选择周期 · ★ 固定到快捷栏</p>
          <div className="period-options">
            {SUPPORTED_PERIODS.map(({ text }) => (
              <div className="period-option" key={text}>
                <button
                  aria-label={`选择周期 ${text}`}
                  aria-pressed={value === text}
                  onClick={() => {
                    onChange(text)
                    setOpen(false)
                    triggerRef.current?.focus()
                  }}
                  type="button"
                >{text}</button>
                <button
                  aria-label={`${pinned.includes(text) ? '取消固定' : '固定'}周期 ${text}`}
                  aria-pressed={pinned.includes(text)}
                  className="period-pin"
                  onClick={() => togglePin(text)}
                  type="button"
                >{pinned.includes(text) ? '★' : '☆'}</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
