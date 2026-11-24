// @vitest-environment node
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OkxLocalFiles, type OkxLocalDownloadResult } from './local-files'

const directoryStore = vi.hoisted(() => ({ handles: new Map<string, unknown>(), failRead: false, failWrite: false }))
vi.mock('idb', () => ({
  openDB: async () => ({
    get: (_store: string, key: string) => {
      if (directoryStore.failRead) throw new Error('IndexedDB is unavailable')
      return directoryStore.handles.get(key)
    },
    put: (_store: string, value: unknown, key: string) => {
      if (directoryStore.failWrite) throw new Error('IndexedDB is unavailable')
      directoryStore.handles.set(key, value)
    },
  }),
}))

const ticker = 'BTC-USDT-SWAP'
const day = '2025-01-01'
const name = `${ticker}-trades-${day}.zip`
const header = 'instrument_name,trade_id,side,price,size,created_time'
const stamp = 1735660800000
const zip = (csv: string, method = 6) => new Uint8Array(zipSync({ [name.replace('.zip', '.csv')]: strToU8(csv) }, {
  level: method as 0 | 6,
}))
const example = zip(`\ufeff${header}\r\n${ticker},1,BUY,90000.30,0.1,${stamp}\r\n${ticker},2,sell,90001,1,${stamp + 1}`)

function useDirectory(initial: Record<string, Blob> = {}) {
  const contents = new Map(Object.entries(initial))
  const permission = { current: 'granted' as PermissionState }
  const folder = {
    name: 'OKX daily',
    async queryPermission() { return permission.current },
    async requestPermission() { return permission.current = 'granted' },
    async *values() {
      yield { name: 'not-a-trade.zip', kind: 'file' }
      yield { name: 'SUI-USDT-SWAP-trades-2025-02-30.zip', kind: 'file' }
      yield { name: 'ETH-USDT-SWAP-trades-2025-01-01.zip', kind: 'directory' }
      for (const name of contents.keys()) yield { name, kind: 'file' }
    },
    async getFileHandle(filename: string, { create = false } = {}) {
      if (!contents.has(filename)) {
        if (!create) throw new DOMException('Missing', 'NotFoundError')
        contents.set(filename, new Blob([]))
      }
      return {
        getFile: async () => new File([contents.get(filename)!], filename),
        async createWritable() {
          const chunks: Uint8Array<ArrayBuffer>[] = []
          return new WritableStream<Uint8Array<ArrayBuffer>>({
            write(chunk) { chunks.push(chunk) },
            close() { contents.set(filename, new Blob(chunks)) },
          })
        },
      }
    },
    async removeEntry(filename: string) { contents.delete(filename) },
  }
  const picker = vi.fn(async () => folder)
  vi.stubGlobal('showDirectoryPicker', picker)
  return { contents, permission, picker }
}

beforeEach(() => {
  directoryStore.handles.clear()
  directoryStore.failRead = false
  directoryStore.failWrite = false
})
afterEach(() => vi.unstubAllGlobals())

describe('OKX local daily archives', () => {
  it('lists official ZIP names in the granted folder and restores a handle that still needs permission', async () => {
    const { permission, picker } = useDirectory({ [name]: new Blob([example]) })
    const files = new OkxLocalFiles()
    await files.pick()
    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' })
    expect(await files.list()).toEqual([{ symbol: ticker, day, filename: name }])

    permission.current = 'prompt'
    const restored = new OkxLocalFiles()
    const changed = vi.fn()
    restored.subscribe(changed)
    await restored.restore()
    expect(restored.name).toBe('OKX daily')
    expect(restored.ready).toBe(false)
    expect(await restored.list()).toEqual([])
    await restored.authorize()
    expect(restored.ready).toBe(true)
    expect(await restored.list()).toHaveLength(1)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('uses a manually selected folder when browser storage is unavailable', async () => {
    useDirectory({ [name]: new Blob([example]) })
    directoryStore.failRead = true
    directoryStore.failWrite = true
    const files = new OkxLocalFiles()
    await expect(files.restore()).rejects.toThrow('IndexedDB')
    await expect(files.pick()).rejects.toThrow('刷新')
    await expect(files.restore()).resolves.toBeUndefined()
    expect(files.ready).toBe(true)
    expect(await files.list()).toEqual([{ symbol: ticker, day, filename: name }])
  })

  it.each([0, 6])('reads stored and deflated CSV entries (compression level %d), preserving prices and contract sizes', async level => {
    useDirectory({ [name]: new Blob([level === 6 ? example : zip(`\ufeff${header}\r\n${ticker},1,BUY,90000.30,0.1,${stamp}\r\n${ticker},2,sell,90001,1,${stamp + 1}`, level)]) })
    const files = new OkxLocalFiles()
    await files.pick()
    expect(await files.read(ticker, day)).toEqual([
      { id: '1', time: stamp, side: 'Buy', price: '90000.30', size: '0.1' },
      { id: '2', time: stamp + 1, side: 'Sell', price: '90001', size: '1' },
    ])
    expect(await files.read(ticker, '2025-01-02')).toBeUndefined()
  })

  it.each([
    ['missing column', `${header.replace('created_time', 'unknown')}\n${ticker},1,buy,1,1,${stamp}`],
    ['different ticker', `${header}\nETH-USDT-SWAP,1,buy,1,1,${stamp}`],
    ['wrong UTC+8 source day', `${header}\n${ticker},1,buy,1,1,${stamp + 86_400_000}`],
    ['missing trades', `${header}\n`],
  ])('rejects a CSV archive with %s', async (_case, csv) => {
    useDirectory({ [name]: new Blob([zip(csv)]) })
    const files = new OkxLocalFiles()
    await files.pick()
    await expect(files.read(ticker, day)).rejects.toThrow('OKX')
  })

  it('does not parse a ZIP with a truncated central directory', async () => {
    useDirectory({ [name]: new Blob([example.slice(0, -1)]) })
    const files = new OkxLocalFiles()
    await files.pick()
    await expect(files.read(ticker, day)).rejects.toThrow('ZIP')
  })

  it('downloads published days for the inclusive source date range and leaves existing files intact', async () => {
    const existing = `${ticker}-trades-2025-01-02.zip`
    const archiveUrl = `https://static.okx.com/cdn/archives/${name}?v=1001`
    const { contents } = useDirectory({ [existing]: new Blob([example]) })
    const fetcher = vi.fn<typeof fetch>(async input => {
      if (String(input).startsWith('https://www.okx.com/')) return Response.json({ code: '0', data: [{
        details: [{ groupDetails: [{ filename: name, url: archiveUrl }] }],
      }] })
      expect(String(input)).toBe(archiveUrl)
      return new Response(example)
    })
    const files = new OkxLocalFiles(fetcher)
    await files.pick()
    const results: OkxLocalDownloadResult[] = []
    await files.download(ticker, day, '2025-01-03', result => { results.push(result) })
    expect(results.map(({ day, status }) => [day, status])).toEqual([
      [day, 'saved'], ['2025-01-02', 'existing'], ['2025-01-03', 'unavailable'],
    ])
    expect(new Uint8Array(await contents.get(name)!.arrayBuffer())).toEqual(example)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const query = new URL(String(fetcher.mock.calls[0][0])).searchParams
    expect(query.get('instFamilyList')).toBe('BTC-USDT')
    expect(query.get('begin')).toBe('1735660800000')
    expect(query.get('end')).toBe('1735833600000')
  })

  it('splits the index query at the official ten-day limit and rejects an inverted date range before fetching', async () => {
    useDirectory()
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ code: '0', data: [] }))
    const files = new OkxLocalFiles(fetcher)
    await files.pick()
    await expect(files.download(ticker, '2025-02-01', day, vi.fn())).rejects.toThrow('日期')
    expect(fetcher).not.toHaveBeenCalled()

    const onProgress = vi.fn()
    await files.download(ticker, day, '2025-01-11', onProgress)
    expect(onProgress).toHaveBeenCalledTimes(11)
    expect(fetcher.mock.calls.map(([url]) => {
      const query = new URL(String(url)).searchParams
      return [query.get('begin'), query.get('end')]
    })).toEqual([['1735660800000', '1736438400000'], ['1736524800000', '1736524800000']])
  })

  it('handles dates nearest to the anchor first and publishes each available date without resetting existing scans', async () => {
    const days = ['2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04', '2025-01-05']
    useDirectory(Object.fromEntries(days.map(day => [`${ticker}-trades-${day}.zip`, new Blob([example])])))
    const files = new OkxLocalFiles()
    await files.pick()
    const scanRevision = files.scanRevision
    const verifyOrder = async (anchor: string, expected: string[]) => {
      const seen: string[] = []
      const initial = files.revision
      await files.download(ticker, days[0], days.at(-1)!, result => {
        seen.push(result.day)
        expect(result.status).toBe('existing')
        expect(files.revision).toBe(initial + seen.length)
        expect(files.scanRevision).toBe(scanRevision)
      }, undefined, anchor)
      expect(seen).toEqual(expected)
    }
    await verifyOrder('2025-01-03', [days[2], days[1], days[3], days[0], days[4]])
    await verifyOrder('2025-01-06', [...days].reverse())
  })

  it('removes a newly-created file when the official download is incomplete', async () => {
    const { contents } = useDirectory()
    const fetcher = vi.fn<typeof fetch>(async input => String(input).startsWith('https://www.okx.com/')
      ? Response.json({ code: '0', data: [{ details: [{ groupDetails: [{ filename: name,
        url: `https://static.okx.com/cdn/archives/${name}` }] }] }] })
      : new Response(example.slice(0, 40)))
    const files = new OkxLocalFiles(fetcher)
    await files.pick()
    const onProgress = vi.fn()
    await files.download(ticker, day, day, onProgress)
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ day, status: 'failed' }))
    expect([...contents]).toEqual([])
  })

  it('cancels an in-progress archive download and can retry that day', async () => {
    const { contents } = useDirectory()
    const abort = new AbortController()
    const cancel = vi.fn()
    const interrupted = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) { controller.enqueue(example.slice(0, 40)) },
      cancel,
    })
    const fetcher = vi.fn<typeof fetch>(async input => String(input).startsWith('https://www.okx.com/')
      ? Response.json({ code: '0', data: [{ details: [{ groupDetails: [{ filename: name,
        url: `https://static.okx.com/cdn/archives/${name}` }] }] }] })
      : new Response(abort.signal.aborted ? example : interrupted))
    const files = new OkxLocalFiles(fetcher)
    await files.pick()
    const onProgress = vi.fn()
    const pending = files.download(ticker, day, day, onProgress, abort.signal)
    await vi.waitFor(() => expect(contents.has(name)).toBe(true))
    const stopped = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await stopped
    expect(cancel).toHaveBeenCalledOnce()
    expect(contents.has(name)).toBe(false)
    expect(onProgress).not.toHaveBeenCalled()

    await files.download(ticker, day, day, onProgress)
    expect(onProgress).toHaveBeenCalledWith({ day, status: 'saved' })
    expect(new Uint8Array(await contents.get(name)!.arrayBuffer())).toEqual(example)
  })
})
