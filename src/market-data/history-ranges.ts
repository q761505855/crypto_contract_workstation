const MINUTE = 60_000

function validTimestamp(timestamp: number): boolean {
  return Number.isFinite(timestamp) && timestamp >= 0 && !Number.isNaN(new Date(timestamp).getTime())
}

function validateRange(from: number, to: number): void {
  if (!validTimestamp(from) || !validTimestamp(to) || from > to) {
    throw new Error('历史行情时间范围无效')
  }
}

function monthStart(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

function nextMonth(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

/** Expand a request to UTC months; both returned bounds are inclusive minute opens. */
export function expandHistoryRange(
  from: number,
  to: number,
  now = Date.now(),
  onboardDate = 0,
): { from: number; to: number } {
  validateRange(from, to)
  if (!validTimestamp(now) || !validTimestamp(onboardDate)) {
    throw new Error('当前时间或上市时间无效')
  }
  const expandedFrom = Math.max(monthStart(from), Math.ceil(onboardDate / MINUTE) * MINUTE)
  const expandedTo = Math.min(nextMonth(to) - MINUTE, Math.floor(now / MINUTE) * MINUTE - MINUTE)
  if (expandedFrom > expandedTo || !validTimestamp(expandedTo)) {
    throw new Error('所选范围内没有已结束的分钟行情')
  }
  return { from: expandedFrom, to: expandedTo }
}

/** Split an inclusive range of minute opens into clipped UTC calendar months. */
export function historyMonths(
  from: number,
  to: number,
): Array<{ year: number; month: number; from: number; to: number }> {
  validateRange(from, to)
  const first = Math.ceil(from / MINUTE) * MINUTE
  const last = Math.floor(to / MINUTE) * MINUTE
  if (first > last) return []
  const result: Array<{ year: number; month: number; from: number; to: number }> = []
  for (let start = monthStart(first); start <= last; start = nextMonth(start)) {
    const date = new Date(start)
    result.push({
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
      from: Math.max(first, start), to: Math.min(last, nextMonth(start) - MINUTE),
    })
  }
  return result
}
