import { useEffect, useRef, useState, type ReactNode } from 'react'

export function WorkspaceTools({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismissOutside)
    return () => document.removeEventListener('pointerdown', dismissOutside)
  }, [open])

  function close() {
    trigger.current?.focus()
    setOpen(false)
  }

  return <div className="workspace-tools" ref={container}
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}
    onKeyDown={event => {
      if (open && event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }}
  >
    <button ref={trigger} type="button" className="workspace-tools-trigger" aria-expanded={open}
      aria-controls="workspace-header-actions" onClick={() => setOpen(current => !current)}>
      工具 <span aria-hidden="true" />
    </button>
    <nav id="workspace-header-actions" className="workspace-tools-panel" aria-label="工作站工具" hidden={!open}
      onClick={event => {
        const button = event.target instanceof Element && event.target.closest('button')
        if (button && event.currentTarget.contains(button)) close()
      }}
    >{children}</nav>
  </div>
}
