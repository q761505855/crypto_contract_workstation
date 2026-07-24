import { useState } from 'react'

interface TimeJumpControlProps {
  disabled?: boolean
  onJump: (timestamp: number) => void
}

function inputDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const localTimestamp = timestamp - date.getTimezoneOffset() * 60_000
  return new Date(localTimestamp).toISOString().slice(0, 16)
}

export function TimeJumpControl({
  disabled = false,
  onJump,
}: TimeJumpControlProps) {
  const [timeText, setTimeText] = useState(() => inputDateTime(Date.now()))
  const timestamp = new Date(timeText).getTime()
  const valid = Number.isFinite(timestamp)

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
    </div>
  )
}
