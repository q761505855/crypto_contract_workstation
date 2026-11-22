import { resolve } from 'node:path'
import { unzipSync } from 'fflate'
import catalog from '../src/market-data/okx/instruments.json' with { type: 'json' }
import bybit from '../src/market-data/bybit/instruments.json' with { type: 'json' }
import { archiveRoot, writeTradeArchive } from './cache-bybit-day.mjs'

const hourMs = 3_600_000
const dayMs = 24 * hourMs
const timezone = 8 * hourMs
export const okxArchiveRoot = archiveRoot.replace(/bybit-trades$/, 'okx-trades')
const firstDays = new Map(Object.values(catalog).map(([symbol, , day]) => [symbol, day]))
const links = new Map()
for (const [ticker, [symbol]] of Object.entries(bybit.links)) {
  const mapped = links.get(symbol) ?? new Set()
  mapped.add(catalog[ticker]?.[0])
  links.set(symbol, mapped)
}

// A shared Bybit contract may serve several IC tickers. Delete only when all
// of those tickers resolve to the same replacement.
export function okxReplacement(symbol, day) {
  const options = links.get(symbol)
  if (options?.size !== 1) return
  const replacement = options.values().next().value
  if (replacement && day > firstDays.get(replacement)) return replacement
}

const date = time => new Date(time).toISOString().slice(0, 10)

export function okxArchiveInputs(symbol, day, now = Date.now()) {
  const start = Date.parse(day)
  if (!firstDays.has(symbol) || !/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(start) ||
      date(start) !== day || day < firstDays.get(symbol) || start + dayMs > now) {
    throw new Error('请选择支持的 OKX 品种和已经结束的 UTC 日期')
  }
  return start
}

export class OkxArchiveMissing extends Error {}

function archiveSymbols(symbol, day) {
  if (symbol !== 'XAU-USDT-SWAP' || day > '2026-01-15') return [symbol]
  if (day === '2026-01-15') return ['XAUT-USDT-SWAP', symbol]
  return ['XAUT-USDT-SWAP']
}

async function* okxRows(symbol, start, fetcher) {
  for (const sourceDay of [date(start), date(start + dayMs)]) {
    const symbols = archiveSymbols(symbol, sourceDay)
    const begin = String(Date.parse(sourceDay) - timezone)
    const query = new URLSearchParams({ module: '1', instType: 'SWAP', dateAggrType: 'daily',
      instFamilyList: symbols.map(ticker => ticker.replace(/-SWAP$/, '')).join(','), begin, end: begin })
    const response = await fetcher(`https://www.okx.com/api/v5/public/market-data-history?${query}`,
      { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`OKX 日档清单 HTTP ${response.status}`)
    const result = await response.json()
    if (result.code !== '0' || !Array.isArray(result.data)) throw new Error('OKX 日档清单无效')
    const files = result.data.flatMap(group => group.details.flatMap(item => item.groupDetails))
    for (const ticker of symbols) {
      const filename = `${ticker}-trades-${sourceDay}.zip`
      const file = files.find(item => item.filename === filename)
      if (!file) throw new OkxArchiveMissing(`OKX 未发布 ${filename}`)
      const url = new URL(file.url)
      if (url.origin !== 'https://static.okx.com' || !url.pathname.endsWith('/' + filename)) throw new Error('OKX 日档地址无效')
      const archive = await fetcher(url.href, { signal: AbortSignal.timeout(360_000) })
      if (archive.status === 404) throw new OkxArchiveMissing(`OKX 未发布 ${filename}`)
      if (!archive.ok) throw new Error(`OKX 日档 HTTP ${archive.status}`)
      const contents = unzipSync(new Uint8Array(await archive.arrayBuffer()), {
        filter: entry => entry.name.endsWith('.csv') && entry.originalSize <= 1024 ** 3,
      })
      const entries = Object.values(contents)
      if (entries.length !== 1) throw new Error('OKX 日档 ZIP 无效')
      yield* csvRows(new TextDecoder().decode(entries[0]), ticker, Number(begin), start)
    }
  }
}

function* csvRows(csv, symbol, sourceStart, start) {
  const headerEnd = csv.indexOf('\n')
  const names = csv.slice(0, headerEnd).trim().replace(/^\uFEFF/, '').split(',')
  const columns = ['instrument_name', 'trade_id', 'side', 'price', 'size', 'created_time']
    .map(name => names.findIndex(field => field === name || field.endsWith(name)))
  if (headerEnd < 0 || columns.includes(-1)) throw new Error('OKX 日档字段无效')
  let rows = 0
  for (let from = headerEnd + 1; from < csv.length;) {
    const end = csv.indexOf('\n', from)
    const line = csv.slice(from, end < 0 ? undefined : end).trim()
    from = end < 0 ? csv.length : end + 1
    if (!line) continue
    const fields = line.split(',')
    const [ticker, id, rawSide, price, size, stamp] = columns.map(index => fields[index])
    const side = { buy: 'Buy', sell: 'Sell' }[rawSide?.toLowerCase()]
    const time = Number(stamp)
    if (ticker !== symbol || !/^\d+$/.test(id) || !side || !(Number(price) > 0 && Number(size) > 0) ||
        !Number.isFinite(Number(price) * Number(size)) || !Number.isSafeInteger(time) ||
        time < sourceStart || time >= sourceStart + dayMs) throw new Error('OKX 日档成交记录无效')
    rows++
    if (time < start || time >= start + dayMs) continue
    const seconds = `${Math.floor(time / 1000)}.${String(time % 1000).padStart(3, '0')}`
    yield { hour: Math.floor((time - start) / hourMs), line: `${seconds},${id},${side},${price},${size}` }
  }
  if (!rows) throw new Error('OKX 源日档没有成交记录')
}

export function cacheOkxDay({ repository, symbol, day, fetcher = fetch, now = Date.now() }) {
  const start = okxArchiveInputs(symbol, day, now)
  return writeTradeArchive({ target: resolve(repository, okxArchiveRoot, symbol, day), symbol, day,
    allowEmpty: true, records: () => okxRows(symbol, start, fetcher) })
}

export function coveredBybitSymbols(okxSymbol, day) {
  return [...links.keys()].filter(symbol => okxReplacement(symbol, day) === okxSymbol)
}
