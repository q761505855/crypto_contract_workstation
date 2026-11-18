import { useState } from 'react'
import { WorkspaceDialog } from './WorkspaceDialog'
import { formatInputWeekday, localDateTimeInputValue } from '../format-display-time'

interface TimeJumpControlProps {
  compact?: boolean
  disabled?: boolean
  onJump: (timestamp: number) => void
  onLocateLatest: () => void
}

export function TimeJumpControl({
  compact = false,
  disabled = false,
  onJump,
  onLocateLatest,
}: TimeJumpControlProps) {
  const [open, setOpen] = useState(false)
  const [timeText, setTimeText] = useState(() => localDateTimeInputValue(Date.now()))
  const timestamp = new Date(timeText).getTime()
  const valid = Number.isFinite(timestamp)
  const timeLabel = `图表时间 ${formatInputWeekday(timeText)}`.trim()

  if (compact) return <div className="time-jump-entry">
    <button type="button" disabled={disabled} onClick={() => setOpen(true)}>时间定位</button>
    <button type="button" disabled={disabled} onClick={onLocateLatest}>定位最新</button>
    <WorkspaceDialog open={open} title="图表时间定位" onClose={() => setOpen(false)}>
      <label className="panel-field">{timeLabel}<input aria-label="图表跳转时间" value={timeText} onChange={event => setTimeText(event.target.value)} type="datetime-local" /></label>
      <button type="button" className="dialog-done" disabled={disabled || !valid} onClick={() => { onJump(timestamp); setOpen(false) }}>跳转</button>
    </WorkspaceDialog>
  </div>

  return (
    <div className="time-jump-control">
      <label>
        {timeLabel}
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
