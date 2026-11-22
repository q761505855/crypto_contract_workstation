import { GitHubConflictError, type GitHubContentsClient, type GitHubFile } from '../../github-sync/github-client'

const pollMs = 12_000
const writes = new WeakMap<GitHubContentsClient, Promise<unknown>>()
const readOptions = (signal: AbortSignal) => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    function abort() {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function requestRecord(file: GitHubFile, symbol: string, day: string): {
  requestedManually?: boolean; state?: 'awaiting-source' | 'retrying' | 'failed' | 'unavailable'; retryAt?: number
} {
  const record = JSON.parse(new TextDecoder().decode(file.bytes))
  if (record?.version !== 1 || record.symbol !== symbol || record.day !== day ||
      (record.state !== undefined && !['awaiting-source', 'retrying', 'failed', 'unavailable'].includes(record.state))) {
    throw new Error('日归档请求无效')
  }
  return record
}

function needsRequest(file: GitHubFile | null, symbol: string, day: string): boolean {
  if (!file) return true
  const { requestedManually, state } = requestRecord(file, symbol, day)
  return requestedManually !== true || state === 'failed' || state === 'unavailable'
}

export async function ensureTradeDay(venue: 'OKX' | 'Bybit', hasArchive: (ref?: string) => Promise<boolean>,
  client: GitHubContentsClient, symbol: string, day: string,
  status: (message: string) => void, signal: AbortSignal, wake: () => void): Promise<boolean> {
  if (await hasArchive()) return true
  const path = `data/${venue.toLowerCase()}-requests/${symbol}/${day}.json`
  const input = new TextEncoder().encode(JSON.stringify({ version: 1, symbol, day, requestedManually: true }))
  async function published() {
    const { commitSha } = await client.getSnapshot(readOptions(signal))
    return hasArchive(commitSha)
  }

  // A branch-level Raw 404 can be stale. Check the current commit before enqueueing.
  if (await published()) return true
  let file = await client.getFile(path, readOptions(signal))
  if (needsRequest(file, symbol, day)) {
    const previous = writes.get(client) ?? Promise.resolve()
    const write = previous.then(async () => {
      signal.throwIfAborted()
      if (!client.canWrite()) throw new Error('下载日档需要可写的云端缓存连接')
      for (let attempt = 0; ; attempt++) {
        status(`正在申请下载 ${symbol} ${day} UTC 日档…`)
        try {
          await client.putFile(path, input, `申请缓存 ${venue} ${symbol} ${day} 日成交`, file?.sha, readOptions(signal).signal)
          return null
        } catch (error) {
          if (!(error instanceof GitHubConflictError)) throw error
          file = await client.getFile(path, readOptions(signal))
          if (!needsRequest(file, symbol, day)) return file
          if (!file && await published()) return undefined
          if (attempt === 2) throw error
          await wait(600, signal)
        }
      }
    })
    writes.set(client, write.catch(() => undefined))
    const result = await write
    if (result === undefined) return true
    file = result
  }

  for (;;) {
    signal.throwIfAborted()
    if (file) {
      const { state, retryAt } = requestRecord(file, symbol, day)
      if (state === 'unavailable') return false
      if (state === 'failed') throw new Error(`${symbol} ${day} UTC 日档下载多次失败，请稍后再试`)
      if (!state || (typeof retryAt === 'number' && Date.now() >= retryAt)) wake()
      status(state === 'awaiting-source' ? `${day} UTC 日档等待 Bybit 发布…` : state === 'retrying'
        ? '日档下载遇到临时错误，后台将继续重试…' : `等待后台下载并缓存 ${symbol} ${day} UTC 日档…`)
    } else {
      wake()
      status(`等待后台下载并缓存 ${symbol} ${day} UTC 日档…`)
    }
    await wait(pollMs, signal)
    try {
      file = await client.getFile(path, readOptions(signal))
      if (!file && await published()) return true
    } catch {
      signal.throwIfAborted()
      status('暂时无法查询日档进度，正在自动重试…')
      await wait(pollMs, signal)
    }
  }
}
