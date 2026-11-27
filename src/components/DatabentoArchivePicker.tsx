import { useState } from 'react'
import type { DatabentoArchive } from '../market-data/databento/files'
import './databento-archive-picker.css'

export function DatabentoArchivePicker({ entries, loadedDays, busy, onLoad }: {
  entries: readonly DatabentoArchive[]
  loadedDays: readonly string[]
  busy: boolean
  onLoad(days: readonly string[]): void
}) {
  const [changes, setChanges] = useState<Record<string, boolean>>({})
  const [browseMonth, setBrowseMonth] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')

  if (!entries.length) return null

  const months = [...new Set(entries.map(file => file.day.slice(0, 7)))].reverse()
  const month = months.includes(browseMonth) ? browseMonth : months[0]
  const hasRange = Boolean(start && end)
  const validDates = start.length === 10 && end.length === 10
  const visible = hasRange
    ? entries.filter(file => validDates && file.day >= start && file.day <= end)
    : entries.filter(file => file.day.startsWith(month))
  const rangeStatus = !hasRange ? '' : !validDates ? '请选择有效的起止日期。'
    : start > end ? '开始日期不能晚于结束日期。' : visible.length === 0 ? '区间内没有本地日档。' : ''
  const loaded = new Set(loadedDays)
  const selected = new Set(entries.filter(file => changes[file.day] ?? loaded.has(file.day)).map(file => file.day))
  const selectedInList = visible.filter(file => selected.has(file.day)).length
  const selectedOutside = selected.size - selectedInList
  const allInListSelected = visible.length > 0 && selectedInList === visible.length

  function setChecked(files: readonly DatabentoArchive[], checked: boolean) {
    setChanges(current => ({ ...current, ...Object.fromEntries(files.map(file => [file.day, checked])) }))
  }

  return <>
    <p className="okx-local-note">日档日期按 UTC 显示。</p>
    <div className="okx-local-dates databento-archive-range">
      <label>开始日期<input type="date" value={start} disabled={busy}
        onChange={event => setStart(event.target.value)} /></label>
      <label>结束日期<input type="date" value={end} disabled={busy}
        onChange={event => setEnd(event.target.value)} /></label>
      <button type="button" disabled={busy || (!start && !end)} onClick={() => {
        setStart('')
        setEnd('')
      }}>清除日期区间</button>
    </div>
    <div className="okx-local-actions databento-archive-toolbar">
      <label className="databento-archive-month">浏览月份<select value={month} disabled={busy || hasRange}
        onChange={event => setBrowseMonth(event.target.value)}>
        {months.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <label className="okx-local-archive-choice"><input type="checkbox" checked={allInListSelected}
        ref={input => { if (input) input.indeterminate = selectedInList > 0 && !allInListSelected }}
        disabled={busy || visible.length === 0}
        onChange={event => setChecked(visible, event.target.checked)} />全选当前列表</label>
      <button type="button" disabled={busy || !selected.size} onClick={() => setChecked(entries, false)}>清空选择</button>
    </div>
    {rangeStatus && <p className="okx-local-note" role="status">{rangeStatus}</p>}
    <ul key={hasRange ? `${start}:${end}` : month} aria-label="本地 DBN 文件" className="okx-local-list databento-archive-list">
      {visible.map(file => (
        <li key={file.day}>
          <label>
            <input type="checkbox" aria-label={file.day}
              disabled={busy} checked={selected.has(file.day)}
              onChange={event => setChecked([file], event.target.checked)} />
            <time dateTime={file.day}>{file.day}</time>
            <span title={file.filename}>{file.filename}</span>
          </label>
        </li>
      ))}
    </ul>
    <div className="okx-local-actions databento-archive-footer">
      <p className="okx-local-note" role="status">
        当前列表已选 {selectedInList} / {visible.length} 个日档
        {selectedOutside > 0 && `，另有 ${selectedOutside} 个已选日档在列表外`}
      </p>
      <button type="button" className="okx-local-primary" disabled={busy || (!selected.size && !loadedDays.length)}
        onClick={() => onLoad([...selected])}>{busy ? '正在加载…' : '加载所选日期'}</button>
    </div>
  </>
}
