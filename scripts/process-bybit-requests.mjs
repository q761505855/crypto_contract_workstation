import { execFileSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { archiveInputs, archiveRoot, BybitArchiveHttpError, cacheBybitDay } from './cache-bybit-day.mjs'

export const requestRoot = archiveRoot.replace(/bybit-trades$/, 'bybit-requests')
const attemptLimit = 4
const jobLimit = 3
const hour = 3_600_000

function readRequests(git, now) {
  const paths = git('ls-files', '-z', '--stage', '--', requestRoot).split('\0')
  return paths.flatMap(entry => {
    const [index, path] = entry.split('\t')
    if (!path || !index.startsWith('100644 ')) return []
    const match = /^([A-Z0-9]+)\/(\d{4}-\d\d-\d\d)\.json$/.exec(path.slice(requestRoot.length + 1))
    if (!match) return []
    const [, symbol, day] = match
    try {
      const start = archiveInputs(symbol, day, now)
      if (Number(git('cat-file', '-s', `HEAD:${path}`)) > 512) return []
      const record = JSON.parse(git('show', `HEAD:${path}`))
      if (record?.version !== 1 || record.symbol !== symbol || record.day !== day) return []
      if (record.state === 'unavailable' || record.state === 'failed') return []
      const { state, attempts = 0, retryAt = 0 } = record
      if ((state !== undefined && state !== 'awaiting-source' && state !== 'retrying') ||
          !Number.isSafeInteger(attempts) || attempts < 0 || attempts >= attemptLimit ||
          !Number.isSafeInteger(retryAt) || retryAt > now) return []
      return [{ path, symbol, day, start, attempts, retryAt }]
    } catch { return [] }
  }).sort((a, b) => a.retryAt - b.retryAt)
}

function push(git) {
  for (let attempt = 0; ; attempt++) {
    try { git('push', 'origin', 'HEAD:main'); return }
    catch (error) {
      if (attempt === 2) throw error
      git('pull', '--rebase', 'origin', 'main')
    }
  }
}

export async function processBybitRequests({ repository, fetcher = fetch, now = Date.now(), log = console.log }) {
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  const requests = readRequests(git, now).slice(0, jobLimit)
  for (const { path, symbol, day, start, attempts } of requests) {
    const destination = `${archiveRoot}/${symbol}/${day}`
    const archived = git('ls-tree', 'HEAD', '--', `${destination}/manifest.json`).length > 0
    let failed
    if (!archived) {
      try { await cacheBybitDay({ repository, symbol, day, fetcher }) }
      catch (error) { failed = error }
    }
    if (failed) {
      const missing = failed instanceof BybitArchiveHttpError && failed.status === 404
      // Yesterday's source file may arrive hours after the UTC day closes.
      const waiting = missing && now - start < 60 * hour
      const state = waiting ? 'awaiting-source' : missing ? 'unavailable' : attempts + 1 >= attemptLimit ? 'failed' : 'retrying'
      const record = { version: 1, symbol, day, state, attempts: waiting ? 0 : attempts + 1,
        retryAt: now + (waiting ? hour : 10 * 60_000 * 2 ** attempts) }
      await writeFile(join(repository, path), JSON.stringify(record) + '\n')
      git('add', '--', path)
      git('commit', '-m', `更新 Bybit ${symbol} ${day} 日成交缓存状态`)
      log(`${symbol} ${day} ${state} (${failed.message})`)
    } else {
      await rm(join(repository, path))
      git('add', '--sparse', '-A', '--', path, ...(archived ? [] : [destination]))
      git('commit', '-m', `缓存 Bybit ${symbol} ${day} 日成交`)
      log(`${symbol} ${day} ${archived ? '已缓存' : '归档完成'}`)
    }
    push(git)
  }
  return requests.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repository = process.argv[2]
  if (!repository) throw new Error('用法：node scripts/process-bybit-requests.mjs 存储仓库目录')
  await processBybitRequests({ repository })
}
