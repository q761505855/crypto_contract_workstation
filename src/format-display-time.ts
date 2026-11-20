const formatters = new Map<string, Intl.DateTimeFormat>()
const localWeekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' })

/** Keep the caller's time zone, or use the browser's local time by default. */
export function formatDisplayTime(timestamp: number | null, timeZone?: string, precision: 'minute' | 'second' | 'millisecond' = 'minute'): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return '—'
  const key = `${timeZone ?? ''}:${precision}`
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
      ...(precision === 'minute' ? {} : { second: '2-digit' }),
      ...(precision === 'millisecond' ? { fractionalSecondDigits: 3 } : {}),
    })
    formatters.set(key, formatter)
  }
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}
  for (const { type, value } of formatter.formatToParts(timestamp)) parts[type] = value
  const seconds = parts.second === undefined ? '' : `:${parts.second}`
  const milliseconds = parts.fractionalSecond === undefined ? '' : `.${parts.fractionalSecond}`
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${seconds}${milliseconds} ${parts.weekday}`
}

export function localDateTimeInputValue(timestamp: number): string {
  const date = new Date(timestamp)
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function formatInputWeekday(value: string): string {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? localWeekday.format(timestamp) : ''
}
