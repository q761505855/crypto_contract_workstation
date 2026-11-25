import { BYBIT_DAY_MS as DAY, bybitDay } from '../bybit/trades'

const chicago = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'longOffset' })
const boundaries = new Map<number, number>()

function eveningBoundary(utcMidnight: number): number {
  const known = boundaries.get(utcMidnight)
  if (known !== undefined) return known
  const offset = chicago.formatToParts(utcMidnight + 17 * 3_600_000).find(part => part.type === 'timeZoneName')?.value
  const hours = offset === 'GMT-05:00' ? 22 : 23
  const result = utcMidnight + hours * 3_600_000
  boundaries.set(utcMidnight, result)
  return result
}

export function cmeTradingDay(timestamp: number): string {
  const midnight = Math.floor(timestamp / DAY) * DAY
  return bybitDay(timestamp < eveningBoundary(midnight) ? midnight : midnight + DAY)
}

export function cmeTradingBounds(day: string): { from: number; to: number } {
  const midnight = Date.parse(day)
  return { from: eveningBoundary(midnight - DAY), to: eveningBoundary(midnight) }
}

export function previousCmeTradingDay(day: string): string {
  let midnight = Date.parse(day) - DAY
  while ([0, 6].includes(new Date(midnight).getUTCDay())) midnight -= DAY
  return bybitDay(midnight)
}

const contractMonth = 'FGHJKMNQUVXZ'

export function nearestContract(contracts: Iterable<string>, day: string): string | undefined {
  const year = Number(day.slice(0, 4))
  const month = Number(day.slice(5, 7)) - 1
  let nearest: string | undefined
  let earliest = Infinity
  for (const contract of contracts) {
    const suffix = /([FGHJKMNQUVXZ])(\d{1,4})$/.exec(contract)
    if (!suffix) continue
    const expiryMonth = contractMonth.indexOf(suffix[1])
    const modulus = 10 ** suffix[2].length
    let expiryYear = year - year % modulus + Number(suffix[2])
    if (expiryYear < year) expiryYear += modulus
    // Archives typically list several years ahead. Ignore expired months in the current year.
    if (expiryYear === year && expiryMonth < month) continue
    const expiry = expiryYear * 12 + expiryMonth
    if (expiry >= earliest) continue
    earliest = expiry
    nearest = contract
  }
  return nearest
}
