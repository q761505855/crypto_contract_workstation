import { GitHubConflictError, type GitHubContentsClient, type GitHubFile } from '../../github-sync/github-client'
import type { BybitArchive } from './archive'
import { BYBIT_DAY_MS, bybitDayStart, bybitFirstDay, type BybitSymbol } from './trades'

const pollMs = 12_000
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

function requestState(file: GitHubFile, symbol: BybitSymbol, day: string): 'awaiting-source' | 'retrying' | 'failed' | 'unavailable' | undefined {
  const record = JSON.parse(new TextDecoder().decode(file.bytes))
  if (record?.version !== 1 || record.symbol !== symbol || record.day !== day ||
      (record.state !== undefined && !['awaiting-source', 'retrying', 'failed', 'unavailable'].includes(record.state))) {
    throw new Error('Bybit 日归档请求无效')
  }
  return record.state
}

export async function ensureBybitDay(archive: BybitArchive, client: GitHubContentsClient, symbol: BybitSymbol, day: string,
  status: (message: string) => void, signal: AbortSignal): Promise<void> {
  if (day < bybitFirstDay(symbol) || bybitDayStart(day) + BYBIT_DAY_MS > Date.now()) {
    throw new Error('请选择该品种已结束的 UTC 日期')
  }
  if (await archive.hasDay(symbol, day)) return
  const path = `data/bybit-requests/${symbol}/${day}.json`
  const input = new TextEncoder().encode(JSON.stringify({ version: 1, symbol, day }))
  async function published() {
    const { commitSha } = await client.getSnapshot(readOptions(signal))
    return archive.hasDay(symbol, day, commitSha)
  }

  // A branch-level Raw 404 can be stale. Check the current commit before enqueueing.
  if (await published()) return
  let file = await client.getFile(path, readOptions(signal))
  for (let attempt = 0; !file || requestState(file, symbol, day) === 'failed'; attempt++) {
    if (!client.canWrite()) throw new Error('自动缓存需要可用的云端连接，已缓存的日期仍可回放')
    status(`正在申请下载 ${symbol} ${day} UTC 日档…`)
    try {
      await client.putFile(path, input, `申请缓存 Bybit ${symbol} ${day} 日成交`, file?.sha, readOptions(signal).signal)
      file = null
      break
    } catch (error) {
      if (!(error instanceof GitHubConflictError)) throw error
      file = await client.getFile(path, readOptions(signal))
      if (!file && await published()) return
      if (!file || requestState(file, symbol, day) === 'failed') {
        if (attempt === 2) throw error
        await wait(600, signal)
      }
    }
  }

  for (;;) {
    signal.throwIfAborted()
    if (file) {
      const state = requestState(file, symbol, day)
      if (state === 'unavailable') throw new Error(`Bybit 未提供 ${symbol} ${day} UTC 逐笔归档`)
      if (state === 'failed') throw new Error(`${symbol} ${day} UTC 日档下载多次失败，请稍后再试`)
      status(state === 'awaiting-source' ? '等待 Bybit 发布当日逐笔归档…' : state === 'retrying'
        ? '日档下载遇到临时错误，后台将继续重试…' : `等待后台下载并缓存 ${symbol} ${day} UTC 日档…`)
    } else status(`等待后台下载并缓存 ${symbol} ${day} UTC 日档…`)
    await wait(pollMs, signal)
    try {
      file = await client.getFile(path, readOptions(signal))
      if (!file && await published()) return
    } catch {
      signal.throwIfAborted()
      status('暂时无法查询日档进度，正在自动重试…')
      await wait(pollMs, signal)
    }
  }
}
