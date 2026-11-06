import { useState } from 'react'
import { WorkspaceDialog } from './WorkspaceDialog'

interface TimeJumpControlProps {
  compact?: boolean
  disabled?: boolean
  onJump: (timestamp: number) => void
  onLocateLatest: () => void
}

function inputDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const localTimestamp = timestamp - date.getTimezoneOffset() * 60_000
  return new Date(localTimestamp).toISOString().slice(0, 16)
}

export function TimeJumpControl({
  compact = false,
  disabled = false,
  onJump,
  onLocateLatest,
}: TimeJumpControlProps) {
  const [open, setOpen] = useState(false)
  const [timeText, setTimeText] = useState(() => inputDateTime(Date.now()))
  const timestamp = new Date(timeText).getTime()
  const valid = Number.isFinite(timestamp)

  if (compact) return <div className="time-jump-entry">
    <button type="button" disabled={disabled} onClick={() => setOpen(true)}>时间定位</button>
    <button type="button" disabled={disabled} onClick={onLocateLatest}>定位最新</button>
    <WorkspaceDialog open={open} title="图表时间定位" onClose={() => setOpen(false)}>
      <label className="panel-field">图表时间<input aria-label="图表跳转时间" value={timeText} onChange={event => setTimeText(event.target.value)} type="datetime-local" /></label>
      <button type="button" className="dialog-done" disabled={disabled || !valid} onClick={() => { onJump(timestamp); setOpen(false) }}>跳转</button>
    </WorkspaceDialog>
  </div>

  return (
    <div className="time-jump-control">
      <label>
        图表时间
        <input
          aria-label="图表跳转时间"
          onChange={(event) => setTimeText(event.target.value)}
          type="datetime-local"
          value={timeText}
        />
      </label>
      <button
        disabled={disabled || !valid}
        onClick={() => onJump(timestamp)}
        type="button"
      >
        跳转
      </button>
      <button disabled={disabled} onClick={onLocateLatest} type="button">
        定位最新
      </button>
    </div>
  )
}
