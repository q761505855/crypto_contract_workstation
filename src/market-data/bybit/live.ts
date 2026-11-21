import { BYBIT_DAY_MS, type BybitSymbol, type BybitTrade, bybitCategory, bybitTrade } from './trades'

const socketUrl = 'wss://stream.bybit.com/v5/public/'
const recentUrl = 'https://api.bybit.com/v5/market/recent-trade'
const tradeLimit = 150_000
const recentLimit = 1000
const heartbeatMs = 20_000

export type BybitLiveStatus = '连接中' | '补齐成交中' | '实时逐笔' | '正在重连' | '逐笔有缺口'

export function parseBybitSocketTrades(value: unknown, symbol: BybitSymbol): BybitTrade[] {
  const event = value as { topic?: unknown; data?: unknown } | null
  if (event?.topic !== `publicTrade.${symbol}`) return []
  if (!Array.isArray(event.data)) throw new Error('Bybit 实时逐笔格式无效')
  return event.data.map(item => {
    if (item?.s !== symbol || !Number.isSafeInteger(item.T)) throw new Error('Bybit 实时逐笔品种或时间无效')
    return bybitTrade(item.T * 1000, item.i, item.S, item.p, item.v)
  })
}

export async function getBybitRecentTrades(symbol: BybitSymbol, fetcher: typeof fetch = fetch,
  signal?: AbortSignal): Promise<BybitTrade[]> {
  const category = bybitCategory(symbol)
  const params = new URLSearchParams({ category, symbol, limit: String(category === 'spot' ? 60 : recentLimit) })
  const response = await fetcher(`${recentUrl}?${params}`, { signal, credentials: 'omit', cache: 'no-store' })
  if (!response.ok) throw new Error(`读取 Bybit 最近成交失败（HTTP ${response.status}）`)
  const result = await response.json()
  if (result.retCode !== 0 || !Array.isArray(result.result?.list)) throw new Error('Bybit 最近成交响应无效')
  return result.result.list.map((item: Record<string, unknown>) => {
    if (item.symbol !== symbol || typeof item.time !== 'string' || !/^\d+$/.test(item.time)) throw new Error('Bybit 最近成交无效')
    return bybitTrade(Number(item.time) * 1000, item.execId, item.side, item.price, item.size)
  }).reverse()
}

export function mergeBybitTrades(older: readonly BybitTrade[], newer: readonly BybitTrade[]): BybitTrade[] {
  const remaining = new Map(older.map(item => [item.id, item]))
  for (const trade of newer) {
    if (!remaining.has(trade.id)) remaining.set(trade.id, trade)
  }
  return [...remaining.values()].sort((a, b) => a.timeUs - b.timeUs)
}

export class BybitLiveTrades {
  private socket?: WebSocket
  private reconnect?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private abort?: AbortController
  private buffer: BybitTrade[] = []
  private tape: BybitTrade[] = []
  private ids = new Set<string>()
  private listeners = new Set<(trades: readonly BybitTrade[], rebuilt: boolean) => void>()
  private failures = 0
  private waiting = true
  private needsRepair = false
  private paused = false
  private watchTime = 0
  private start = 0
  private status: BybitLiveStatus = '连接中'

  constructor(readonly symbol: BybitSymbol, private readonly onStatus: (status: BybitLiveStatus) => void,
    private readonly connectSocket = (url: string) => new WebSocket(url),
    private readonly recent = getBybitRecentTrades) {}

  read(fromUs: number, toUs: number): BybitTrade[] {
    let lo = 0
    let hi = this.tape.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.tape[mid].timeUs < fromUs) lo = mid + 1
      else hi = mid
    }
    const result: BybitTrade[] = []
    while (lo < this.tape.length && this.tape[lo].timeUs < toUs) result.push(this.tape[lo++])
    return result
  }

  get coverageStartUs(): number | undefined { return this.start || undefined }
  get lastTradeUs(): number | undefined { return this.tape.at(-1)?.timeUs }
  get gap(): boolean { return this.needsRepair || this.waiting || this.paused }

  subscribe(listener: (trades: readonly BybitTrade[], rebuilt: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  open(): void {
    if (this.socket) return
    this.paused = false
    this.waiting = true
    this.buffer = []
    this.publish(this.failures ? '正在重连' : '连接中')
    let socket: WebSocket
    try { socket = this.connectSocket(socketUrl + bybitCategory(this.symbol)) }
    catch { this.retry(); return }
    this.socket = socket
    this.watchTime = Date.now()
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.watchTime > heartbeatMs * 2) socket.close()
      else if (socket.readyState === 1) socket.send('{"op":"ping"}')
    }, heartbeatMs)
    socket.onopen = () => {
      if (this.socket !== socket) return
      socket.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${this.symbol}`] }))
    }
    socket.onmessage = event => {
      if (this.socket !== socket || typeof event.data !== 'string') return
      this.watchTime = Date.now()
      try {
        const data = JSON.parse(event.data)
        if (data.op === 'subscribe') {
          if (data.success !== true) socket.close()
          else if (this.waiting && !this.abort) void this.backfill(socket)
          return
        }
        const rows = parseBybitSocketTrades(data, this.symbol)
        if (this.waiting) {
          this.buffer.push(...rows)
          if (this.buffer.length > tradeLimit) socket.close()
        } else if (rows.length) this.append(rows)
      } catch {
        this.needsRepair = true
        socket.close()
      }
    }
    socket.onerror = () => socket.close()
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.clearConnection()
      this.retry()
    }
  }

  close(): void {
    this.paused = true
    this.clearConnection()
    clearTimeout(this.reconnect)
    this.reconnect = undefined
  }

  private clearConnection(): void {
    const socket = this.socket
    this.socket = undefined
    clearInterval(this.heartbeat)
    this.abort?.abort()
    this.abort = undefined
    socket?.close()
  }

  private retry(): void {
    if (this.paused) return
    this.publish('正在重连')
    this.reconnect = setTimeout(() => this.open(), Math.min(30_000, 500 * 2 ** Math.min(++this.failures, 6)))
  }

  private async backfill(socket: WebSocket): Promise<void> {
    this.publish('补齐成交中')
    const abort = new AbortController()
    this.abort = abort
    const last = this.tape.at(-1)
    let rows: BybitTrade[] = []
    let requestFailed = false
    try { rows = await this.recent(this.symbol, fetch, AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)])) }
    catch { requestFailed = true }
    if (this.socket !== socket) return
    this.abort = undefined
    // With a saturated recent window, prove overlap using the venue's trade ID.
    const overlap = !!last && rows.some(trade => trade.id === last.id)
    const lost = requestFailed || (!!last && !overlap)
    const fresh = mergeBybitTrades(rows, this.buffer)
    // The live feed and REST can overlap at startup. If the market traded
    // between REST and the active socket this remains inside the overlap window.
    const discontinuity = lost && !!last
    this.needsRepair ||= requestFailed || discontinuity
    this.buffer = []
    this.waiting = false
    this.failures = 0
    this.replace(mergeBybitTrades(this.tape, fresh))
    this.publish(this.needsRepair ? '逐笔有缺口' : '实时逐笔')
    this.emit(this.tape, true)
  }

  private append(trades: BybitTrade[]): void {
    const fresh = trades.filter(trade => {
      if (this.ids.has(trade.id)) return false
      this.ids.add(trade.id)
      return true
    })
    if (!fresh.length) return
    if (!this.start) this.start = fresh[0].timeUs
    // A range reader may already have consumed this millisecond. Rebuild even
    // on a tie so another trade stamped at the same time is included.
    const rebuilt = !!this.tape.length && fresh[0].timeUs <= this.tape.at(-1)!.timeUs
    if (rebuilt) this.replace(mergeBybitTrades(this.tape, fresh))
    else {
      this.tape.push(...fresh)
      if (this.tape.length > tradeLimit) {
        // Evict in batches to avoid copying the entire tape on each trade.
        this.replace(this.tape.slice(-Math.floor(tradeLimit * 0.8)))
        this.start = this.tape[0].timeUs
      }
    }
    this.emit(rebuilt ? this.tape : fresh, rebuilt)
  }

  private replace(trades: BybitTrade[]): void {
    const cutoff = trades.length > tradeLimit ? trades.length - tradeLimit : 0
    const oldest = Date.now() * 1000 - BYBIT_DAY_MS * 2 * 1000
    this.tape = trades.slice(cutoff).filter(trade => trade.timeUs >= oldest)
    this.ids = new Set(this.tape.map(trade => trade.id))
    if (this.tape[0]) this.start = this.tape[0].timeUs
  }

  private emit(trades: readonly BybitTrade[], rebuilt: boolean): void {
    for (const listener of this.listeners) listener(trades, rebuilt)
  }

  private publish(status: BybitLiveStatus): void {
    if (status === this.status && status !== '连接中') return
    this.status = status
    this.onStatus(status)
  }
}
