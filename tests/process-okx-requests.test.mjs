// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { zipSync } from 'fflate'
import { expect, it, vi } from 'vitest'
import { archiveRoot } from '../scripts/cache-bybit-day.mjs'
import { okxArchiveRoot } from '../scripts/cache-okx-day.mjs'
import { okxRequestRoot, processBybitRequests, processOkxRequests, requestRoot } from '../scripts/process-bybit-requests.mjs'

const day = '2026-11-12'
const previous = '2026-11-11'
const next = '2026-11-13'
const now = Date.parse('2026-11-16')
const symbol = 'US500-USDT-SWAP'
const okxRequest = `${okxRequestRoot}/${symbol}/${day}.json`
const bybitRequest = `${requestRoot}/SPYUSDT/${day}.json`
const replaced = `${archiveRoot}/SPYUSDT/${day}/manifest.json`
const retained = `${archiveRoot}/SPYUSDT/${previous}/manifest.json`
const primary = `${okxArchiveRoot}/${symbol}/${day}`
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })

it('完整发布 OKX 的 UTC 日后在同一提交清理对应 Bybit，并保护缺档、其他日期和其他项目', async () => {
  const base = await mkdtemp(join(tmpdir(), 'okx-requests-test-'))
  const remote = join(base, 'remote')
  const worker = join(base, 'worker')
  const write = async (file, value) => {
    const path = join(worker, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(value))
  }
  const request = (file, symbol) => write(file, { version: 1, symbol, day, requestedManually: true })
  let full = false
  const fixture = vi.fn(async url => {
    const address = new URL(url)
    if (address.host === 'www.okx.com') {
      const time = Number(address.searchParams.get('begin')) + 8 * 3600_000
      const date = new Date(time).toISOString().slice(0, 10)
      const filename = `${symbol}-trades-${date}.zip`
      return Response.json({ code: '0', data: !full && date === next ? [] : [{ details: [
        { groupDetails: [{ filename, url: `https://static.okx.com/cdn/${filename}` }] },
      ] }] })
    }
    const first = address.pathname.endsWith(`-${day}.zip`)
    const samples = first
      ? [[previous + 'T23:59:00Z', 1], [day + 'T00:10:00Z', 2]]
      : [[day + 'T16:10:00Z', 3], [next + 'T00:00:00Z', 4]]
    const csv = 'instrument_name,trade_id,side,price,size,created_time\n' +
      samples.map(([time, id]) => `${symbol},${id},buy,7000,2,${Date.parse(time)}\n`).join('')
    return new Response(zipSync({ 'day.csv': Buffer.from(csv) }))
  })
  try {
    git(base, 'init', '--bare', '--initial-branch=main', remote)
    git(base, 'clone', remote, worker)
    git(worker, 'config', 'user.name', 'Fixture')
    git(worker, 'config', 'user.email', 'fixture@example.invalid')
    await request(okxRequest, symbol)
    await request(bybitRequest, 'SPYUSDT')
    for (const path of [replaced, retained, 'projects/another-app/manifest.json']) await write(path, { retained: true })
    git(worker, 'add', '--all')
    git(worker, 'commit', '-m', '准备请求')
    git(worker, 'push', 'origin', 'main')
    git(worker, 'sparse-checkout', 'set', okxRequestRoot, requestRoot)

    const options = { repository: worker, fetcher: fixture, now, log: vi.fn() }
    expect(await processOkxRequests(options)).toBe(1)
    expect(JSON.parse(git(remote, 'show', `main:${okxRequest}`)), String(options.log.mock.calls)).toMatchObject({ state: 'unavailable' })
    expect(git(remote, 'ls-tree', 'main', '--', replaced).length).toBeGreaterThan(0)
    expect(git(remote, 'ls-tree', 'main', '--', primary)).toHaveLength(0)

    await request(okxRequest, symbol)
    git(worker, 'add', '--', okxRequest)
    git(worker, 'commit', '-m', '重新申请')
    git(worker, 'push', 'origin', 'main')
    full = true
    expect(await processOkxRequests(options)).toBe(1)
    const manifest = JSON.parse(git(remote, 'show', `main:${primary}/manifest.json`))
    expect(manifest).toMatchObject({ symbol, day, rows: 2 })
    expect(manifest.parts.map(part => part.hour)).toEqual([0, 16])
    expect(gunzipSync(git(remote, 'show', `main:${primary}/16-000.csv.gz`)).toString()).toContain(',3,Buy,7000,2')
    expect(git(remote, 'ls-tree', 'main', '--', replaced, okxRequest)).toHaveLength(0)
    expect(git(remote, 'ls-tree', 'main', '--', retained, 'projects/another-app/manifest.json').toString()).toContain(retained)
    expect(JSON.parse(git(remote, 'show', 'main:projects/another-app/manifest.json'))).toEqual({ retained: true })
    fixture.mockClear()
    expect(await processBybitRequests(options)).toBe(1)
    expect(fixture).not.toHaveBeenCalled()
    expect(git(remote, 'ls-tree', 'main', '--', replaced, bybitRequest)).toHaveLength(0)
  } finally { await rm(base, { recursive: true, force: true }) }
}, 60_000)
