import { useEffect, useRef, useState } from 'react'
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
  const [locateDate, setLocateDate] = useState('')
  const [location, setLocation] = useState<{ day: string }>()
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const locatedCheckbox = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const checkbox = locatedCheckbox.current
    if (!location || !checkbox) return
    checkbox.scrollIntoView({ block: 'center', inline: 'nearest' })
    checkbox.focus({ preventScroll: true })
  }, [location])

  if (!entries.length) return null

  const months = [...new Set(entries.map(file => file.day.slice(0, 7)))].reverse()
  const month = months.includes(browseMonth) ? browseMonth : months[0]
  const visible = entries.filter(file => file.day.startsWith(month))
  const loaded = new Set(loadedDays)
  const selected = new Set(entries.filter(file => changes[file.day] ?? loaded.has(file.day)).map(file => file.day))
  const completeRange = Boolean(start && end)
  const validDates = start.length === 10 && end.length === 10
  const matching = validDates ? entries.filter(file => file.day >= start && file.day <= end) : []
  const rangeStatus = !completeRange ? '' : !validDates ? '请选择有效的起止日期。'
    : start > end ? '开始日期不能晚于结束日期。' : matching.length === 0 ? '区间内没有本地日档。'
      : `区间内有 ${matching.length} 个日档。选中后会替换当前勾选。`
  const located = location && entries.some(file => file.day === location.day)

  function replaceSelection(files: readonly DatabentoArchive[]) {
    const days = new Set(files.map(file => file.day))
    setChanges(Object.fromEntries(entries.map(file => [file.day, days.has(file.day)])))
  }

  return <>
    <p className="okx-local-note">日档日期按 UTC 显示。</p>
    <form className="okx-local-dates databento-archive-form" onSubmit={event => {
      event.preventDefault()
      if (busy || !locateDate) return
      const targetMonth = locateDate.slice(0, 7)
      if (months.includes(targetMonth)) setBrowseMonth(targetMonth)
      setLocation({ day: locateDate })
    }}>
      <label>定位日期<input type="date" required value={locateDate} disabled={busy} onChange={event => {
        setLocateDate(event.target.value)
        setLocation(undefined)
      }} /></label>
      <button type="submit" disabled={busy || !locateDate}>定位</button>
      {location && !located && <p className="okx-local-note" role="status">{location.day} 没有本地日档。</p>}
    </form>
    <form className="okx-local-dates databento-archive-form databento-archive-range" onSubmit={event => {
      event.preventDefault()
      if (busy || !matching.length) return
      replaceSelection(matching)
      setBrowseMonth(matching[0].day.slice(0, 7))
      setLocation(undefined)
    }}>
      <label>开始日期<input type="date" required value={start} disabled={busy}
        onChange={event => setStart(event.target.value)} /></label>
      <label>结束日期<input type="date" required value={end} disabled={busy}
        onChange={event => setEnd(event.target.value)} /></label>
      <button type="submit" disabled={busy || !matching.length}>选中此区间</button>
      {rangeStatus && <p className="okx-local-note" role="status">{rangeStatus}</p>}
    </form>
    <div className="okx-local-actions databento-archive-toolbar">
      <label className="databento-archive-month">浏览月份<select value={month} disabled={busy} onChange={event => {
        setBrowseMonth(event.target.value)
        setLocation(undefined)
      }}>
        {months.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <label className="okx-local-archive-choice"><input type="checkbox" checked={selected.size === entries.length}
        disabled={busy} onChange={event => replaceSelection(event.target.checked ? entries : [])} />全选日期</label>
      <button type="button" disabled={busy || !selected.size} onClick={() => replaceSelection([])}>清空选择</button>
    </div>
    <ul key={month} aria-label="本地 DBN 文件" className="okx-local-list databento-archive-list">
      {visible.map(file => {
        const highlighted = file.day === location?.day
        return <li key={file.day} data-located={highlighted || undefined}>
          <label>
            <input type="checkbox" aria-label={file.day} ref={highlighted ? locatedCheckbox : undefined}
              disabled={busy} checked={selected.has(file.day)}
              onChange={event => {
                const { checked } = event.target
                setChanges(current => ({ ...current, [file.day]: checked }))
              }} />
            <time dateTime={file.day}>{file.day}</time>
            <span title={file.filename}>{file.filename}</span>
          </label>
        </li>
      })}
    </ul>
    <div className="okx-local-actions databento-archive-footer">
      <p className="okx-local-note" role="status">已选 {selected.size} / {entries.length} 个日档</p>
      <button type="button" className="okx-local-primary" disabled={busy || (!selected.size && !loadedDays.length)}
        onClick={() => onLoad([...selected])}>{busy ? '正在加载…' : '加载所选日期'}</button>
    </div>
  </>
}
