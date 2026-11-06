export function PanelToggle({ label, expanded, onToggle, controls, direction = 'up', showLabel = false, className = '' }: {
  label: string
  expanded: boolean
  onToggle(): void
  controls: string
  direction?: 'up' | 'down' | 'right'
  showLabel?: boolean
  className?: string
}) {
  const action = `${expanded ? '收起' : '展开'}${label}`
  return <button type="button" className={`panel-toggle ${className}`} aria-label={action} aria-expanded={expanded} aria-controls={controls} title={action} data-direction={direction} data-expanded={expanded} onClick={onToggle}>
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m6 9 6 6 6-6" /></svg>
    {showLabel && <span className="panel-toggle-label">{label}</span>}
  </button>
}
