export const REQUEST_GUARD_KEY = 'marketData.binanceRequestGuard.v1'
export const REQUEST_GUARD_LOCK = 'marketData.binanceRequests'
export const REST_MIN_INTERVAL_MS = 2_000
export const REST_REQUESTS_PER_MINUTE = 10
export const REST_REQUESTS_PER_HOUR = 100
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const MINIMUM_COOLDOWN = 30 * MINUTE
const WEIGHT_STOP_THRESHOLD = 100

export class SocketCooldownError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`实时连接正在限速，约 ${Math.ceil(retryAfterMs / 1_000)} 秒后连接。`)
    this.name = 'SocketCooldownError'
  }
}

type RequestKind = 'rest' | 'socket'
interface GuardState {
  version: 1
  events: Array<{ at: number; kind: RequestKind }>
  halt: { reason: string; retryAt: number } | null
}

export interface RequestGuardDependencies {
  now(): number
  sleep(milliseconds: number): Promise<void>
  storage(): Pick<Storage, 'getItem' | 'setItem'>
  exclusive<T>(action: () => Promise<T>, waitForLock?: boolean): Promise<T>
}

function displayTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short', timeStyle: 'medium', hour12: false,
  }).format(timestamp)
}

export class BinanceRequestGuard {
  constructor(private readonly dependencies: RequestGuardDependencies) {}

  private read(): GuardState {
    try {
      const raw = this.dependencies.storage().getItem(REQUEST_GUARD_KEY)
      if (raw === null) return { version: 1, events: [], halt: null }
      const state = JSON.parse(raw) as GuardState
      const validTime = (value: unknown): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0
      if (state.version !== 1 || !Array.isArray(state.events) ||
        !state.events.every((event) => event !== null && validTime(event.at) &&
          (event.kind === 'rest' || event.kind === 'socket')) ||
        (state.halt !== null && (typeof state.halt?.reason !== 'string' ||
          !validTime(state.halt?.retryAt)))) {
        throw new Error('invalid state')
      }
      return state
    } catch {
      throw new Error('无法读取请求保护记录，已禁止远程请求；本地缓存仍可使用。')
    }
  }

  private write(state: GuardState): void {
    try {
      const storage = this.dependencies.storage()
      const value = JSON.stringify(state)
      storage.setItem(REQUEST_GUARD_KEY, value)
      if (storage.getItem(REQUEST_GUARD_KEY) !== value) throw new Error('write failed')
    } catch {
      throw new Error('无法保存请求保护记录，已禁止远程请求；本地缓存仍可使用。')
    }
  }

  getStatus(): { paused: boolean; message: string; retryAt: number | null; canResume: boolean } {
    try {
      const halt = this.read().halt
      return halt === null
        ? { paused: false, message: '保守限速已启用：REST 每分钟最多 10 次、每小时最多 100 次。', retryAt: null, canResume: false }
        : {
            paused: true,
            message: `${halt.reason} 已暂停新增远程请求，最早 ${displayTime(halt.retryAt)} 后可手动恢复；不会自动恢复，本地缓存仍可使用。`,
            retryAt: halt.retryAt,
            canResume: this.dependencies.now() >= halt.retryAt,
          }
    } catch (error) {
      return { paused: true, message: (error as Error).message, retryAt: null, canResume: false }
    }
  }

  async resume(): Promise<void> {
    await this.dependencies.exclusive(async () => {
      const state = this.read()
      if (state.halt === null) return
      if (this.dependencies.now() < state.halt.retryAt) {
        throw new Error(`保护冷却尚未结束，最早 ${displayTime(state.halt.retryAt)} 后可手动恢复。`)
      }
      this.write({ ...state, halt: null })
    })
  }

  private async reserve(kind: RequestKind, signal?: AbortSignal): Promise<GuardState> {
    signal?.throwIfAborted()
    let state = this.read()
    if (state.halt !== null) throw new Error(this.getStatus().message)
    let now = this.dependencies.now()
    if (state.events.some((event) => event.at > now)) {
      throw new Error('系统时间早于请求保护记录，已禁止远程请求，请检查系统时间。')
    }
    const previous = state.events.filter((event) => event.kind === kind).at(-1)
    const spacing = kind === 'rest' ? REST_MIN_INTERVAL_MS : 10_000
    const wait = previous === undefined ? 0 : previous.at + spacing - now
    if (wait > 0) {
      // Socket reconnection must not build up an outbound connection queue.
      if (kind === 'socket') throw new SocketCooldownError(wait)
      await this.dependencies.sleep(wait)
      signal?.throwIfAborted()
      state = this.read()
      if (state.halt !== null) throw new Error(this.getStatus().message)
      now = this.dependencies.now()
      if (now < previous!.at + spacing) throw new Error('请求间隔尚未满足，已停止远程请求。')
    }
    const events = state.events.filter((event) => event.at > now - HOUR)
    const matching = events.filter((event) => event.kind === kind)
    const minuteLimit = kind === 'rest' ? REST_REQUESTS_PER_MINUTE : 4
    const hourLimit = kind === 'rest' ? REST_REQUESTS_PER_HOUR : 30
    if (matching.filter((event) => event.at > now - MINUTE).length >= minuteLimit ||
      matching.length >= hourLimit) {
      throw new Error('已达到本地保守请求上限，已停止本次请求，不会自动重试；请稍后手动操作，本地缓存仍可使用。')
    }
    const reserved: GuardState = { ...state, events: [...events, { at: now, kind }] }
    // Reserve and persist before touching the network, including failed attempts.
    this.write(reserved)
    return reserved
  }

  async authorizeSocket(): Promise<void> {
    await this.dependencies.exclusive(async () => { await this.reserve('socket') }, true)
  }

  async request(fetchResponse: () => Promise<Response>, signal?: AbortSignal): Promise<unknown> {
    return this.dependencies.exclusive(async () => {
      const state = await this.reserve('rest', signal)
      let response: Response
      try {
        response = await fetchResponse()
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
        throw new Error(`无法连接币安公开行情接口，已停止本次请求，不会自动重试：${error instanceof Error ? error.message : String(error)}`)
      }
      let payload: unknown
      try { payload = await response.json() } catch { payload = null }
      const body = payload as { msg?: unknown; code?: unknown } | null
      const detail = typeof body?.msg === 'string' ? body.msg : ''
      const rawWeight = response.headers.get('X-MBX-USED-WEIGHT-1M')
      const weight = rawWeight === null ? 0 : Number(rawWeight)
      const restricted = [418, 429, 403].includes(response.status) || body?.code === -1003
      const unsafeWeight = Number.isFinite(weight) && weight >= WEIGHT_STOP_THRESHOLD
      if (restricted || unsafeWeight) {
        const now = this.dependencies.now()
        const header = response.headers.get('Retry-After')
        const seconds = header === null || header.trim() === '' ? NaN : Number(header)
        const headerTime = Number.isFinite(seconds) && seconds > 0
          ? now + seconds * 1_000
          : header === null ? 0 : Date.parse(header)
        const match = /banned until\s+(\d{10,13})/i.exec(detail)
        const banTime = match === null ? 0 : Number(match[1]) * (match[1].length === 10 ? 1_000 : 1)
        const retryAt = Math.max(now + MINIMUM_COOLDOWN,
          Number.isFinite(headerTime) ? headerTime + MINUTE : 0, banTime + MINUTE)
        const reason = restricted
          ? `币安请求保护已触发（HTTP ${response.status}）${detail.length > 0 ? `：${detail}` : ''}。`
          : `币安出口 IP 的请求权重已达到本应用的保守阈值（${weight}）。`
        this.write({ ...state, halt: { reason, retryAt } })
        throw new Error(this.getStatus().message)
      }
      if (!response.ok) throw new Error(`币安行情请求失败（HTTP ${response.status}）${detail.length > 0 ? `：${detail}` : ''}`)
      return payload
    })
  }
}

export function createBrowserRequestGuard(
  now: () => number = Date.now,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
): BinanceRequestGuard {
  return new BinanceRequestGuard({
    now, sleep,
    storage: () => localStorage,
    exclusive: async <T>(action: () => Promise<T>, waitForLock = false): Promise<T> => {
      if (typeof navigator === 'undefined' || navigator.locks === undefined) {
        throw new Error('当前环境无法协调多页面请求，已禁止远程请求；请使用支持 Web Locks 的浏览器和 HTTPS 或 localhost。')
      }
      return navigator.locks.request(REQUEST_GUARD_LOCK, { ifAvailable: !waitForLock }, async (lock) => {
        if (lock === null) throw new Error('其他页面正在请求币安数据，已停止本次请求；请稍后手动操作。')
        return action()
      })
    },
  })
}
