import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function WorkspaceDialog({ open, title, onClose, children, className = '' }: {
  open: boolean
  title: string
  onClose(): void
  children: ReactNode
  className?: string
}) {
  const id = useId()
  const panel = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = () => [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href]') ?? [])]
      .filter(element => !element.closest('[hidden]'))
    focusable()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current() }
      if (event.key === 'Tab') {
        const items = focusable()
        const first = items[0], last = items.at(-1)
        if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus() }
  }, [open])
  if (!open) return null
  return createPortal(
    <div className="workspace-dialog-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={panel} className={`workspace-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <header className="panel-heading"><h2 id={id}>{title}</h2><button type="button" onClick={onClose} aria-label={`关闭${title}`}>✕</button></header>
        <div className="workspace-dialog-body">{children}</div>
      </section>
    </div>, document.body,
  )
}
