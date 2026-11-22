import { LineType } from 'klinecharts'
import type { DrawingChange, DrawingSelection } from './drawing-overlays'
import './drawing-selection-toolbar.css'

function colorInputValue(color: string): string {
  const hex = /^#([\da-f]{6})(?:[\da-f]{2})?$/i.exec(color)
  if (hex) return `#${hex[1]}`
  const short = /^#([\da-f])([\da-f])([\da-f])[\da-f]?$/i.exec(color)
  if (short) return `#${short.slice(1).map(channel => channel.repeat(2)).join('')}`
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color)
  return rgb ? `#${rgb.slice(1).map(channel => Math.min(255, Number(channel)).toString(16).padStart(2, '0')).join('')}` : '#1677ff'
}

export function DrawingSelectionToolbar({ selection, onChange, onDelete }: {
  selection: DrawingSelection
  onChange: (change: DrawingChange) => void
  onDelete: () => void
}) {
  const widths = [1, 2, 3, 4]
  if (!widths.includes(selection.width)) widths.push(selection.width)
  const locked = selection.locked || selection.allLocked
  const lockLabel = locked ? '解锁绘图' : '锁定绘图'
  return <div className="drawing-selection-toolbar" role="group" aria-label="选中绘图控制栏">
    <input type="color" title="绘图颜色" aria-label="绘图颜色" value={colorInputValue(selection.color)}
      onInput={event => onChange({ color: event.currentTarget.value })} />
    <select title="绘图线宽" aria-label="绘图线宽" value={selection.width}
      onChange={event => onChange({ width: Number(event.target.value) })}>
      {widths.map(width => <option value={width} key={width}>{width} px</option>)}
    </select>
    <select title="绘图线型" aria-label="绘图线型" value={selection.pattern}
      onChange={event => onChange({ pattern: event.target.value === LineType.Dashed ? LineType.Dashed : LineType.Solid })}>
      <option value={LineType.Solid}>实线</option>
      <option value={LineType.Dashed}>虚线</option>
    </select>
    <button type="button" aria-label={lockLabel} title={selection.allLocked ? '请先关闭绘图侧栏的全部锁定' : lockLabel}
      disabled={selection.allLocked} onClick={() => onChange({ locked: !selection.locked })}>
      {locked ? '解锁' : '锁定'}
    </button>
    <button type="button" aria-label="删除绘图" onClick={onDelete}>删除</button>
  </div>
}
