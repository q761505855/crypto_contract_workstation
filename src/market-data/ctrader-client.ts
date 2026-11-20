import { INITIAL_LIVE_STATUS, type LiveMarketStatus } from './live-models'

export const CTRADER_DEMO_URL = 'wss://demo.ctraderapi.com:5036'

const TIMEOUT_MS = 12_000
const HEARTBEAT_MS = 8_000
const INITIAL_RECONNECT_MS = 500

export interface CTraderConnectionConfig {
  clientId: string
  clientSecret: string
  accessToken: string
  accountId: number
}

export const CTraderMessage = {
  Heartbeat: 51,
  ApplicationAuth: 2100,
  ApplicationAuthResponse: 2101,
  AccountAuth: 2102,
  AccountAuthResponse: 2103,
  AssetList: 2112,
  AssetListResponse: 2113,
  SymbolsList: 2114,
  SymbolsListResponse: 2115,
  SymbolDetail: 2116,
  SymbolDetailResponse: 2117,
  SymbolChanged: 2120,
  SubscribeSpots: 2127,
  SubscribeSpotsResponse: 2128,
  UnsubscribeSpots: 2129,
  UnsubscribeSpotsResponse: 2130,
  Spot: 2131,
  SubscribeTrendbar: 2135,
  UnsubscribeTrendbar: 2136,
  GetTrendbars: 2137,
  GetTrendbarsResponse: 2138,
  Error: 2142,
  TokenInvalidated: 2147,
  ClientDisconnect: 2148,
  AccountList: 2149,
  AccountListResponse: 2150,
  AccountDisconnect: 2164,
  SubscribeTrendbarResponse: 2165,
  UnsubscribeTrendbarResponse: 2166,
} as const

const MARKET_REQUESTS = {
  [CTraderMessage.AssetList]: CTraderMessage.AssetListResponse,
  [CTraderMessage.SymbolsList]: CTraderMessage.SymbolsListResponse,
  [CTraderMessage.SymbolDetail]: CTraderMessage.SymbolDetailResponse,
  [CTraderMessage.SubscribeSpots]: CTraderMessage.SubscribeSpotsResponse,
  [CTraderMessage.UnsubscribeSpots]: CTraderMessage.UnsubscribeSpotsResponse,
  [CTraderMessage.SubscribeTrendbar]: CTraderMessage.SubscribeTrendbarResponse,
  [CTraderMessage.UnsubscribeTrendbar]: CTraderMessage.UnsubscribeTrendbarResponse,
  [CTraderMessage.GetTrendbars]: CTraderMessage.GetTrendbarsResponse,
} as const

export type CTraderPayload = Record<string, unknown>

interface Frame {
  clientMsgId?: string
  payloadType: number
  payload: CTraderPayload
}

interface PendingRequest {
  expected: number
  resolve(payload: CTraderPayload): void
  reject(error: unknown): void
}

interface Connection {
  sessionId: number
  socket: WebSocket
  accountId?: number
  heartbeat?: ReturnType<typeof setInterval>
  pending: Map<string, PendingRequest>
  failOpen(error: Error): void
}

class FatalConnectionError extends Error {}

class ServerError extends Error {
  constructor(code: unknown) {
    const label = /^(?:[A-Z][A-Z_]{2,34}|[0-9]{1,5})$/.test(String(code)) ? String(code) : 'UNKNOWN'
    super(`cTrader 拒绝了请求（${label}）`)
  }
}

export function cTraderObject(value: unknown): CTraderPayload | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as CTraderPayload
    : undefined
}

export function cTraderInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+$/.test(value))) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : undefined
}

function decodeFrame(data: unknown): Frame | undefined {
  if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data)
  if (typeof data !== 'string') return
  try {
    const frame = cTraderObject(JSON.parse(data))
    const type = cTraderInteger(frame?.payloadType)
    if (type === undefined) return
    return {
      clientMsgId: typeof frame?.clientMsgId === 'string' ? frame.clientMsgId : undefined,
      payloadType: type,
      payload: cTraderObject(frame?.payload) ?? {},
    }
  } catch {
    // A malformed frame cannot satisfy a pending request.
  }
}

export function waitForCTraderResult<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}

export class CTraderClient {
  private connection: Connection | null = null
  private opening: Promise<Connection> | null = null
  private fatalError?: FatalConnectionError
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectEnabled = false
  private disposed = false
  private sequence = 0
  private sessionSequence = 0
  private reconnectAttempt = 0
  private status = { ...INITIAL_LIVE_STATUS }
  private readonly statusListeners = new Set<(status: LiveMarketStatus) => void>()
  private readonly eventListeners = new Set<(type: number, payload: CTraderPayload) => void>()

  constructor(
    private readonly loadConfig: () => Promise<CTraderConnectionConfig>,
    private readonly createSocket: (url: string) => WebSocket = url => new WebSocket(url),
  ) {}

  get sessionId(): number | undefined {
    const connection = this.connection
    return connection?.accountId === undefined ? undefined : connection.sessionId
  }

  onStatus(listener: (status: LiveMarketStatus) => void): () => void {
    this.statusListeners.add(listener)
    listener({ ...this.status })
    return () => this.statusListeners.delete(listener)
  }

  onEvent(listener: (type: number, payload: CTraderPayload) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  setReconnectEnabled(enabled: boolean): void {
    this.reconnectEnabled = enabled
    if (enabled) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  async connect(signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted()
    return (await waitForCTraderResult(this.ensureConnection(), signal)).sessionId
  }

  async request(
    type: keyof typeof MARKET_REQUESTS,
    payload: CTraderPayload = {},
    signal?: AbortSignal,
    sessionId?: number,
  ): Promise<CTraderPayload> {
    signal?.throwIfAborted()
    const connection = sessionId === undefined
      ? await waitForCTraderResult(this.ensureConnection(), signal)
      : this.connection
    if (!connection || connection.accountId === undefined || (sessionId !== undefined && sessionId !== connection.sessionId)) {
      throw new Error('cTrader 行情连接已中断')
    }
    return this.send(connection, type, MARKET_REQUESTS[type], { ...payload, ctidTraderAccountId: connection.accountId }, signal)
  }

  dispose(): void {
    this.disposed = true
    this.setReconnectEnabled(false)
    if (this.connection) this.end(this.connection, new Error('cTrader 行情连接已关闭'))
    this.statusListeners.clear()
    this.eventListeners.clear()
  }

  private async ensureConnection(): Promise<Connection> {
    if (this.disposed) throw new Error('cTrader 行情连接已关闭')
    if (this.fatalError) throw this.fatalError
    if (this.connection?.accountId !== undefined) return this.connection
    if (this.opening) return this.opening
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.opening = this.open()
    try {
      return await this.opening
    } catch (error) {
      if (error instanceof FatalConnectionError) this.fatalError = error
      if (this.connection) this.end(this.connection, error)
      this.reportLoss(error)
      throw error
    } finally {
      this.opening = null
    }
  }

  private async open(): Promise<Connection> {
    this.publish({
      connection: this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting',
      warning: '',
    })
    let config: CTraderConnectionConfig
    try {
      config = await this.loadConfig()
    } catch {
      throw new FatalConnectionError('无法读取 cTrader 模拟账户连接配置')
    }
    if (![config?.clientId, config?.clientSecret, config?.accessToken].every(value => typeof value === 'string' && value.trim().length > 0)
      || !Number.isSafeInteger(config?.accountId) || config.accountId <= 0) {
      throw new FatalConnectionError('缺少 cTrader 模拟账户连接配置')
    }
    if (this.disposed) throw new Error('cTrader 行情连接已关闭')
    const socket = this.createSocket(CTRADER_DEMO_URL)
    socket.binaryType = 'arraybuffer'
    let failOpen: Connection['failOpen'] = () => {}
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 cTrader 行情超时')), TIMEOUT_MS)
      const settle = (error?: Error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      failOpen = settle
      socket.addEventListener('open', () => settle(), { once: true })
    })
    const connection: Connection = { socket, sessionId: ++this.sessionSequence, pending: new Map(), failOpen }
    this.connection = connection
    socket.addEventListener('message', event => this.receive(connection, decodeFrame(event.data)))
    const disconnected = () => this.end(connection, new Error('cTrader 行情连接已中断'))
    socket.addEventListener('close', disconnected, { once: true })
    socket.addEventListener('error', disconnected, { once: true })
    await opened
    connection.heartbeat = setInterval(() => {
      if (socket.readyState === 1) {
        try {
          socket.send(JSON.stringify({ payloadType: CTraderMessage.Heartbeat, payload: {} }))
        } catch {
          disconnected()
        }
      }
    }, HEARTBEAT_MS)
    await this.authenticate(connection, config)
    if (this.connection !== connection || socket.readyState !== 1) throw new Error('cTrader 行情连接已中断')
    connection.accountId = config.accountId
    this.reconnectAttempt = 0
    this.publish({ connection: 'connected', warning: '' })
    return connection
  }

  private async authenticate(connection: Connection, config: CTraderConnectionConfig): Promise<void> {
    const { clientId, clientSecret, accountId, accessToken } = config
    try {
      await this.send(connection, CTraderMessage.ApplicationAuth, CTraderMessage.ApplicationAuthResponse, { clientId, clientSecret })
      const list = await this.send(connection, CTraderMessage.AccountList, CTraderMessage.AccountListResponse, { accessToken })
      if (list.permissionScope !== 'SCOPE_VIEW' && cTraderInteger(list.permissionScope) !== 0) {
        throw new FatalConnectionError('cTrader Access Token 必须明确为只读权限')
      }
      const accounts = Array.isArray(list.ctidTraderAccount) ? list.ctidTraderAccount : []
      const account = cTraderObject(accounts[0])
      if (accounts.length !== 1 || cTraderInteger(account?.ctidTraderAccountId) !== accountId
        || (account?.isLive !== false && account?.isLive !== undefined)) {
        throw new FatalConnectionError('cTrader Access Token 必须仅授权配置中的模拟账户')
      }
      const result = await this.send(connection, CTraderMessage.AccountAuth, CTraderMessage.AccountAuthResponse, {
        ctidTraderAccountId: accountId, accessToken,
      })
      if (cTraderInteger(result.ctidTraderAccountId) !== accountId) {
        throw new FatalConnectionError('cTrader 模拟账户认证返回了不同的账户')
      }
    } catch (error) {
      if (error instanceof ServerError) throw new FatalConnectionError(`cTrader 认证失败：${error.message}`)
      throw error
    }
  }

  private send(
    connection: Connection,
    type: number,
    expected: number,
    payload: CTraderPayload,
    signal?: AbortSignal,
  ): Promise<CTraderPayload> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted()
      if (this.connection !== connection || connection.socket.readyState !== 1) {
        reject(new Error('cTrader 行情连接已中断'))
        return
      }
      const clientMsgId = `ccw-${++this.sequence}`
      const cleanup = () => {
        connection.pending.delete(clientMsgId)
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
      }
      const fail = (error: unknown) => {
        cleanup()
        reject(error)
      }
      const cancel = () => fail(signal?.reason)
      const timer = setTimeout(() => fail(new Error('cTrader 行情请求超时')), TIMEOUT_MS)
      signal?.addEventListener('abort', cancel, { once: true })
      connection.pending.set(clientMsgId, {
        expected,
        resolve: result => {
          cleanup()
          resolve(result)
        },
        reject: fail,
      })
      try {
        connection.socket.send(JSON.stringify({ clientMsgId, payloadType: type, payload }))
      } catch {
        fail(new Error('cTrader 行情请求发送失败'))
      }
    })
  }

  private receive(connection: Connection, frame?: Frame): void {
    if (this.connection !== connection || !frame) return
    const { payloadType, payload, clientMsgId } = frame
    const pending = clientMsgId ? connection.pending.get(clientMsgId) : undefined
    if (pending && (payloadType === CTraderMessage.Error || payloadType === 50)) {
      pending.reject(new ServerError(payload.errorCode))
      return
    }
    if (pending && payloadType === pending.expected) {
      pending.resolve(payload)
      return
    }
    if (connection.accountId === undefined) return
    if (payloadType === CTraderMessage.TokenInvalidated) {
      this.fatalError = new FatalConnectionError('cTrader Access Token 已失效')
      this.end(connection, this.fatalError)
      return
    }
    if (payloadType === CTraderMessage.ClientDisconnect || payloadType === CTraderMessage.AccountDisconnect) {
      this.end(connection, new Error('cTrader 行情连接已中断'))
      return
    }
    if (cTraderInteger(payload.ctidTraderAccountId) !== connection.accountId) return
    for (const listener of this.eventListeners) listener(payloadType, payload)
  }

  private end(connection: Connection, error: unknown): void {
    if (this.connection !== connection) return
    this.connection = null
    clearInterval(connection.heartbeat)
    connection.failOpen(error instanceof Error ? error : new Error('cTrader 行情连接已中断'))
    for (const pending of connection.pending.values()) pending.reject(error)
    if (connection.socket.readyState < 2) connection.socket.close()
    if (connection.accountId !== undefined) this.reportLoss(error)
  }

  private reportLoss(error: unknown): void {
    if (this.disposed) return
    const retry = !this.fatalError && this.reconnectEnabled
    if (retry) this.reconnectAttempt++
    this.publish({
      connection: retry ? 'reconnecting' : 'disconnected',
      warning: error instanceof Error ? error.message : 'cTrader 行情连接已中断',
    })
    if (!retry || this.reconnectTimer !== undefined) return
    const delay = Math.min(30_000, INITIAL_RECONNECT_MS * 2 ** (this.reconnectAttempt - 1))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.ensureConnection().catch(() => {})
    }, delay)
  }

  private publish(status: Pick<LiveMarketStatus, 'connection' | 'warning'>): void {
    this.status = { ...INITIAL_LIVE_STATUS, ...status, reconnectAttempt: this.reconnectAttempt }
    for (const listener of this.statusListeners) listener({ ...this.status })
  }
}
