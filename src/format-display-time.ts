const formatters = new Map<string | undefined, Intl.DateTimeFormat>()
const localWeekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' })

/** Keep the caller's time zone, or use the browser's local time by default. */
export function formatDisplayTime(timestamp: number | null, timeZone?: string): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return '—'
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
    })
    formatters.set(timeZone, formatter)
  }
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}
  for (const { type, value } of formatter.formatToParts(timestamp)) parts[type] = value
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.weekday}`
}

export function localDateTimeInputValue(timestamp: number): string {
  const date = new Date(timestamp)
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function formatInputWeekday(value: string): string {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? localWeekday.format(timestamp) : ''
}
