import { BYBIT_HOUR_MS, type BybitTrade } from '../bybit/trades'
import { compareTrades, okxTrade, type OkxInstrument } from './trades'

const subscribedChannel = 'trades-all'
const liveLimit = 150_000
const pageSpacing = 125
const maxInFlight = 4
const minParallelRangeUs = BYBIT_HOUR_MS * 1000 / 4
const historyRequestKey = 'crypto-contract-workstation:okx-history-request-at'
const inFlight = new Set<Promise<void>>()
let nextRequest = 0
let requestQueue = Promise.resolve()

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}

async function withHistoryRequestLock<T>(action: (shared: boolean) => T, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const locks = globalThis.navigator?.locks
  return locks ? locks.request(historyRequestKey, { signal }, () => action(true)) : action(false)
}

function historyRequestAt(shared: boolean): number {
  if (shared) {
    try {
      const stored = Number(localStorage.getItem(historyRequestKey))
      if (Number.isFinite(stored)) return Math.max(stored, nextRequest)
    } catch { /* The in-page schedule also works without browser storage. */ }
  }
  return nextRequest
}

function setHistoryRequestAt(time: number, shared: boolean): void {
  nextRequest = time
  if (shared) {
    try { localStorage.setItem(historyRequestKey, String(time)) }
    catch { /* Keep the schedule in memory if browser storage is unavailable. */ }
  }
}

const historyClock = () => performance.timeOrigin + performance.now()

function scheduleHistoryRequest<T>(send: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let result: Promise<T>
  const scheduled = requestQueue.then(async () => {
    signal.throwIfAborted()
    if (inFlight.size >= maxInFlight) await Promise.race(inFlight)
    for (;;) {
      const wait = await withHistoryRequestLock(shared => {
        signal.throwIfAborted()
        const now = historyClock()
        const delay = historyRequestAt(shared) - now
        if (delay > 0) return delay
        // Start the fetch under the lock and release it before awaiting the response.
        result = send()
        setHistoryRequestAt(historyClock() + pageSpacing, shared)
        const settled = result.then(() => {}, () => {}).finally(() => inFlight.delete(settled))
        inFlight.add(settled)
        return 0
      }, signal)
      if (wait === 0) return
      await sleep(Math.ceil(wait), signal)
    }
  })
  requestQueue = scheduled.catch(() => {})
  return scheduled.then(() => result)
}

interface OkxRow { instId: string; tradeId: string; ts: string; px: string; sz: string; side: string }
export interface OkxTradePage { fromUs: number; untilUs: number; rows: BybitTrade[] }
function rowTrade(instrument: OkxInstrument, row: OkxRow): BybitTrade {
  if (row?.instId !== instrument.symbol) throw new Error('OKX 逐笔成交品种无效')
  return okxTrade(instrument, row.ts, row.tradeId, row.side, row.px, row.sz)
}

async function requestTradePage(instrument: OkxInstrument, params: Record<string, string>, signal: AbortSignal,
  fetcher: typeof fetch): Promise<BybitTrade[]> {
  const query = new URLSearchParams({ instId: instrument.symbol, limit: '100', ...params })
  for (const cooldown of [2000, 4000, 8000]) {
    const rows = await scheduleHistoryRequest(async () => {
      const response = await fetcher.call(globalThis, `https://www.okx.com/api/v5/market/history-trades?${query}`,
        { credentials: 'omit', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
      const result = response.ok ? await response.json() : null
      if (response.status === 429 || result?.code === '50011') {
        const header = response.headers.get('Retry-After')
        const seconds = Number(header)
        const retryDelay = header && !Number.isFinite(seconds) ? Date.parse(header) - Date.now() : seconds * 1000
        await withHistoryRequestLock(shared => {
          const until = historyClock() + Math.max(cooldown, Number.isFinite(retryDelay) ? retryDelay : 0)
          setHistoryRequestAt(Math.max(until, historyRequestAt(shared)), shared)
        }, signal)
        return null
      }
      if (!response.ok) throw new Error(`读取 OKX 历史逐笔失败（HTTP ${response.status}）`)
      if (result?.code !== '0' || !Array.isArray(result.data)) throw new Error('读取 OKX 历史逐笔失败')
      return result.data.map((row: OkxRow) => rowTrade(instrument, row)).sort(compareTrades)
    }, signal)
    if (rows !== null) return rows
  }
  throw new Error('OKX 历史逐笔接口仍在限流，请稍后重试')
}

/** Keep the boundary millisecond pending until all of its trade IDs have arrived. */
export async function* readOkxTradePages(instrument: OkxInstrument, fromUs: number, untilUs: number, signal: AbortSignal,
  fetcher: typeof fetch = fetch): AsyncGenerator<OkxTradePage> {
  if (fromUs >= untilUs) return
  let after = String(Math.ceil(untilUs / 1000))
  let type = '2'
  let edge: BybitTrade[] = []
  let cursor = untilUs
  for (;;) {
    const rows = await requestTradePage(instrument, { after, type }, signal, fetcher)
    const oldest = rows[0]
    const done = rows.length < 100 || oldest.timeUs < fromUs
    const start = done ? fromUs : oldest.timeUs + 1000
    const merged = new Map(rows.concat(edge).filter(trade => trade.timeUs >= fromUs && trade.timeUs < cursor)
      .map(trade => [trade.id, trade]))
    const ordered = [...merged.values()].sort(compareTrades)
    edge = ordered.filter(trade => trade.timeUs < start)
    if (start < cursor) yield { fromUs: start, untilUs: cursor, rows: ordered.filter(trade => trade.timeUs >= start) }
    if (done) break
    if (type === '1' && BigInt(oldest.id) >= BigInt(after)) throw new Error('OKX 历史逐笔分页未推进')
    cursor = Math.min(cursor, start)
    after = oldest.id
    type = '1'
  }
}

export async function* readOkxTradePagesForward(instrument: OkxInstrument, fromUs: number, untilUs: number, signal: AbortSignal,
  fetcher: typeof fetch = fetch): AsyncGenerator<OkxTradePage> {
  if (fromUs >= untilUs) return
  const tradeBefore = async (timeUs: number) => (await requestTradePage(instrument,
    { type: '2', after: String(Math.ceil(timeUs / 1000)), limit: '1' }, signal, fetcher))[0]
  const start = await tradeBefore(fromUs)
  const last = await tradeBefore(untilUs)
  if (!last || last.id === start?.id) {
    yield { fromUs, untilUs, rows: [] }
    return
  }
  if (!start) {
    // A newly listed instrument may have no preceding trade from which to get an ID.
    for (let from = fromUs; from < untilUs; from += 60_000_000) {
      yield* readOkxTradePages(instrument, from, Math.min(from + 60_000_000, untilUs), signal, fetcher)
    }
    return
  }

  const lastId = BigInt(last.id)
  let before = BigInt(start.id)
  let width = 101n
  let edge: BybitTrade[] = []
  let cursor = fromUs
  while (before < lastId) {
    const after = before + width <= lastId ? before + width : lastId + 1n
    // With only `before`, OKX can return the latest page rather than the next one.
    const rows = await requestTradePage(instrument, { type: '1', before: String(before), after: String(after) }, signal, fetcher)
    if (rows.some(trade => BigInt(trade.id) <= before || BigInt(trade.id) >= after)) throw new Error('OKX 历史逐笔分页超出边界')
    if (rows.length >= 100 && after - before > 101n) {
      width = (after - before) / 2n
      continue
    }
    const newest = rows.at(-1)
    const end = Math.max(cursor, Math.min(newest?.timeUs ?? cursor, untilUs))
    const points = edge.concat(rows.filter(trade => trade.timeUs >= fromUs && trade.timeUs < untilUs))
    if (end > cursor) yield { fromUs: cursor, untilUs: end, rows: points.filter(trade => trade.timeUs < end) }
    edge = points.filter(trade => trade.timeUs >= end)
    cursor = end
    before = after - 1n
    width = rows.length >= 50 ? 101n : width < 65_536n ? width * 2n : width
  }
  if (cursor < untilUs) yield { fromUs: cursor, untilUs, rows: edge }
}

export async function visitOkxTradePages(instrument: OkxInstrument, fromUs: number, untilUs: number, forward: boolean,
  signal: AbortSignal, offer: (page: OkxTradePage) => void, fetcher: typeof fetch = fetch): Promise<void> {
  const read = forward ? readOkxTradePagesForward : readOkxTradePages
  let substantialPages = 0
  for await (const page of read(instrument, fromUs, untilUs, signal, fetcher)) {
    signal.throwIfAborted()
    offer(page)
    if (forward) fromUs = page.untilUs
    else untilUs = page.fromUs
    // Keep small downloads on the original cursor and publish the nearby pages first.
    if (page.rows.length >= 50) substantialPages++
    if (substantialPages >= 2 && untilUs - fromUs >= 2 * minParallelRangeUs) break
  }
  if (fromUs >= untilUs) return

  const parallel = Math.min(3, Math.floor((untilUs - fromUs) / minParallelRangeUs))
  const stepUs = Math.floor((untilUs - fromUs) / parallel / 1000) * 1000
  const abort = new AbortController()
  const groupSignal = AbortSignal.any([signal, abort.signal])
  const ranges = Array.from({ length: parallel }, (_, offset) => {
    const index = forward ? offset : parallel - offset - 1
    const start = fromUs + index * stepUs
    const end = index === parallel - 1 ? untilUs : start + stepUs
    return { start, end }
  })
  await Promise.all(ranges.map(async ({ start, end }) => {
    try {
      for await (const page of read(instrument, start, end, groupSignal, fetcher)) {
        groupSignal.throwIfAborted()
        offer(page)
      }
    } catch (error) { abort.abort(error) }
  }))
  groupSignal.throwIfAborted()
}

export class OkxLiveTrades {
  private socket?: WebSocket
  private heartbeat?: ReturnType<typeof setInterval>
  private reconnect?: ReturnType<typeof setTimeout>
  private stopped = false
  private lastMessageAt = 0
  private failures = 0
  private trades: BybitTrade[] = []
  private readonly ids = new Set<string>()
  coverageStartUs = Infinity
  gap = true
  failed = false

  constructor(private readonly instrument: OkxInstrument,
    private readonly changed: (fromUs?: number, trade?: BybitTrade) => void, private readonly now = Date.now,
    private readonly connect = (url: string) => new WebSocket(url)) {}

  get lastTradeUs(): number | undefined { return this.trades.at(-1)?.timeUs }
  get firstTradeUs(): number | undefined { return this.trades[0]?.timeUs }

  read(fromUs: number, untilUs: number): BybitTrade[] {
    let low = 0
    let high = this.trades.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.trades[middle].timeUs < fromUs) low = middle + 1
      else high = middle
    }
    const rows: BybitTrade[] = []
    while (low < this.trades.length && this.trades[low].timeUs < untilUs) rows.push(this.trades[low++])
    return rows
  }

  open(): void {
    if (this.stopped || this.socket) return
    let socket: WebSocket
    try { socket = this.connect('wss://ws.okx.com/ws/v5/business') }
    catch { this.disconnected(); return }
    this.socket = socket
    this.lastMessageAt = this.now()
    const connectingSince = this.lastMessageAt
    this.heartbeat = setInterval(() => {
      const now = this.now()
      if ((this.gap && now - connectingSince >= 15_000) || now - this.lastMessageAt >= 40_000) socket.close()
      else if (socket.readyState === 1) socket.send('ping')
    }, 15_000)
    socket.onopen = () => {
      if (this.socket !== socket) return
      socket.send(JSON.stringify({ op: 'subscribe', args: [{ channel: subscribedChannel, instId: this.instrument.symbol }] }))
    }
    socket.onmessage = event => {
      if (this.socket !== socket || typeof event.data !== 'string') return
      this.lastMessageAt = this.now()
      if (event.data === 'pong') return
      try {
        const packet = JSON.parse(event.data)
        if (packet.event === 'error') { socket.close(); return }
        if (packet.arg?.instId !== this.instrument.symbol || packet.arg?.channel !== subscribedChannel) return
        if (packet.event === 'subscribe') {
          this.coverageStartUs = this.now() * 1000
          this.gap = false
          this.failed = false
          this.failures = 0
          this.changed(this.lastTradeUs ?? this.now() * 1000 - 4_000_000)
          return
        }
        for (const item of packet.data ?? []) this.append(rowTrade(this.instrument, item))
      } catch { socket.close() }
    }
    socket.onerror = () => socket.close()
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = undefined
      clearInterval(this.heartbeat)
      this.disconnected()
    }
  }

  close(): void {
    this.stopped = true
    clearInterval(this.heartbeat)
    clearTimeout(this.reconnect)
    const socket = this.socket
    this.socket = undefined
    socket?.close()
  }

  private retry(): void {
    if (!this.stopped) this.reconnect = setTimeout(() => this.open(), Math.min(30_000, 500 * 2 ** Math.min(++this.failures, 6)))
  }

  private disconnected(): void {
    this.gap = true
    this.failed = true
    this.changed(this.now() * 1000 - 4_000_000)
    this.retry()
  }

  private append(trade: BybitTrade): void {
    if (this.ids.has(trade.id)) return
    this.ids.add(trade.id)
    const previous = this.trades.at(-1)
    this.trades.push(trade)
    if (previous && compareTrades(previous, trade) > 0) this.trades.sort(compareTrades)
    if (this.trades.length > liveLimit) {
      for (const removed of this.trades.splice(0, liveLimit / 5)) this.ids.delete(removed.id)
      this.coverageStartUs = Math.max(this.coverageStartUs, this.trades[0].timeUs)
    }
    this.changed(trade.timeUs < (this.now() - 250) * 1000 ? trade.timeUs : undefined, trade)
  }
}
