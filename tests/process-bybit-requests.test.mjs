import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { expect, it, vi } from 'vitest'
import { archiveRoot } from '../scripts/cache-bybit-day.mjs'
import { processBybitRequests, requestRoot } from '../scripts/process-bybit-requests.mjs'

const git = (repository, ...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const day = '2026-06-18'
const now = Date.parse('2026-06-21')
const requestPath = symbol => `${requestRoot}/${symbol}/${day}.json`
const archivePath = symbol => `${archiveRoot}/${symbol}/${day}/manifest.json`

it('处理使用者请求，重试暂时不可用的日档，原子发布后复用现有缓存', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bybit-requests-test-'))
  const remote = join(base, 'remote')
  const worker = join(base, 'worker')
  const author = join(base, 'author')
  const writeRequest = async symbol => {
    const path = join(author, requestPath(symbol))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, symbol, day }))
  }
  const identify = repository => {
    git(repository, 'config', 'user.name', 'Fixture')
    git(repository, 'config', 'user.email', 'fixture@example.invalid')
  }
  const response = symbol => new Response(new Uint8Array(gzipSync(
    `timestamp,symbol,side,size,price,trdMatchID\n${Date.parse(day) / 1000},${symbol},Buy,1,700,trade\n`,
  )))
  const fetcher = vi.fn(async url => {
    if (url.includes('/XAUUSDT/')) return new Response(null, { status: 404 })
    if (url.includes('/QQQUSDT/')) return new Response(null, { status: 503 })
    // Another project advances the shared branch while the download is running.
    git(author, 'pull', '--ff-only')
    await writeFile(join(author, 'unrelated.txt'), '保留这次提交')
    git(author, 'commit', '-am', '更新其他项目')
    git(author, 'push', 'origin', 'main')
    return response('SPYUSDT')
  })
  try {
    git(base, 'init', '--bare', '--initial-branch=main', remote)
    git(base, 'clone', remote, author)
    identify(author)
    await writeFile(join(author, 'unrelated.txt'), '初始值')
    for (const symbol of ['SPYUSDT', 'QQQUSDT', 'XAUUSDT']) await writeRequest(symbol)
    git(author, 'add', '--all')
    git(author, 'commit', '-m', '申请历史成交')
    git(author, 'push', 'origin', 'main')
    git(base, 'clone', remote, worker)
    identify(worker)
    git(worker, 'sparse-checkout', 'set', requestRoot)

    const messages = []
    const run = (time, source = fetcher) => processBybitRequests({ repository: worker, fetcher: source, now: time, log: text => messages.push(text) })
    expect(await run(now)).toBe(3)
    expect(messages.join('\n')).toContain(`SPYUSDT ${day} 归档完成`)
    expect(JSON.parse(git(remote, 'show', `main:${archivePath('SPYUSDT')}`))).toMatchObject({ day, rows: 1 })
    expect(git(remote, 'ls-tree', 'main', '--', requestPath('SPYUSDT'))).toBe('')
    expect(JSON.parse(git(remote, 'show', `main:${requestPath('QQQUSDT')}`))).toMatchObject({ state: 'retrying', attempts: 1 })
    expect(JSON.parse(git(remote, 'show', `main:${requestPath('XAUUSDT')}`))).toMatchObject({ state: 'unavailable' })
    expect(git(remote, 'show', 'main:unrelated.txt')).toBe('保留这次提交')
    expect(await run(now + 1000)).toBe(0)
    expect(fetcher).toHaveBeenCalledTimes(3)

    git(author, 'pull', '--ff-only')
    await writeRequest('SPYUSDT')
    git(author, 'add', requestPath('SPYUSDT'))
    git(author, 'commit', '-m', '同时申请已有归档')
    git(author, 'push', 'origin', 'main')
    git(worker, 'pull', '--ff-only')
    const retry = vi.fn(async () => response('QQQUSDT'))
    expect(await run(now + 10 * 60_000, retry)).toBe(2)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(JSON.parse(git(remote, 'show', `main:${archivePath('QQQUSDT')}`))).toMatchObject({ day, rows: 1 })
    expect(git(remote, 'ls-tree', 'main', '--', requestPath('SPYUSDT'), requestPath('QQQUSDT'))).toBe('')
  } finally { await rm(base, { recursive: true, force: true }) }
}, 60_000)
