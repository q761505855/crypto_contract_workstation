import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import { strToU8, zipSync } from 'fflate'

const MINUTE = 60_000
const DAY = 86_400_000

export interface ArchiveFixtureOptions {
  day?: number
  price?: number
  flat?: boolean
  trend?: boolean
}

export function fixtureMinutePrices(openTime: number, options: ArchiveFixtureOptions = {}): [string, string, string, string] {
  const scale = (options.price ?? 60_000) / 60_000
  const offset = options.flat ? 0 : (openTime / MINUTE) % 200
  const open = options.trend
    ? (60_000 + Math.sin(openTime / MINUTE / 75) * 2_000) * scale
    : (60_000 + offset) * scale
  const close = options.trend
    ? (60_000 + Math.sin((openTime + MINUTE) / MINUTE / 75) * 2_000) * scale
    : options.flat ? open : open + Math.sin(offset) * 20 * scale
  const padding = (options.flat ? 10 : 12) * scale
  return [open.toFixed(2), (Math.max(open, close) + padding).toFixed(2),
    (Math.min(open, close) - padding).toFixed(2), close.toFixed(2)]
}

/** A complete, checksum-verified official-format 1m month or day archive. */
export function createBinanceArchiveFixture(
  symbol: string,
  year: number,
  month: number,
  options: ArchiveFixtureOptions = {},
): { zip: Buffer; checksum: string; from: number; to: number; minuteCount: number } {
  const from = Date.UTC(year, month - 1, options.day ?? 1)
  const to = options.day === undefined ? Date.UTC(year, month, 1) : from + DAY
  const date = `${year}-${String(month).padStart(2, '0')}${options.day === undefined ? '' : `-${String(options.day).padStart(2, '0')}`}`
  const basename = `${symbol}-1m-${date}`
  const rows = ['open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore']
  for (let openTime = from; openTime < to; openTime += MINUTE) {
    rows.push([
      openTime, ...fixtureMinutePrices(openTime, options), '100.5',
      openTime + MINUTE - 1, '6030000', 100, '0', '0', '0',
    ].join(','))
  }
  const zip = Buffer.from(zipSync({ [`${basename}.csv`]: strToU8(`${rows.join('\n')}\n`) }, { level: 1 }))
  return {
    zip, checksum: `${createHash('sha256').update(zip).digest('hex')}  ${basename}.zip\n`,
    from, to, minuteCount: (to - from) / MINUTE,
  }
}

/** Serve completed archives and leave the browser's current day/month to REST. */
export async function installArchiveFixtures(
  page: Page,
  symbolPrices: Record<string, number> = {},
  options: { flat?: boolean; trend?: boolean; now?: number } = {},
): Promise<{ requests: string[] }> {
  const requests: string[] = []
  const cache = new Map<string, ReturnType<typeof createBinanceArchiveFixture>>()
  await page.route('https://data.binance.vision/**', async (route) => {
    const url = new URL(route.request().url())
    requests.push(url.href)
    const match = /^\/data\/futures\/um\/(monthly|daily)\/(klines|markPriceKlines)\/([A-Z0-9]+)\/1m\/([A-Z0-9]+)-1m-(\d{4})-(\d{2})(?:-(\d{2}))?\.zip(\.CHECKSUM)?$/.exec(url.pathname)
    const notFound = () => route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'Not Found' })
    if (!match || match[3] !== match[4] || (match[1] === 'daily') !== (match[7] !== undefined)) {
      await notFound()
      return
    }
    const [, frequency, , symbol, , yearText, monthText, dayText, checksum] = match
    const year = Number(yearText)
    const month = Number(monthText)
    const day = dayText === undefined ? undefined : Number(dayText)
    const from = Date.UTC(year, month - 1, day ?? 1)
    let now: number
    try {
      now = options.now ?? await page.evaluate(() => Date.now())
    } catch (error) {
      // A reload cancels old document requests while installing a new clock.
      // Abort that route instead of guessing the new document's current time.
      if (/Execution context was destroyed|Cannot find context|Target page, context or browser has been closed/.test(String(error))) {
        await route.abort('aborted').catch(() => undefined)
        return
      }
      throw error
    }
    const currentMonth = new Date(now)
    const boundary = frequency === 'monthly'
      ? Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth(), 1)
      : Math.floor(now / DAY) * DAY
    if (from >= boundary) {
      await notFound()
      return
    }
    const key = `${symbol}/${year}/${month}/${day ?? ''}`
    let fixture = cache.get(key)
    if (!fixture) {
      fixture = createBinanceArchiveFixture(symbol, year, month, { day, price: symbolPrices[symbol], flat: options.flat, trend: options.trend })
      cache.set(key, fixture)
    }
    await route.fulfill({
      contentType: checksum ? 'text/plain' : 'application/zip',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: checksum ? fixture.checksum : fixture.zip,
    })
  })
  return { requests }
}

export const mockBinanceArchives = installArchiveFixtures
