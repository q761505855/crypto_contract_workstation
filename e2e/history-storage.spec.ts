import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { installArchiveFixtures } from './archive-fixtures'
import { traceNativeRestoreWrites } from './storage-diagnostics'
import { writeFile } from 'node:fs/promises'
import { installCachedMarketFixture, seedSymbolListing } from './market-fixtures'

const project = 'projects/crypto-contract-workstation'
const repoApi = '/repos/q761505855/personal-cloud-storage'
const clockTime = Date.UTC(2025, 10, 1, 0, 1)
// Each case validates native IndexedDB round-trips for complete 43k-minute months.
test.setTimeout(120_000)
interface StoredFile { bytes: Buffer; sha: string }
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')

async function mockCloud(page: Page, failWrites = false) {
  const foreignPath = 'projects/another-tool/config/preferences.json'
  const foreignBytes = Buffer.from('{"theme":"dark"}')
  const initial = new Map<string, StoredFile>([
    [foreignPath, { bytes: foreignBytes, sha: digest(foreignBytes) }],
    ['storage.json', {bytes:Buffer.from('{"projects":["another-tool","crypto-contract-workstation"]}'),sha:'registry'}],
  ])
  const trees = new Map<string, Map<string, StoredFile>>([['tree-0', initial]])
  const commits = new Map<string, {tree:string; parent?:string}>([['commit-0', {tree:'tree-0'}]])
  const blobs = new Map<string, Buffer>()
  let head = 'commit-0'
  let sequence = 0
  const writes: string[] = []
  const requests: Array<{ url: string; method: string; startedAt: number; finishedAt?: number; failed?: string; status?: number }> = []
  const byRequest = new WeakMap<import('@playwright/test').Request, typeof requests[number]>()
  page.context().on('request', request => {
    if (!request.url().startsWith('https://api.github.com/')) return
    const entry = { url: request.url(), method: request.method(), startedAt: Date.now() }
    requests.push(entry)
    byRequest.set(request, entry)
  })
  page.context().on('response', response => {
    const entry = byRequest.get(response.request())
    if (entry) entry.status = response.status()
  })
  page.context().on('requestfinished', request => {
    const entry = byRequest.get(request)
    if (entry) entry.finishedAt = Date.now()
  })
  page.context().on('requestfailed', request => {
    const entry = byRequest.get(request)
    if (entry) { entry.finishedAt = Date.now(); entry.failed = request.failure()?.errorText }
  })
  const current = () => trees.get(commits.get(head)!.tree)!
  await page.context().route('https://api.github.com/**', async route => {
    const request = route.request()
    const path = decodeURIComponent(new URL(request.url()).pathname)
    const suffix = path.startsWith(repoApi) ? path.slice(repoApi.length) : ''
    if (!path.startsWith(repoApi)) { await route.fulfill({status:404,json:{}}); return }
    if (failWrites && request.method() !== 'GET') { await route.fulfill({status:503,json:{message:'Temporary cloud write failure'}}); return }
    if (request.method() === 'GET' && suffix === '') {
      await route.fulfill({json:{full_name:'q761505855/personal-cloud-storage',private:false,default_branch:'main',permissions:{push:true}}}); return
    }
    if (suffix === '/git/ref/heads/main') { await route.fulfill({json:{object:{sha:head}}}); return }
    if (request.method() === 'GET' && suffix.startsWith('/git/commits/')) {
      const commit = commits.get(suffix.split('/').at(-1)!)
      await route.fulfill({status:commit?200:404,json:commit?{tree:{sha:commit.tree}}:{}}); return
    }
    if (suffix.startsWith('/contents/')) {
      const name = suffix.slice('/contents/'.length)
      expect(name.startsWith(`${project}/`)).toBe(true)
      if (request.method() === 'GET') {
        const ref = new URL(request.url()).searchParams.get('ref')!
        const snapshot = ref === 'main' ? current() : trees.get(commits.get(ref)?.tree ?? '')
        const file = snapshot?.get(name)
        if (!file) { await route.fulfill({status:404,json:{}}); return }
        if (request.headers().accept?.includes('raw+json')) { await route.fulfill({body:file.bytes}); return }
        await route.fulfill({json:{type:'file',path:name,sha:file.sha,size:file.bytes.length,encoding:'base64',content:file.bytes.toString('base64')}}); return
      }
      if (request.method() === 'PUT') {
        const body = request.postDataJSON()
        const existing = current().get(name)
        if ((existing?.sha ?? undefined) !== body.sha) {await route.fulfill({status:409,json:{}}); return}
        const bytes = Buffer.from(body.content, 'base64')
        const sha = digest(bytes)
        current().set(name, {bytes,sha}); writes.push(name)
        await route.fulfill({json:{content:{sha}}}); return
      }
    }
    if (request.method() === 'POST' && suffix === '/git/blobs') {
      const bytes = Buffer.from(request.postDataJSON().content, 'base64')
      const sha = digest(bytes); blobs.set(sha, bytes)
      await route.fulfill({json:{sha}}); return
    }
    if (request.method() === 'POST' && suffix === '/git/trees') {
      const body = request.postDataJSON()
      const next = new Map(trees.get(body.base_tree))
      for (const entry of body.tree) {
        expect(entry.path.startsWith(`${project}/`)).toBe(true)
        next.set(entry.path, {bytes:blobs.get(entry.sha)!,sha:entry.sha}); writes.push(entry.path)
      }
      const sha = `tree-${++sequence}`; trees.set(sha,next)
      await route.fulfill({json:{sha}}); return
    }
    if (request.method() === 'POST' && suffix === '/git/commits') {
      const body = request.postDataJSON(); const sha = `commit-${++sequence}`
      commits.set(sha,{tree:body.tree,parent:body.parents[0]})
      await route.fulfill({json:{sha}}); return
    }
    if (request.method() === 'PATCH' && suffix === '/git/refs/heads/main') {
      const body = request.postDataJSON()
      if (commits.get(body.sha)?.parent !== head || body.force !== false) {await route.fulfill({status:422,json:{}}); return}
      head = body.sha; await route.fulfill({json:{object:{sha:head}}}); return
    }
    await route.fulfill({status:404,json:{}})
  })
  return {current,writes,requests,foreignPath,foreignBytes,setWriteFailure:(failed:boolean)=>{failWrites=failed}}
}

async function start(page: Page, failWrites = false, fullMonth = false) {
  await page.clock.install({time:clockTime})
  const archives = await installArchiveFixtures(page, {}, {now:clockTime})
  const cloud = await mockCloud(page, failWrites)
  const restRequests: string[] = []
  await page.route('https://fapi.binance.com/**', async route => {
    const url = new URL(route.request().url())
    await page.clock.fastForward(7_000)
    if (url.pathname.endsWith('/exchangeInfo')) {
      await route.fulfill({json:{symbols:[{symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING',onboardDate:fullMonth?Date.UTC(2019,9,2):Date.UTC(2025,10,1),pricePrecision:2,quantityPrecision:3}]}}); return
    }
    restRequests.push(url.toString())
    const from = Number(url.searchParams.get('startTime'))
    const to = Number(url.searchParams.get('endTime'))
    const rows: unknown[][] = []
    for (let at = Math.ceil(from/60_000)*60_000; at<=to && rows.length<499; at+=60_000) {
      rows.push([at,'60000','60010','59990','60001','1',at+59_999,'60001',1,'0','0','0'])
    }
    await route.fulfill({json:rows})
  })
  await page.routeWebSocket('wss://fstream.binance.com/**', () => {})
  if (fullMonth) {
    // Only warm the unrelated current chart. September remains a complete,
    // cold archive upload/download and native IndexedDB round-trip below.
    await installCachedMarketFixture(page, {}, false, true)
  } else {
    // Upload retry/configuration cases need a real upload, not a 43k-row month.
    await seedSymbolListing(page, Date.UTC(2025, 10, 1))
  }
  await page.goto('./')
  await expect(page.getByRole('button', {name:'创建回放',exact:true})).toBeEnabled({timeout:30_000})
  return {archives,cloud,restRequests}
}

test('keeps failed background uploads visible outside data management and retries them', { tag: '@integration' }, async ({page}) => {
  const {cloud} = await start(page, true)
  const status = page.getByTestId('history-upload-status')
  await expect(status).toContainText('已缓存，云端待上传：')
  await expect(page.getByTestId('data-manager')).not.toBeVisible()
  expect(cloud.current().has(`${project}/data/market-history/BTCUSDT/1m/2025/11.json.gz`)).toBe(false)
  await status.click()
  const drawer = page.getByTestId('data-manager')
  await expect(drawer).toBeVisible()
  cloud.setWriteFailure(false)
  await drawer.getByRole('button',{name:'重试待上传',exact:true}).click()
  await expect(status).not.toBeVisible({timeout:30_000})
  expect(cloud.current().has(`${project}/data/market-history/BTCUSDT/1m/2025/11.json.gz`)).toBe(true)
  expect(cloud.current().get(cloud.foreignPath)!.bytes.equals(cloud.foreignBytes)).toBe(true)
})

test('prepares full minute months, automatically uploads and reads cloud without touching other projects', { tag: '@integration' }, async ({page}) => {
  const {archives,cloud,restRequests} = await start(page, false, true)
  page.on('dialog', dialog => dialog.accept())
  await page.getByRole('button',{name:'图表周期',exact:true}).click()
  await page.getByRole('button',{name:'选择周期 5m',exact:true}).click()
  await page.getByTestId('open-data-manager').click()
  const drawer = page.getByTestId('data-manager')
  await expect(drawer.getByTestId('github-owner')).toHaveValue('q761505855')
  await expect(drawer.getByTestId('github-repository')).toHaveValue('personal-cloud-storage')
  await expect(drawer.getByTestId('github-token')).toHaveValue('')
  await drawer.getByLabel('开始时间').fill('2025-09-12T12:00')
  await drawer.getByLabel('结束时间').fill('2025-09-13T12:00')
  await expect(drawer.getByTestId('history-range-preview')).toContainText('UTC')
  await expect(drawer.getByText(/标记价格/)).toHaveCount(0)
  await drawer.getByRole('button',{name:'下载历史数据'}).click()
  await expect(drawer.getByText(/下载完成/)).toBeVisible({timeout:60_000})
  const path = `${project}/data/market-history/BTCUSDT/1m/2025/09.json.gz`
  await expect.poll(() => {
    const value = cloud.current().get(path)
    return value ? JSON.parse(gunzipSync(value.bytes).toString()).tradeCandles.length : 0
  },{timeout:30_000}).toBe(43_200)
  const chunk = JSON.parse(gunzipSync(cloud.current().get(path)!.bytes).toString())
  expect(chunk.tradeCandles).toHaveLength(43_200)
  expect(chunk).not.toHaveProperty('markCandles')
  expect(archives.requests.some(url => /markPrice/i.test(url))).toBe(false)
  expect(restRequests.some(url => /markPrice/i.test(url))).toBe(false)
  expect(cloud.current().get(cloud.foreignPath)!.bytes.equals(cloud.foreignBytes)).toBe(true)
  expect(cloud.current().has('storage.json')).toBe(true)
  expect(restRequests.every(url => Number(new URL(url).searchParams.get('startTime')) >= Date.UTC(2025,9,31))).toBe(true)
  const archiveCount = archives.requests.filter(url => url.includes('-2025-09.')).length
  await drawer.getByRole('button',{name:'删除当前缓存'}).click()
  await expect(drawer.locator('.cache-summary').filter({hasText:'普通 K 线'})).toContainText('0 根')
  await drawer.getByTestId('close-data-manager').click()
  await traceNativeRestoreWrites(page, '.status-footer')
  const controls = page.getByTestId('replay-controls')
  await controls.getByRole('button',{name:'时间定位',exact:true}).click()
  const timeDialog = page.getByRole('dialog',{name:'图表时间定位',exact:true})
  await timeDialog.getByLabel('图表跳转时间').fill('2025-09-15T12:00')
  await timeDialog.getByRole('button',{name:'跳转',exact:true}).click()
  try {
    // Cold cloud reads persist both complete minute series in native IndexedDB.
    await expect(page.locator('.status-footer')).toContainText('图表已跳转到',{timeout:60_000})
  } catch (error) {
    const diagnosticsPath = test.info().outputPath('cold-cloud-readback-diagnostics.json')
    await writeFile(diagnosticsPath, JSON.stringify({
      footer: await page.locator('.status-footer').textContent(),
      controls: await controls.textContent(), githubRequests: cloud.requests,
      activeGitHubRequests: cloud.requests.filter(request => request.finishedAt === undefined),
      archiveRequests: archives.requests, restRequests,
      nativeStorage: await page.evaluate(() => (window as unknown as { nativeRestoreTrace?: unknown }).nativeRestoreTrace ?? null),
    }, null, 2))
    await test.info().attach('cold-cloud-readback-diagnostics', {path:diagnosticsPath,contentType:'application/json'})
    const snapshotPath = test.info().outputPath('cold-cloud-files.json')
    await writeFile(snapshotPath, JSON.stringify({files:[...cloud.current()].map(([path,file]) => ({path,sha:file.sha,contentBase64:file.bytes.toString('base64')}))}))
    await test.info().attach('cold-cloud-files', {path:snapshotPath,contentType:'application/json'})
    throw error
  }
  expect(archives.requests.filter(url => url.includes('-2025-09.')).length).toBe(archiveCount)
  // Creating the session reuses ordinary minutes restored from the Git month.
  await expect(controls.getByText(/起点：/)).toContainText('2025/9/15 12:00')
  const beforeCreateArchives = archives.requests.length
  const beforeCreateRest = restRequests.length
  await controls.getByRole('button',{name:'回放设置',exact:true}).click()
  const replayDialog = page.getByRole('dialog',{name:'回放会话设置',exact:true})
  await replayDialog.getByLabel('回放结束时间').fill('2025-09-15T12:10')
  await replayDialog.getByRole('button',{name:'应用设置',exact:true}).click()
  await controls.getByRole('button',{name:'创建回放',exact:true}).click()
  await expect(controls).toContainText('1/3',{timeout:30_000})
  expect(archives.requests.length).toBe(beforeCreateArchives)
  expect(restRequests.length).toBe(beforeCreateRest)
})

test('round-trips user configuration using the default connection without entering git information', { tag: '@integration' }, async ({page}) => {
  const {cloud} = await start(page)
  page.on('dialog', dialog => dialog.accept())
  await page.getByTestId('open-data-manager').click()
  const drawer = page.getByTestId('data-manager')
  await drawer.getByRole('button',{name:'收藏',exact:true}).click()
  await drawer.getByLabel('会话与交易',{exact:true}).uncheck()
  await drawer.getByLabel('历史行情',{exact:true}).uncheck()
  await expect.poll(() => cloud.current().has(`${project}/data/market-history/BTCUSDT/1m/2025/11.json.gz`)).toBe(true)
  await drawer.getByTestId('github-upload').click()
  await expect(drawer.getByText(/上传完成：/)).toBeVisible({timeout:30_000})
  const config = cloud.current().get(`${project}/config/preferences.json`)
  const favorites = cloud.current().get(`${project}/config/favorites.json`)
  expect(config).toBeDefined(); expect(favorites).toBeDefined()
  expect(config!.bytes.toString()).not.toContain('e2e-mock-storage-token')
  expect(JSON.parse(favorites!.bytes.toString()).favoriteSymbols).toContain('BTCUSDT')
  await drawer.getByRole('button',{name:'取消收藏',exact:true}).click()
  await drawer.getByTestId('github-pull').click()
  await expect(drawer.getByTestId('backup-status')).toContainText('云端恢复完成',{timeout:30_000})
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('marketData.favoriteSymbols') ?? '[]'))).toContain('BTCUSDT')
  expect(cloud.current().get(cloud.foreignPath)!.bytes.equals(cloud.foreignBytes)).toBe(true)
})
