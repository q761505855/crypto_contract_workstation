import { expect, test, type WebSocketRoute } from '@playwright/test'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { strToU8, zipSync } from 'fflate'
import { connectFixture } from './ctrader-fixture'
import { installViewportProbe } from './viewport-probe'

const instrument = 'US500-USDT-SWAP'
const start = Date.parse('2027-02-20T14:20:00Z')
const headers = { 'access-control-allow-origin': '*' }

test('OKX-本地读取已有 ZIP、下载新归档并在刷新后继续使用', async ({ page }) => {
  const ticker = 'BTC-USDT-SWAP'
  const folderName = 'OKX daily archives'
  const existingDay = '2026-11-18'
  const newDay = '2026-11-19'
  const existingStart = Date.parse(`${existingDay}T02:15:00Z`)
  const newStart = Date.parse(`${newDay}T02:15:00Z`)
  const archive = (day: string, timestamp: number, price: number) => {
    const basename = `${ticker}-trades-${day}`
    const lines = Array.from({ length: 12 }, (_, index) => {
      const time = timestamp + index * 5 * 60_000
      return `${ticker},${time},buy,${price + index},1,${time}`
    })
    const csv = ['instrument_name,trade_id,side,price,size,created_time', ...lines].join('\n')
    return { name: `${basename}.zip`, bytes: Buffer.from(zipSync({ [`${basename}.csv`]: strToU8(csv) })) }
  }
  const existing = archive(existingDay, existingStart, 61_000)
  const download = archive(newDay, newStart, 62_000)
  const downloadUrl = `https://static.okx.com/cdn/archives/${download.name}`

  await page.clock.setFixedTime(new Date('2026-11-20T15:00:45Z'))
  await connectFixture(page)
  const chart = await installViewportProbe(page)
  await page.addInitScript(({ folderName, name, bytes }) => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => {
      const root = await navigator.storage.getDirectory()
      const folder = await root.getDirectoryHandle(folderName, { create: true })
      const existing = await folder.getFileHandle(name, { create: true })
      if (!(await existing.getFile()).size) {
        const writer = await existing.createWritable()
        await writer.write(new Uint8Array(bytes))
        await writer.close()
      }
      return folder
    } })
  }, { folderName, name: existing.name, bytes: [...existing.bytes] })

  const requests: string[] = []
  const sockets: string[] = []
  await page.routeWebSocket(/^wss:\/\/[^/]*okx\.com\//, socket => { sockets.push(socket.url()) })
  await page.route('https://www.okx.com/api/v5/**', route => {
    const endpoint = new URL(route.request().url()).pathname.split('/').at(-1)!
    requests.push(endpoint)
    const data = endpoint === 'market-data-history' ? [{ details: [{ groupDetails: [{ filename: download.name, url: downloadUrl }] }] }]
      : endpoint === 'instruments' ? [{ instId: ticker, instFamily: 'BTC-USDT', state: 'live', ctType: 'linear',
        settleCcy: 'USDT', ctVal: '0.01', ctMult: '1', minSz: '0.1', lotSz: '0.1', maxMktSz: '1000', tickSz: '0.5',
        lever: '75', listTime: String(Date.parse('2021-09-01T00:00:00Z')) }]
      : endpoint === 'position-tiers' ? [{ instFamily: 'BTC-USDT', maxSz: '1000', mmr: '0.004', maxLever: '50' }]
      : []
    return route.fulfill({ headers, json: { code: '0', data } })
  })
  await page.route(downloadUrl, route => route.fulfill({ headers, contentType: 'application/zip', body: download.bytes }))

  await page.goto('/')
  const source = page.getByLabel('行情来源')
  await source.selectOption({ label: 'OKX-本地' })
  await expect(source).toHaveValue('okx-local')
  const syncStatus = page.getByTestId('config-sync-status')
  await expect(syncStatus).toHaveText('配置已保存在本机，云端连接只读')
  await expect(syncStatus.getByRole('button', { name: '立即重试' })).toHaveCount(0)
  await page.getByRole('button', { name: '本地数据管理', exact: true }).click()
  const data = page.getByRole('dialog', { name: 'OKX 本地数据' })
  await data.getByRole('button', { name: '选择文件夹' }).click()
  await expect(data.getByRole('list', { name: '本地 ZIP 文件' })).toContainText(existing.name)
  await data.getByRole('button', { name: '关闭OKX 本地数据' }).click()
  await expect.poll(async () => (await chart()).last).toMatchObject({ open: 61_009, close: 61_011 })

  await page.getByRole('button', { name: '本地数据管理', exact: true }).click()
  await data.getByLabel('开始日期').fill(newDay)
  await data.getByLabel('结束日期').fill(newDay)
  await data.getByRole('button', { name: '下载 ZIP' }).click()
  await expect(data.getByRole('list', { name: '下载结果' })).toContainText('已保存')
  await expect(data.getByRole('list', { name: '本地 ZIP 文件' })).toContainText(download.name)
  const saved = await page.evaluate(async ({ folderName, filename }) => {
    const root = await navigator.storage.getDirectory()
    const folder = await root.getDirectoryHandle(folderName)
    const file = await (await folder.getFileHandle(filename)).getFile()
    return Array.from(new Uint8Array(await file.arrayBuffer()))
  }, { folderName, filename: download.name })
  expect(Buffer.from(saved)).toEqual(download.bytes)
  await data.getByRole('button', { name: '关闭OKX 本地数据' }).click()
  await expect.poll(async () => (await chart()).last).toMatchObject({ open: 62_009, close: 62_011 })

  await page.reload()
  await expect(source).toHaveValue('okx-local')
  await expect(syncStatus).toHaveText('配置已保存在本机，云端连接只读')
  await expect.poll(async () => (await chart()).last).toMatchObject({ open: 62_009, close: 62_011 })
  expect(requests).toEqual(['market-data-history'])

  const controls = page.getByTestId('replay-controls')
  await expect(controls.getByRole('button', { name: '创建回放', exact: true })).toBeEnabled()
  await controls.getByRole('button', { name: '时间定位', exact: true }).click()
  const locate = page.getByRole('dialog', { name: '图表时间定位' })
  const dateInput = (time: number) => page.evaluate(time => {
    const offset = new Date(time).getTimezoneOffset()
    return new Date(time - offset * 60_000).toISOString().slice(0, 16)
  }, time)
  await expect(locate.getByLabel('图表跳转时间')).toHaveValue(await dateInput(newStart + 45 * 60_000))
  const replayStart = await dateInput(newStart + 15 * 60_000)
  await locate.getByLabel('图表跳转时间').fill(replayStart)
  await locate.getByRole('button', { name: '跳转', exact: true }).click()
  await expect(controls.locator('.replay-start-time')).toContainText(replayStart.replace('T', ' '))
  await controls.getByRole('button', { name: '创建回放', exact: true }).click()
  await expect(controls).toContainText('第 1 步')
  await expect(controls.getByLabel('步进周期')).toHaveValue('1m')
  await expect(controls.getByRole('option', { name: '逐笔 Tick' })).toHaveCount(0)
  await controls.getByRole('button', { name: '下一根', exact: true }).click()
  await expect(controls).toContainText('第 2 步')

  await page.getByRole('button', { name: '工具', exact: true }).click()
  await page.getByTestId('open-data-manager').click()
  await expect(page.getByRole('heading', { name: 'OKX-本地 行情', exact: true })).toBeVisible()
  await expect(page.getByLabel('备份回放会话').getByRole('option')).toContainText('OKX-本地')
  expect(new Set(requests)).toEqual(new Set(['market-data-history', 'instruments', 'position-tiers']))
  expect(sockets).toEqual([])
})

test('切换到 OKX 后使用原生产品、实时 K 线、回放和合约交易规格', async ({ page }) => {
  const minute = 60_000
  const now = Date.UTC(2026, 10, 20, 15, 0, 45)
  const btc = 'BTC-USDT-SWAP'
  const eth = 'ETH-USDT-SWAP'
  await page.clock.setFixedTime(now)
  await connectFixture(page)
  await installViewportProbe(page)
  const topics = new Map<string, WebSocketRoute>()
  const requests: { endpoint: string; instrument: string | null; bar: string | null }[] = []
  await page.routeWebSocket('wss://ws.okx.com/ws/v5/business', socket => socket.onMessage(message => {
    if (message.toString() === 'ping') { socket.send('pong'); return }
    const packet = JSON.parse(message.toString())
    if (packet.op !== 'subscribe') return
    const arg = packet.args[0]
    topics.set(`${arg.instId}:${arg.channel}`, socket)
    socket.send(JSON.stringify({ event: 'subscribe', arg }))
  }))
  const candle = (stamp: number, price: number, closed: boolean, mark = false) =>
    [String(stamp), String(price), String(price + 2), String(price - 2), String(price + 1),
      ...(mark ? [] : ['200', '2', '4000']), closed ? '1' : '0']
  await page.route('https://www.okx.com/api/v5/**', route => {
    const url = new URL(route.request().url())
    const endpoint = url.pathname.split('/').at(-1)!
    const inst = url.searchParams.get('instId')
    const bar = url.searchParams.get('bar')
    requests.push({ endpoint, instrument: inst, bar })
    let data: unknown[] = []
    if (endpoint === 'instruments') data = [btc, eth, 'BTC-USD-SWAP'].map(instId => ({
      instId, instFamily: instId.slice(0, -5), state: 'live', ctType: 'linear', settleCcy: instId === 'BTC-USD-SWAP' ? 'BTC' : 'USDT',
      ctVal: instId === eth ? '0.1' : '0.01', ctMult: '1', minSz: '0.1', lotSz: '0.1', maxMktSz: '1000',
      tickSz: '0.5', lever: '75', listTime: String(now - 365 * 86_400_000),
    }))
    else if (endpoint === 'position-tiers') {
      expect(url.searchParams.get('tdMode')).toBe('isolated')
      const instFamily = url.searchParams.get('instFamily')
      data = [{ instFamily, maxSz: '1000', mmr: '0.004', maxLever: '50' },
        { instFamily, maxSz: '5000', mmr: '0.005', maxLever: '25.5' }]
    } else if (endpoint.endsWith('candles')) {
      const width = Number.parseInt(bar ?? '1') * (bar?.endsWith('H') ? 60 : 1) * minute
      const after = Number(url.searchParams.get('after') ?? now + 1)
      const start = Math.floor(Math.min(now, after - 1) / width) * width
      data = Array.from({ length: Number(url.searchParams.get('limit')) }, (_, index) => {
        const stamp = start - index * width
        return candle(stamp, inst === eth ? 2000 : 60_000, stamp + width <= now, endpoint.includes('mark-price'))
      })
    }
    return route.fulfill({ headers, json: { code: '0', data } })
  })
  await page.goto('/')
  const source = page.getByLabel('行情来源')
  const footer = page.getByRole('contentinfo')
  const chart = page.getByTestId('chart-host')
  const controls = page.getByTestId('replay-controls')
  await expect(footer).toContainText('EURUSD')
  await source.selectOption('okx')
  await expect(page.getByRole('heading', { name: 'OKX 行情回放工作站' })).toBeVisible()
  await expect(footer).toContainText(btc)
  await chart.locator('.symbol').click()
  const picker = page.getByRole('dialog', { name: '选择交易对' })
  await picker.getByRole('tab', { name: '全部' }).click()
  await expect(picker.getByRole('button', { name: '选择 EURUSD', exact: true })).toHaveCount(0)
  await expect(picker.getByRole('button', { name: '选择 BTC-USD-SWAP', exact: true })).toHaveCount(0)
  await picker.getByRole('button', { name: `选择 ${eth}`, exact: true }).click()
  await expect(footer).toContainText(eth)
  const topic = `${eth}:candle15m`
  await expect.poll(() => topics.has(topic)).toBe(true)
  const stamp = Math.floor(now / (15 * minute)) * 15 * minute
  topics.get(topic)!.send(JSON.stringify({ arg: { channel: 'candle15m', instId: eth }, data: [candle(stamp, 2014, false)] }))
  await expect(page.getByRole('region', { name: '实时行情摘要' })).toContainText('2015')

  await controls.getByRole('button', { name: '时间定位', exact: true }).click()
  const locate = page.getByRole('dialog', { name: '图表时间定位' })
  await locate.getByLabel('图表跳转时间').fill(await page.evaluate(time => {
    const offset = new Date(time).getTimezoneOffset()
    return new Date(time - offset * 60_000).toISOString().slice(0, 16)
  }, stamp - 45 * minute))
  await locate.getByRole('button', { name: '跳转', exact: true }).click()
  await expect(footer).toContainText('图表已跳转到')
  expect(requests.some(request => request.endpoint === 'history-candles' && request.instrument === eth)).toBe(true)
  await controls.getByRole('button', { name: '回放设置', exact: true }).click()
  const setup = page.getByRole('dialog', { name: '回放会话设置' })
  await setup.getByText('OKX 逐仓交易规格', { exact: true }).click()
  await expect(setup.getByText('0.1 / 0.1', { exact: true })).toBeVisible()
  const leverage = setup.getByRole('spinbutton', { name: '杠杆倍率（×）' })
  await expect(leverage).toHaveValue('10')
  await leverage.fill('51')
  await expect(setup.getByRole('button', { name: '开始历史回放' })).toBeDisabled()
  await leverage.fill('12')
  await setup.getByRole('button', { name: '开始历史回放' }).click()
  await expect(controls).toContainText('第 1 步')
  const order = page.getByRole('complementary', { name: '模拟下单面板' })
  await expect(order.getByRole('spinbutton', { name: '合约张数' })).toHaveValue('0.1')
  await order.getByRole('button', { name: '计算预估' }).click()
  await expect(order.getByText('0.010005', { exact: true })).toBeVisible()
  await order.getByRole('button', { name: '开多', exact: true }).click()
  await expect(page.getByTestId('position-long')).toContainText(eth)
  await controls.getByRole('button', { name: '下一根', exact: true }).click()
  await expect(controls).toContainText('第 2 步')
  expect(requests.some(request => request.endpoint.endsWith('mark-price-candles') && request.instrument === eth)).toBe(true)

  await source.selectOption('ctrader')
  await expect(footer).toContainText('EURUSD')
  await expect(page.getByTestId('position-long')).toHaveCount(0)
  await source.selectOption('okx')
  await expect(controls).toContainText('第 2 步')
  await expect(page.getByTestId('position-long')).toContainText(eth)
  await page.reload()
  await expect(source).toHaveValue('okx')
  await expect(page.getByTestId('position-long')).toContainText(eth)
  await page.getByRole('button', { name: '工具', exact: true }).click()
  await page.getByTestId('open-data-manager').click()
  const [download] = await Promise.all([page.waitForEvent('download'),
    page.getByRole('button', { name: '导出全部数据' }).click()])
  const envelope = JSON.parse(await readFile((await download.path())!, 'utf8'))
  const backup = envelope.data
  expect(backup.preferences).toMatchObject({ priceSource: 'okx', okxSelectedSymbol: { ticker: eth } })
  expect(backup.sessions[0]).toMatchObject({ marketSource: 'okx', tradingConfig: { okx: { contractValue: '0.1' }, leverage: 12 } })
  expect(backup.simulations[0].config.okx).toEqual(backup.sessions[0].tradingConfig.okx)
  backup.preferences.priceSource = 'ctrader'
  page.once('dialog', dialog => dialog.accept())
  await page.getByTestId('import-backup-file').setInputFiles({
    name: 'switch-source.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      ...envelope, kind: 'preferences', data: { preferences: backup.preferences },
    })),
  })
  await expect(page.getByTestId('backup-status')).toContainText('刷新页面')
  await page.reload()
  await expect(source).toHaveValue('ctrader')
  await expect(footer).toContainText('EURUSD')
})

test('手动下载优先复用 OKX 日档，接口与实时按成交 ID 去重', async ({ page }) => {
  await page.clock.install({ time: start + 30_000 })
  await connectFixture(page, false, { historyAvailable: stamp => stamp >= start - 86_400_000 })
  await installViewportProbe(page)
  let live: WebSocketRoute | undefined
  let bybitRequests = 0
  let historyRequests = 0
  let historyProbes = 0
  let archiveRequests = 0
  let confirmedHistory = false
  await page.route('https://api.bybit.com/**', route => {
    if (new URL(route.request().url()).searchParams.get('symbol') === 'SPYUSDT') bybitRequests++
    return route.fulfill({ headers, json: { retCode: 0, result: { list: [] } } })
  })
  await page.route('https://raw.githubusercontent.com/**/bybit-trades/**', route => route.fulfill({ headers, status: 404 }))
  await page.route('**/cloud-connection.json', route => route.fulfill({ headers,
    json: { schemaVersion: 1, project: 'crypto-contract-workstation', token: 'cache-test-token' },
  }))
  await page.routeWebSocket('wss://ws.okx.com/ws/v5/business', socket => socket.onMessage(message => {
    if (message.toString() === 'ping') { socket.send('pong'); return }
    const { op, args } = JSON.parse(message.toString())
    if (op !== 'subscribe') return
    const arg = args[0]
    if (arg.instId === instrument) live = socket
    socket.send(JSON.stringify({ event: 'subscribe', arg }))
  }))
  const trade = (id: string, offset: number, size: string) =>
    ({ instId: instrument, tradeId: id, ts: String(start + offset), px: '1.1002', sz: size, side: 'buy' })
  let finishApiPage!: () => void
  const apiPage = new Promise<void>(resolve => { finishApiPage = resolve })
  await page.route('https://www.okx.com/api/v5/market/history-trades?*', async route => {
    expect(confirmedHistory).toBe(true)
    const query = new URL(route.request().url()).searchParams
    expect(query.get('instId')).toBe(instrument)
    // The live clock can advance between capturing the chart anchor and starting the download.
    if (query.get('limit') === '1') {
      historyProbes++
      expect(Number(query.get('after'))).toBeGreaterThanOrEqual(start + 30_000)
      return route.fulfill({ headers, json: { code: '0', data: [trade('201', 20_000, '2')] } })
    }
    historyRequests++
    if (query.get('type') === '1') {
      await apiPage
      return route.fulfill({ headers, json: { code: '0', data: [] } })
    }
    expect(Number(query.get('after'))).toBeGreaterThanOrEqual(start + 30_000)
    const data = [trade('200', 15_000, '8'), trade('199', 5000, '5'),
      ...Array.from({ length: 98 }, (_, index) => trade(String(198 - index), -60_000 - index, '1'))]
    return route.fulfill({ headers, json: { code: '0', data } })
  })
  const day = '2027-02-18'
  const recentDay = '2027-02-19'
  let officialChecks = 0
  await page.route('https://www.okx.com/api/v5/public/market-data-history?*', route => {
    officialChecks++
    const query = new URL(route.request().url()).searchParams
    expect(query.get('instFamilyList')).toBe('US500-USDT')
    if (query.get('begin') === String(Date.parse('2027-02-17T00:00:00+08:00'))) {
      return route.fulfill({ status: 503, headers })
    }
    expect(query.get('begin')).toBe(String(Date.parse(`${day}T00:00:00+08:00`)))
    expect(query.get('end')).toBe(String(Date.parse(`${recentDay}T00:00:00+08:00`)))
    return route.fulfill({ headers, json: { code: '0', data: [{ details: [{ groupDetails:
      [day, recentDay].map(date => ({ filename: `${instrument}-trades-${date}.zip` })),
    }] }] } })
  })
  const archiveParts = new Map([day, recentDay].map(date => [date,
    gzipSync(`${Date.parse(date + 'T19:00:00Z') / 1000},100,Buy,1.1002,11\n`)]))
  const manifestFor = (date: string, part: Buffer) => JSON.stringify({
    version: 1, day: date, symbol: instrument, rows: 1, parts: [{
      file: '19-000.csv.gz', hour: 19, rows: 1, bytes: part.length, sha256: createHash('sha256').update(part).digest('hex'),
    }],
  })
  const initialCommit = 'a'.repeat(40)
  const archiveCommit = 'b'.repeat(40)
  const mirrorManifests: string[] = []
  const mirrorReads: string[] = []
  const rawParts: string[] = []
  const requested: unknown[] = []
  let dispatched = false
  let published = false
  await page.route('https://testingcf.jsdelivr.net/gh/**/okx-trades/**', route => {
    const url = route.request().url()
    for (const [date, part] of archiveParts) {
      const ref = date === day ? archiveCommit : initialCommit
      if (url.endsWith(`/${instrument}/${date}/manifest.json`)) {
        expect(new URL(url).pathname).toContain(`/personal-cloud-storage@${ref}/`)
        mirrorManifests.push(date)
        return route.fulfill({ headers, body: manifestFor(date, part) })
      }
      if (!url.endsWith(`/${instrument}/${date}/19-000.csv.gz`)) continue
      expect(new URL(url).pathname).toContain(`/personal-cloud-storage@${ref}/`)
      mirrorReads.push(date)
      if (date === recentDay) return route.fulfill({ headers, body: part })
      const wrong = Buffer.from(part)
      wrong[wrong.length - 1] ^= 0xff
      return route.fulfill({ headers, body: wrong })
    }
    return route.fulfill({ status: 404, headers })
  })
  await page.route('https://raw.githubusercontent.com/**/okx-trades/**', route => {
    archiveRequests++
    const url = route.request().url()
    for (const [date, part] of archiveParts) {
      if (date === day && !published) continue
      if (url.endsWith(`/${instrument}/${date}/19-000.csv.gz`)) {
        rawParts.push(date)
        return route.fulfill({ headers, body: part })
      }
    }
    return route.fulfill({ status: 404, headers })
  })
  await page.route('https://api.github.com/**', route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && path.endsWith('/dispatches')) {
      expect(request.postDataJSON()).toEqual({ event_type: 'okx-trades-requested' })
      dispatched = true
      return route.fulfill({ headers, status: 204 })
    }
    if (path.endsWith('/git/ref/heads/main')) return route.fulfill({ headers, json: { object: { sha: published ? archiveCommit : initialCommit } } })
    if (path.endsWith(`/git/trees/${initialCommit}`) || path.endsWith(`/git/trees/${archiveCommit}`)) {
      const dates = path.endsWith(archiveCommit) ? [recentDay, day] : [recentDay]
      return route.fulfill({ headers, json: { truncated: false, tree: dates.map(date => {
        const content = manifestFor(date, archiveParts.get(date)!)
        const size = Buffer.byteLength(content)
        return { path: `projects/crypto-contract-workstation/experiments/ctrader/data/okx-trades/${instrument}/${date}/manifest.json`,
          type: 'blob', mode: '100644', size, sha: createHash('sha1').update(`blob ${size}\0`).update(content).digest('hex') }
      }) } })
    }
    if (path.endsWith(`/git/commits/${initialCommit}`) || path.endsWith(`/git/commits/${archiveCommit}`))
      return route.fulfill({ headers, json: { tree: { sha: 'test-tree' } } })
    if (request.method() === 'PUT' && path.endsWith(`/okx-requests/${instrument}/${day}.json`)) {
      requested.push(JSON.parse(Buffer.from(request.postDataJSON().content, 'base64').toString()))
      return route.fulfill({ status: 201, headers, json: { content: { sha: 'test-file' } } })
    }
    return route.fulfill({ status: 404, headers })
  })
  await page.goto('/')
  const chart = page.getByTestId('chart-host')
  await chart.locator('.symbol').click()
  const picker = page.getByRole('dialog', { name: '选择交易对' })
  await picker.getByRole('tab', { name: '全部' }).click()
  await picker.getByRole('button', { name: '选择 US500', exact: true }).click()
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 1m', exact: true }).click()
  const volume = () => page.evaluate(() => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    const panes = coreChart.getIndicatorByPaneId() as Map<string, Map<string, import('klinecharts').Indicator>>
    const indicator = [...panes.values()].find(pane => pane.has('VOL'))?.get('VOL')
    return indicator?.result.at(-1)?.volume
  })
  await expect.poll(() => live).toBeDefined()
  expect(historyRequests).toBe(0)
  expect(historyProbes).toBe(0)
  expect(archiveRequests).toBe(0)
  expect(officialChecks).toBe(0)
  live!.send(JSON.stringify({ arg: { channel: 'trades-all', instId: instrument }, data: [trade('200', 15_000, '8')] }))
  await expect.poll(volume).toBe(8)

  await chart.getByRole('button', { name: '下载成交数据' }).click()
  const dialog = page.getByRole('dialog', { name: '下载成交数据' })
  await expect(dialog.getByLabel('锚点日期')).toHaveValue('2027-02-20')
  await expect(dialog.getByLabel('往前天数')).toHaveValue('0')
  await expect(dialog.getByLabel('往后天数')).toHaveValue('0')
  await expect(dialog.getByText('2027-02-20', { exact: true })).toBeVisible()
  await dialog.getByLabel('往前天数').fill('1')
  await dialog.getByLabel('往后天数').fill('1')
  await expect(dialog.getByText('2027-02-19 至 2027-02-20')).toBeVisible()
  await expect(dialog.getByText('未来日期已跳过', { exact: false })).toBeVisible()
  expect(historyRequests).toBe(0)
  expect(historyProbes).toBe(0)
  expect(archiveRequests).toBe(0)
  const confirmRange = () => dialog.getByRole('button', { name: '下载', exact: true }).click()
  const review = dialog.getByRole('table', { name: '成交数据日期状态' })
  const dateRow = (date: string) => review.getByRole('row').filter({ hasText: date })
  async function answerHistoryPrompt(accept: boolean, archivedStatus: string) {
    await confirmRange()
    await expect(review.getByRole('row')).toHaveCount(3)
    await expect(dateRow(recentDay)).toContainText(archivedStatus)
    await expect(dateRow('2027-02-20')).toContainText('平台未归档')
    expect(historyRequests + historyProbes).toBe(0)
    confirmedHistory = accept
    await dialog.getByRole('button', { name: accept ? '下载归档并补齐近期数据' : '只下载归档' }).click()
  }
  await answerHistoryPrompt(false, 'Git 已缓存')
  await expect(chart.getByRole('status')).toContainText('OKX 日档 1 天')
  await expect(chart.getByRole('status')).toContainText('已跳过')
  expect(historyRequests + historyProbes).toBe(0)
  await chart.getByRole('button', { name: '下载成交数据' }).click()
  await dialog.getByLabel('往前天数').fill('1')
  await answerHistoryPrompt(true, '已加载')
  try {
    await expect.poll(() => historyRequests).toBe(2)
    await expect.poll(volume).toBe(13)
    await expect(chart.getByRole('status')).not.toContainText('OKX 接口 1 天')
    live!.send(JSON.stringify({ arg: { channel: 'trades-all', instId: instrument }, data: [trade('201', 20_000, '2')] }))
    await expect.poll(volume).toBe(15)
  } finally { finishApiPage() }
  await expect(chart.getByRole('status')).toContainText('OKX 接口 1 天 · OKX 日档 1 天')
  await expect.poll(volume).toBe(15)
  expect(historyRequests).toBe(2)
  expect(archiveRequests).toBe(0)
  expect(officialChecks).toBe(0)
  expect(bybitRequests).toBe(0)
  expect(dispatched).toBe(false)
  expect(requested).toHaveLength(0)
  const readArchivedTrade = (date: string) => page.evaluate(async stamp => {
    const { source } = (window as unknown as { __viewportTestAdapter: {
      source: import('../src/market-data/bybit/combined-source').CombinedBybitSource
    } }).__viewportTestAdapter
    return (await source.readArchivedHour(stamp))?.[0]
  }, Date.parse(`${date}T19:00:00Z`))
  expect(await readArchivedTrade(recentDay)).toMatchObject({ id: '100', venue: 'OKX', size: 11 })
  expect(mirrorReads).toEqual([recentDay])
  expect(mirrorManifests).toEqual([recentDay])
  expect(rawParts).toEqual([])

  await chart.getByRole('button', { name: '下载成交数据' }).click()
  await confirmRange()
  await expect(dateRow('2027-02-20')).toContainText('已加载至')
  await dialog.getByRole('button', { name: '只下载归档' }).click()
  expect(historyRequests).toBe(2)

  await chart.getByRole('button', { name: '下载成交数据' }).click()
  await dialog.getByLabel('锚点日期').fill(day)
  await dialog.getByLabel('往前天数').fill('0')
  await dialog.getByLabel('往后天数').fill('0')
  await confirmRange()
  await expect(dateRow(day)).toContainText('Git 未缓存')
  expect(dispatched).toBe(false)
  await dialog.getByRole('button', { name: '只下载归档' }).click()
  await expect.poll(() => dispatched).toBe(true)
  expect(officialChecks).toBe(1)
  expect(historyRequests).toBe(2)
  expect(requested).toEqual([{ version: 1, day, symbol: instrument, requestedManually: true }])
  published = true
  await page.clock.fastForward(13_000)
  await expect(chart.getByRole('status')).toContainText('OKX 日档 1 天')
  expect(await readArchivedTrade(day)).toMatchObject({ id: '100', venue: 'OKX', size: 11 })
  expect(mirrorReads).toEqual([recentDay, day])
  expect(mirrorManifests).toEqual([recentDay, day])
  expect(rawParts).toEqual([day])
  expect(archiveRequests).toBe(1)
  await chart.getByRole('button', { name: '下载成交数据' }).click()
  await dialog.getByLabel('锚点日期').fill(day)
  await dialog.getByLabel('往前天数').fill('0')
  await dialog.getByLabel('往后天数').fill('0')
  await confirmRange()
  await expect(dateRow(day)).toContainText('已加载')
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(chart.getByRole('status')).toContainText('OKX 日档 1 天')
  expect(requested).toHaveLength(1)
  expect(historyRequests).toBe(2)
  expect(officialChecks).toBe(1)

  await chart.getByRole('button', { name: '下载成交数据' }).click()
  await dialog.getByLabel('锚点日期').fill('2020-01-01')
  await dialog.getByLabel('往前天数').fill('0')
  await dialog.getByLabel('往后天数').fill('0')
  await confirmRange()
  await expect(dateRow('2020-01-01')).toContainText('平台未归档')
  await expect(dateRow('2020-01-01')).toContainText('超出 OKX 接口覆盖范围')
  await expect(dialog.getByRole('button', { name: '下载归档并补齐近期数据' })).toHaveCount(0)
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  expect(historyRequests).toBe(2)

  await chart.getByRole('button', { name: '下载成交数据' }).click()
  await dialog.getByLabel('锚点日期').fill('2027-02-17')
  await confirmRange()
  await expect(dateRow('2027-02-17')).toContainText('检查失败')
  await expect(dateRow('2027-02-17')).toContainText('HTTP 503')
  await expect(dialog.getByRole('button', { name: '下载归档并补齐近期数据' })).toHaveCount(0)
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  expect(historyRequests).toBe(2)
})
