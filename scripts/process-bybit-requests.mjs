import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { archiveInputs, archiveRoot, BybitArchiveHttpError, cacheBybitDay } from './cache-bybit-day.mjs'
import { cacheOkxDay, coveredBybitSymbols, okxArchiveInputs, okxArchiveRoot, OkxArchiveMissing, okxReplacement } from './cache-okx-day.mjs'

export const requestRoot = archiveRoot.replace(/bybit-trades$/, 'bybit-requests')
export const okxRequestRoot = okxArchiveRoot.replace(/okx-trades$/, 'okx-requests')
const bybit = { name: 'Bybit', requestRoot, archiveRoot, inputs: archiveInputs, cache: cacheBybitDay }
const okx = { name: 'OKX', requestRoot: okxRequestRoot, archiveRoot: okxArchiveRoot, inputs: okxArchiveInputs, cache: cacheOkxDay }
const attemptLimit = 4
const jobLimit = 8
const hour = 3_600_000

function readRequests(git, now, { requestRoot, inputs }) {
  const paths = git('ls-files', '-z', '--stage', '--', requestRoot).split('\0')
  return paths.flatMap(entry => {
    const [index, path] = entry.split('\t')
    if (!path || !index.startsWith('100644 ')) return []
    const match = /^([A-Z0-9-]+)\/(\d{4}-\d\d-\d\d)\.json$/.exec(path.slice(requestRoot.length + 1))
    if (!match) return []
    const [, symbol, day] = match
    try {
      const start = inputs(symbol, day, now)
      if (Number(git('cat-file', '-s', `HEAD:${path}`)) > 512) return []
      const record = JSON.parse(git('show', `HEAD:${path}`))
      if (record?.version !== 1 || record.requestedManually !== true || record.symbol !== symbol || record.day !== day) return []
      if (record.state === 'unavailable' || record.state === 'failed') return []
      const { state, attempts = 0, retryAt = 0 } = record
      if ((state !== undefined && state !== 'awaiting-source' && state !== 'retrying') ||
          !Number.isSafeInteger(attempts) || attempts < 0 || attempts >= attemptLimit ||
          !Number.isSafeInteger(retryAt) || retryAt > now) return []
      return [{ path, symbol, day, start, attempts, retryAt }]
    } catch { return [] }
  }).sort((a, b) => a.retryAt - b.retryAt || b.day.localeCompare(a.day))
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
  return processRequests({ repository, fetcher, now, log, venue: bybit })
}

export async function processOkxRequests({ repository, fetcher = fetch, now = Date.now(), log = console.log }) {
  return processRequests({ repository, fetcher, now, log, venue: okx })
}

function hasOkxArchive(git, readBlob, symbol, day) {
  if (!symbol) return false
  const directory = `${okxArchiveRoot}/${symbol}/${day}`
  if (!git('ls-tree', 'HEAD', '--', `${directory}/manifest.json`)) return false
  try {
    const manifest = JSON.parse(git('show', `HEAD:${directory}/manifest.json`))
    if (manifest.version !== 1 || manifest.symbol !== symbol || manifest.day !== day ||
        !Number.isSafeInteger(manifest.rows) || manifest.rows < 0 || !Array.isArray(manifest.parts)) return false
    let rows = 0
    let previous = ''
    for (const part of manifest.parts) {
      if (!/^\d\d-\d{3}\.csv\.gz$/.test(part.file) || part.file <= previous ||
          !Number.isInteger(part.hour) || part.hour < 0 || part.hour > 23 || Number(part.file.slice(0, 2)) !== part.hour ||
          !Number.isSafeInteger(part.rows) || part.rows <= 0 || !Number.isSafeInteger(part.bytes) ||
          part.bytes <= 0 || part.bytes > 17 * 1024 ** 2) return false
      const document = `HEAD:${directory}/${part.file}`
      if (Number(git('cat-file', '-s', document)) !== part.bytes ||
          createHash('sha256').update(readBlob(document)).digest('hex') !== part.sha256) return false
      rows += part.rows
      previous = part.file
    }
    return manifest.rows === rows
  } catch { return false }
}

async function processRequests({ repository, fetcher, now, log, venue }) {
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  const readBlob = path => execFileSync('git', ['-C', repository, 'show', path], {
    maxBuffer: 17 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const requests = readRequests(git, now, venue).slice(0, jobLimit)
  for (const { path, symbol, day, start, attempts } of requests) {
    const destination = `${venue.archiveRoot}/${symbol}/${day}`
    const superseded = venue === bybit && hasOkxArchive(git, readBlob, okxReplacement(symbol, day), day)
    const exists = git('ls-tree', 'HEAD', '--', `${destination}/manifest.json`).length > 0
    const archived = superseded || (exists && (venue === bybit || hasOkxArchive(git, readBlob, symbol, day)))
    let failed
    if (!archived) {
      try {
        if (exists) throw new Error('现有 OKX 日档校验失败')
        await venue.cache({ repository, symbol, day, fetcher, now })
      }
      catch (error) { failed = error }
    }
    if (failed) {
      const missing = failed instanceof OkxArchiveMissing || (failed instanceof BybitArchiveHttpError && failed.status === 404)
      // Yesterday's source file may arrive hours after the UTC day closes.
      const waiting = venue === bybit && missing && now - start < 60 * hour
      const state = waiting ? 'awaiting-source' : missing ? 'unavailable' : attempts + 1 >= attemptLimit ? 'failed' : 'retrying'
      const record = { version: 1, symbol, day, requestedManually: true, state, attempts: waiting ? 0 : attempts + 1,
        retryAt: now + (waiting ? hour : 10 * 60_000 * 2 ** attempts) }
      await writeFile(join(repository, path), JSON.stringify(record) + '\n')
      git('add', '--', path)
      git('commit', '-m', `更新 ${venue.name} ${symbol} ${day} 日成交缓存状态`)
      log(`${symbol} ${day} ${state} (${failed.message})`)
    } else {
      await rm(join(repository, path))
      git('add', '--sparse', '-A', '--', path, ...(archived ? [] : [destination]))
      const replaced = venue === okx ? coveredBybitSymbols(symbol, day) : superseded ? [symbol] : []
      for (const item of replaced) git('rm', '-r', '--sparse', '--ignore-unmatch', '--', `${archiveRoot}/${item}/${day}`)
      git('commit', '-m', `缓存 ${venue.name} ${symbol} ${day} 日成交`)
      log(`${symbol} ${day} ${archived ? '已缓存' : '归档完成'}`)
    }
    push(git)
  }
  return requests.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repository = process.argv[2]
  if (!repository) throw new Error('用法：node scripts/process-bybit-requests.mjs 存储仓库目录')
  await processOkxRequests({ repository })
  await processBybitRequests({ repository })
}
