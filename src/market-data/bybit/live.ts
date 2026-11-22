import { BYBIT_DAY_MS, type BybitSymbol, type BybitTrade, bybitCategory, bybitTrade } from './trades'

const socketUrl = 'wss://stream.bybit.com/v5/public/'
const tradeLimit = 150_000
const heartbeatMs = 20_000

export type BybitLiveStatus = '连接中' | '实时逐笔' | '正在重连'

export function parseBybitSocketTrades(value: unknown, symbol: BybitSymbol): BybitTrade[] {
  const event = value as { topic?: unknown; data?: unknown } | null
  if (event?.topic !== `publicTrade.${symbol}`) return []
  if (!Array.isArray(event.data)) throw new Error('Bybit 实时逐笔格式无效')
  return event.data.map(item => {
    if (item?.s !== symbol || !Number.isSafeInteger(item.T)) throw new Error('Bybit 实时逐笔品种或时间无效')
    return bybitTrade(item.T * 1000, item.i, item.S, item.p, item.v)
  })
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
  private buffer: BybitTrade[] = []
  private tape: BybitTrade[] = []
  private ids = new Set<string>()
  private listeners = new Set<(trades: readonly BybitTrade[], rebuilt: boolean, fromUs?: number) => void>()
  private failures = 0
  private waiting = true
  private paused = false
  private watchTime = 0
  private start = 0
  private status: BybitLiveStatus = '连接中'

  constructor(readonly symbol: BybitSymbol, private readonly onStatus: (status: BybitLiveStatus) => void,
    private readonly connectSocket = (url: string) => new WebSocket(url), private readonly now = Date.now) {}

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
  get firstTradeUs(): number | undefined { return this.tape[0]?.timeUs }
  get lastTradeUs(): number | undefined { return this.tape.at(-1)?.timeUs }
  get gap(): boolean { return this.waiting || this.paused }

  subscribe(listener: (trades: readonly BybitTrade[], rebuilt: boolean, fromUs?: number) => void): () => void {
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
    this.watchTime = this.now()
    this.heartbeat = setInterval(() => {
      if (this.now() - this.watchTime > heartbeatMs * 2) socket.close()
      else if (socket.readyState === 1) socket.send('{"op":"ping"}')
    }, heartbeatMs)
    socket.onopen = () => {
      if (this.socket !== socket) return
      socket.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${this.symbol}`] }))
    }
    socket.onmessage = event => {
      if (this.socket !== socket || typeof event.data !== 'string') return
      this.watchTime = this.now()
      try {
        const data = JSON.parse(event.data)
        if (data.op === 'subscribe') {
          if (data.success !== true) socket.close()
          else if (this.waiting) {
            this.start = this.now() * 1000
            this.waiting = false
            this.failures = 0
            this.append(this.buffer)
            this.buffer = []
            this.publish('实时逐笔')
          }
          return
        }
        const rows = parseBybitSocketTrades(data, this.symbol)
        if (this.waiting) {
          this.buffer.push(...rows)
          if (this.buffer.length > tradeLimit) socket.close()
        } else if (rows.length) this.append(rows)
      } catch {
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
    this.waiting = true
    socket?.close()
  }

  private retry(): void {
    if (this.paused) return
    this.publish('正在重连')
    this.reconnect = setTimeout(() => this.open(), Math.min(30_000, 500 * 2 ** Math.min(++this.failures, 6)))
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
    const previous = this.tape.at(-1)?.timeUs ?? -Infinity
    const first = fresh[0].timeUs
    const rebuilt = first <= previous
    if (first < previous) this.replace(mergeBybitTrades(this.tape, fresh))
    else {
      this.tape.push(...fresh)
      if (this.tape.length > tradeLimit) {
        // Evict in batches to avoid copying the entire tape on each trade.
        this.replace(this.tape.slice(-Math.floor(tradeLimit * 0.8)))
      }
    }
    this.emit(rebuilt ? this.tape : fresh, rebuilt, first)
  }

  private replace(trades: BybitTrade[]): void {
    const cutoff = trades.length > tradeLimit ? trades.length - tradeLimit : 0
    const oldest = this.now() * 1000 - BYBIT_DAY_MS * 2 * 1000
    this.tape = trades.slice(cutoff).filter(trade => trade.timeUs >= oldest)
    this.ids = new Set(this.tape.map(trade => trade.id))
    if (this.tape[0]) this.start = Math.max(this.start, this.tape[0].timeUs)
  }

  private emit(trades: readonly BybitTrade[], rebuilt: boolean, fromUs?: number): void {
    for (const listener of this.listeners) listener(trades, rebuilt, fromUs)
  }

  private publish(status: BybitLiveStatus): void {
    if (status === this.status && status !== '连接中') return
    this.status = status
    this.onStatus(status)
  }
}
