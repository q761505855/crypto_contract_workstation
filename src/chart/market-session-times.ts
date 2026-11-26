import { nextOpenTime } from '../market-data/intervals'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export const MARKET_SESSIONS = 'MARKET_SESSIONS'

export function isMarketSessionTimeframe(timeframe: string): boolean {
  return /[mh]$/.test(timeframe)
}

export function marketSessionReference(lastOpen: number, knownUntil: number, timeframe: string): number {
  const reference = Math.max(lastOpen, Math.min(knownUntil, nextOpenTime(lastOpen, timeframe)))
  return Math.floor(reference / MINUTE) * MINUTE
}
export function normalizeMarketSessionParams(params: unknown[]): [] {
  if (params.length === 0 || (params.length === 2 && params.every(value =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1440))) {
    return []
  }
  throw new Error(`${MARKET_SESSIONS}.calcParams 无效`)
}

export type MarketId = 'tokyo' | 'london' | 'newYork'
export const SESSION_MARKETS = {
  tokyo: { name: '东京', index: 0 },
  london: { name: '伦敦', index: 1 },
  newYork: { name: '纽约', index: 2 },
} as const

export type MarketSessionVisibility = readonly [boolean, boolean, boolean]
export const DEFAULT_MARKET_SESSION_VISIBILITY: MarketSessionVisibility = [true, true, true]
type MarketCalendar = {
  id: MarketId
  timezone: string
  open: number
  close: number
  midday: readonly [number, number]
  closed: ReadonlySet<string>
  earlyClose?: { minute: number; dates: ReadonlySet<string> }
}

function dates(year: number, monthDays: string): string[] {
  return monthDays.split(' ').map(date => `${year}-${date}`)
}

const markets: MarketCalendar[] = [
  {
    id: 'tokyo', timezone: 'Asia/Tokyo', open: 9 * 60, close: 15 * 60 + 30,
    midday: [11 * 60 + 30, 12 * 60 + 30],
    // https://www.jpx.co.jp/english/corporate/about-jpx/calendar/
    closed: new Set([
      ...dates(2026, '01-01 01-02 01-12 02-11 02-23 03-20 04-29 05-04 05-05 05-06 07-20 08-11 09-21 09-22 09-23 10-12 11-03 11-23 12-31'),
      ...dates(2027, '01-01 01-11 02-11 02-23 03-22 04-29 05-03 05-04 05-05 07-19 08-11 09-20 09-23 10-11 11-03 11-23 12-31'),
    ]),
  },
  {
    id: 'london', timezone: 'Europe/London', open: 8 * 60, close: 16 * 60 + 30,
    midday: [12 * 60, 14 * 60],
    // https://www.londonstockexchange.com/en/resources/markets-products/business-days
    closed: new Set([
      ...dates(2026, '01-01 04-03 04-06 05-04 05-25 08-31 12-25 12-28'),
      ...dates(2027, '01-01 03-26 03-29 05-03 05-31 08-30 12-27 12-28'),
      ...dates(2028, '01-03 04-14 04-17 05-01 05-29 08-28 12-25 12-26'),
    ]),
    earlyClose: { minute: 12 * 60 + 30, dates: new Set(['2026-12-24', '2026-12-31', '2027-12-24', '2027-12-31', '2028-12-22', '2028-12-29']) },
  },
  {
    id: 'newYork', timezone: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60,
    midday: [12 * 60, 14 * 60],
    // https://www.nyse.com/trade/hours-calendars
    closed: new Set([
      ...dates(2026, '01-01 01-19 02-16 04-03 05-25 06-19 07-03 09-07 11-26 12-25'),
      ...dates(2027, '01-01 01-18 02-15 03-26 05-31 06-18 07-05 09-06 11-25 12-24'),
      ...dates(2028, '01-17 02-21 04-14 05-29 06-19 07-04 09-04 11-23 12-25'),
    ]),
    earlyClose: { minute: 13 * 60, dates: new Set(['2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']) },
  },
]

const offsetFormatters = new Map(markets.map(({ timezone }) => [
  timezone, new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }),
]))

function offsetMinutes(timezone: string, day: number): number {
  // All listed markets change the clock on non-trading days. Sample UTC noon on the local date.
  const offset = offsetFormatters.get(timezone)!.formatToParts(day + DAY / 2)
    .find(part => part.type === 'timeZoneName')!.value
  if (offset === 'GMT') return 0
  return (offset[3] === '-' ? -1 : 1) * (Number(offset.slice(4, 6)) * 60 + Number(offset.slice(7, 9)))
}

export interface MarketSessionWindow {
  market: MarketId
  open: number
  close: number
  midday: readonly [number, number] | null
  closed: '周末休市' | '节假日休市' | null
}
const dayCache = new Map<number, MarketSessionWindow[]>()
const extendedTokyoClose = Date.UTC(2024, 10, 5)

function sessionsOn(day: number): MarketSessionWindow[] {
  const cached = dayCache.get(day)
  if (cached) return cached
  // UTC midnight here represents a calendar date in each exchange's own time zone.
  const localDate = new Date(day)
  const weekday = localDate.getUTCDay()
  const dateKey = localDate.toISOString().slice(0, 10)
  const result = markets.map((market): MarketSessionWindow => {
    const holiday = market.closed.has(dateKey) || (market.id === 'tokyo' && /-(01-0[1-3]|12-31)$/.test(dateKey))
    const closed = weekday === 0 || weekday === 6 ? '周末休市' : holiday ? '节假日休市' : null
    const localMidnight = day - offsetMinutes(market.timezone, day) * MINUTE
    const atLocalMinute = (minutes: number) => localMidnight + minutes * MINUTE
    let close = market.id === 'tokyo' && day < extendedTokyoClose ? 15 * 60 : market.close
    if (!closed && market.earlyClose?.dates.has(dateKey)) close = market.earlyClose.minute
    const [middayStart, middayEnd] = market.midday
    return {
      market: market.id,
      open: atLocalMinute(market.open),
      close: atLocalMinute(close),
      midday: !closed && middayStart > market.open && middayEnd < close
        ? [atLocalMinute(middayStart), atLocalMinute(middayEnd)]
        : null,
      closed,
    }
  })
  if (dayCache.size >= 2048) dayCache.delete(dayCache.keys().next().value!)
  dayCache.set(day, result)
  return result
}

export function marketSessionWindows(from: number, to: number): MarketSessionWindow[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return []
  const windows: MarketSessionWindow[] = []
  // Exchange-local dates can lie on either side of UTC midnight.
  const firstDate = Math.floor((from - DAY) / DAY) * DAY
  const lastDate = Math.floor((to + DAY) / DAY) * DAY
  for (let day = firstDate; day <= lastDate; day += DAY) {
    for (const session of sessionsOn(day)) {
      if (session.close > from && session.open <= to) windows.push(session)
    }
  }
  return windows
}

export function marketSessionForecast(reference: number, visibility = DEFAULT_MARKET_SESSION_VISIBILITY) {
  const oneDayLater = reference + DAY
  const sessions = marketSessionWindows(reference, oneDayLater)
    .filter(session => session.open > reference && visibility[SESSION_MARKETS[session.market].index])
  return {
    sessions,
    end: Math.max(oneDayLater, ...sessions.map(session => session.close)),
  }
}
