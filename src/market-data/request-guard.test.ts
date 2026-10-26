import { describe, expect, it, vi } from 'vitest'
import {
  BinanceRequestGuard,
  createBrowserRequestGuard,
  REQUEST_GUARD_KEY,
  type RequestGuardDependencies,
} from './request-guard'

function environment() {
  let time = Date.UTC(2026, 9, 26)
  let held = false
  const records = new Map<string, string>()
  const storage = {
    getItem: vi.fn((key: string) => records.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { records.set(key, value) }),
  }
  const dependencies: RequestGuardDependencies = {
    now: () => time,
    sleep: vi.fn(async (milliseconds) => { time += milliseconds }),
    storage: () => storage,
    exclusive: async (action) => {
      if (held) throw new Error('another page is requesting')
      held = true
      try { return await action() } finally { held = false }
    },
  }
  return {
    dependencies, records, storage,
    guard: () => new BinanceRequestGuard(dependencies),
    advance: (milliseconds: number) => { time += milliseconds },
  }
}

describe('BinanceRequestGuard', () => {
  it.each([429, 418, 403])('persists HTTP %i protection across reloads and requires manual recovery', async (status) => {
    const env = environment()
    const guard = env.guard()
    const fetchResponse = vi.fn(async () => Response.json({}, {
      status, headers: { 'Retry-After': '2' },
    }))
    await expect(guard.request(fetchResponse)).rejects.toThrow(`HTTP ${status}`)
    await expect(guard.resume()).rejects.toThrow('冷却尚未结束')
    const reloaded = env.guard()
    env.advance(31 * 60_000)
    await expect(reloaded.request(fetchResponse)).rejects.toThrow('不会自动恢复')
    expect(fetchResponse).toHaveBeenCalledOnce()
    await reloaded.resume()
    await expect(env.guard().request(async () => Response.json(['restored']))).resolves.toEqual(['restored'])
  })

  it('honors a longer server ban and adds a buffer before manual recovery', async () => {
    const env = environment()
    const until = env.dependencies.now() + 2 * 60 * 60_000
    const guard = env.guard()
    await expect(guard.request(async () => Response.json({ msg: `IP banned until ${until}` }, {
      status: 418, headers: { 'Retry-After': '10' },
    }))).rejects.toThrow('HTTP 418')
    expect(guard.getStatus().retryAt).toBe(until + 60_000)
    env.advance(2 * 60 * 60_000)
    await expect(guard.resume()).rejects.toThrow('冷却尚未结束')
  })

  it('stops on high IP weight before a 429 response is received', async () => {
    const env = environment()
    const guard = env.guard()
    const fetchResponse = vi.fn(async () => Response.json([], {
      headers: { 'X-MBX-USED-WEIGHT-1M': '100' },
    }))
    await expect(guard.request(fetchResponse)).rejects.toThrow('保守阈值')
    await expect(env.guard().request(fetchResponse)).rejects.toThrow('保守阈值')
    expect(fetchResponse).toHaveBeenCalledOnce()
  })

  it('keeps the local minute budget even when server weight headers are unavailable', async () => {
    const env = environment()
    const guard = env.guard()
    const fetchResponse = vi.fn(async () => Response.json([]))
    for (let index = 0; index < 10; index += 1) await guard.request(fetchResponse)
    await expect(env.guard().request(fetchResponse)).rejects.toThrow('本地保守请求上限')
    expect(fetchResponse).toHaveBeenCalledTimes(10)
    env.advance(60_001)
    await guard.request(fetchResponse)
    expect(fetchResponse).toHaveBeenCalledTimes(11)
  })

  it('enforces the hourly budget even when individual minute windows stay below their limit', async () => {
    const env = environment()
    const guard = env.guard()
    const fetchResponse = vi.fn(async () => Response.json([]))
    for (let index = 0; index < 100; index += 1) {
      env.advance(7_000)
      await guard.request(fetchResponse)
    }
    await expect(env.guard().request(fetchResponse)).rejects.toThrow('本地保守请求上限')
    expect(fetchResponse).toHaveBeenCalledTimes(100)
  })

  it('shares serialization and spacing between independent clients or pages', async () => {
    const env = environment()
    const first = env.guard()
    const second = env.guard()
    let complete!: (response: Response) => void
    const delayed = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve }))
    const pending = first.request(delayed)
    await vi.waitFor(() => expect(delayed).toHaveBeenCalledOnce())
    const otherFetch = vi.fn(async () => Response.json([]))
    await expect(second.request(otherFetch)).rejects.toThrow('another page')
    expect(otherFetch).not.toHaveBeenCalled()
    complete(Response.json([]))
    await pending
    await second.request(otherFetch)
    expect(env.dependencies.sleep).toHaveBeenCalledWith(2_000)
  })

  it('refuses requests if saved protection is corrupt', async () => {
    const env = environment()
    env.records.set(REQUEST_GUARD_KEY, '{invalid')
    const fetchResponse = vi.fn()
    await expect(env.guard().request(fetchResponse)).rejects.toThrow('无法读取请求保护记录')
    expect(fetchResponse).not.toHaveBeenCalled()
  })

  it('refuses requests when quota reservation cannot be persisted', async () => {
    const env = environment()
    env.storage.setItem.mockImplementation(() => { throw new Error('storage full') })
    const fetchResponse = vi.fn()
    await expect(env.guard().request(fetchResponse)).rejects.toThrow('无法保存请求保护记录')
    expect(fetchResponse).not.toHaveBeenCalled()
  })

  it('fails closed when cross-page coordination is unavailable', async () => {
    const fetchResponse = vi.fn()
    await expect(createBrowserRequestGuard().request(fetchResponse)).rejects.toThrow('无法协调多页面请求')
    expect(fetchResponse).not.toHaveBeenCalled()
  })

  it('does not send a request canceled during the minimum interval', async () => {
    const env = environment()
    const guard = env.guard()
    const controller = new AbortController()
    const fetchResponse = vi.fn(async () => Response.json([]))
    await guard.request(fetchResponse)
    env.dependencies.sleep = async () => { controller.abort() }
    await expect(guard.request(fetchResponse, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchResponse).toHaveBeenCalledOnce()
  })

  it('counts failed network attempts and never retries them automatically', async () => {
    const env = environment()
    const fetchResponse = vi.fn(async () => { throw new Error('offline') })
    await expect(env.guard().request(fetchResponse)).rejects.toThrow('不会自动重试')
    expect(fetchResponse).toHaveBeenCalledOnce()
    expect(JSON.parse(env.records.get(REQUEST_GUARD_KEY)!).events).toHaveLength(1)
  })

  it('limits connection attempts across clients and refuses sockets while REST is paused', async () => {
    const env = environment()
    await env.guard().authorizeSocket()
    await expect(env.guard().authorizeSocket()).rejects.toThrow('切换过于频繁')
    for (let index = 0; index < 3; index += 1) {
      env.advance(10_000)
      await env.guard().authorizeSocket()
    }
    env.advance(10_000)
    await expect(env.guard().authorizeSocket()).rejects.toThrow('本地保守请求上限')
    await expect(env.guard().request(async () => new Response('', { status: 429 }))).rejects.toThrow('HTTP 429')
    env.advance(60_000)
    await expect(env.guard().authorizeSocket()).rejects.toThrow('不会自动恢复')
  })
})
