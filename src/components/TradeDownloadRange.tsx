import { BYBIT_DAY_MS, bybitDay, bybitDayStart } from '../market-data/bybit/trades'
import './trade-download-range.css'

export interface DayDownloadSelection {
  anchor: string
  before: string
  after: string
  error?: string
}

export function resolveDayDownloadRange({ anchor, before, after }: DayDownloadSelection, today: string, lastDownloadDay = today) {
  let anchorMs: number
  try { anchorMs = bybitDayStart(anchor) }
  catch { return { error: '请选择有效的锚点日期' } }
  if (anchor > today) return { error: lastDownloadDay === today ? '锚点日期不能晚于当前 UTC 日期' : '锚点日期不能晚于今天' }
  const beforeDays = Number(before)
  const afterDays = Number(after)
  if (!before || !after || ![beforeDays, afterDays].every(days => Number.isSafeInteger(days) && days >= 0)) {
    return { error: '往前和往后天数须为大于或等于 0 的整数' }
  }
  const start = anchorMs - beforeDays * BYBIT_DAY_MS
  if (start < bybitDayStart('0000-01-01')) return { error: '往前天数超出可用日期范围' }
  const last = bybitDayStart(lastDownloadDay)
  if (start > last) return { error: '所选范围没有已结束的归档日期，请增加往前天数' }
  const requestedEnd = anchorMs + afterDays * BYBIT_DAY_MS
  const end = Math.min(requestedEnd, last)
  return { start: bybitDay(start), end: bybitDay(end), clipped: requestedEnd > end }
}

export function TradeDownloadRange({ selection, onChange, today, lastDownloadDay = today, disabled = false,
  rangeLabel = '下载范围' }: {
  selection: DayDownloadSelection
  onChange(selection: DayDownloadSelection): void
  today: string
  lastDownloadDay?: string
  disabled?: boolean
  rangeLabel?: string
}) {
  const preview = resolveDayDownloadRange(selection, today, lastDownloadDay)
  return <>
    <div className="trade-range-fields">
      <label>锚点日期<input type="date" value={selection.anchor} max={today} required disabled={disabled}
        onChange={event => onChange({ ...selection, anchor: event.target.value, error: undefined })} /></label>
      <label>往前天数<input type="number" min="0" step="1" value={selection.before} required disabled={disabled}
        onChange={event => onChange({ ...selection, before: event.target.value, error: undefined })} /></label>
      <label>往后天数<input type="number" min="0" step="1" value={selection.after} required disabled={disabled}
        onChange={event => onChange({ ...selection, after: event.target.value, error: undefined })} /></label>
    </div>
    {preview.start && <p className="trade-range-summary">
      <span>{rangeLabel}</span><strong>{preview.start === preview.end ? preview.start : `${preview.start} 至 ${preview.end}`}</strong>
      {preview.clipped && <small>{lastDownloadDay === today ? '未来日期已跳过' : '未结束的日期已跳过'}</small>}
    </p>}
  </>
}
