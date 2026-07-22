export type WorkstationMode = 'history' | 'live'

interface ModeSwitchProps {
  mode: WorkstationMode
  onChange: (mode: WorkstationMode) => void
}

export function ModeSwitch({ mode, onChange }: ModeSwitchProps) {
  return (
    <div className="mode-switch" aria-label="工作模式">
      <button
        aria-pressed={mode === 'history'}
        onClick={() => onChange('history')}
        type="button"
      >
        历史模拟
      </button>
      <button
        aria-pressed={mode === 'live'}
        onClick={() => onChange('live')}
        type="button"
      >
        实时行情
      </button>
    </div>
  )
}
