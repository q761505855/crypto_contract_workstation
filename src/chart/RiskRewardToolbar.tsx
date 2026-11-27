import { useEffect, useId, useRef, useState } from 'react'
import type { DrawingDraft } from './drawing-overlays'
import { riskRewardSide, type RiskRewardSide } from './risk-reward'

export function RiskRewardToolbar({ draft, onStart, onCancel }: {
  draft: DrawingDraft | null
  onStart: (side: RiskRewardSide) => boolean
  onCancel: () => void
}) {
  const [open, setOpen] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const side = riskRewardSide(draft?.name)
  const active = Boolean(side && !draft?.invalid)

  useEffect(() => {
    if (!open && !active) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      if (active) onCancel()
      else trigger.current?.focus()
      setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [active, onCancel, open])

  const choose = (direction: RiskRewardSide) => {
    trigger.current?.focus()
    setOpen(false)
    setUnavailable(!onStart(direction))
  }
  const status = unavailable ? '请先加载行情并显示绘图' : side && (draft?.invalid
    ? side === 'long' ? '做多需要止损价低于入场价，止盈价高于入场价' : '做空需要止盈价低于入场价，止损价高于入场价'
    : `${side === 'long' ? '做多' : '做空'} · 在 K 线主图依次点击入场、止损、止盈`)

  return <div className="chart-risk-reward" ref={container} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }}>
    <button ref={trigger} type="button" className="chart-drawing-tool-button" aria-label="盈亏比"
      title={active ? '取消绘制盈亏比' : '盈亏比'} aria-expanded={open} aria-controls={id}
      onClick={() => {
        setUnavailable(false)
        if (active) onCancel()
        else setOpen(current => !current)
      }}>
      <svg className={active ? 'icon-overlay selected' : 'icon-overlay'} width="32" height="32" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 6h14v12H5z M5 12h14 M12 6v12" fill="none" strokeWidth="1.25" />
        <path d="M7.5 9h2 M8.5 8v2 M15 15h2" fill="none" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
    </button>
    <div className="chart-risk-reward-menu" id={id} hidden={!open} role="group" aria-label="盈亏比方向">
      <button type="button" onClick={() => choose('long')}>做多盈亏比</button>
      <button type="button" onClick={() => choose('short')}>做空盈亏比</button>
    </div>
    {!open && status && <span className="chart-risk-reward-status" role="status">{status}</span>}
  </div>
}
