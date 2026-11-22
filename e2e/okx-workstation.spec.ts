import { expect, test, type WebSocketRoute } from '@playwright/test'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { connectFixture } from './ctrader-fixture'
import { installViewportProbe } from './viewport-probe'

const instrument = 'US500-USDT-SWAP'
const start = Date.parse('2027-02-20T14:20:00Z')
const headers = { 'access-control-allow-origin': '*' }

test('OKX 实时和历史逐笔按 ID 衔接，手动申请 UTC 日档并复用 Git 缓存', async ({ page }) => {
  await page.clock.install({ time: start + 30_000 })
  await connectFixture(page, false, { historyAvailable: stamp => stamp >= start - 86_400_000 })
  await installViewportProbe(page)
  let live: WebSocketRoute | undefined
  let bybitRequests = 0
  let historyRequests = 0
  let archiveRequests = 0
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
  await page.route('https://www.okx.com/api/v5/market/history-trades?*', route => {
    const query = new URL(route.request().url()).searchParams
    historyRequests++
    expect(query.get('instId')).toBe(instrument)
    expect(Number(query.get('after'))).toBeGreaterThanOrEqual(start + 30_000)
    const data = [trade('2', 15_000, '8'), trade('1', 5000, '5')]
    return route.fulfill({ headers, json: { code: '0', data } })
  })
  const day = '2026-11-19'
  const part = gzipSync(`${Date.parse(day + 'T19:00:00Z') / 1000},100,Buy,1.1002,11\n`)
  const requested: unknown[] = []
  let dispatched = false
  let published = false
  await page.route('https://raw.githubusercontent.com/**/okx-trades/**', route => {
    archiveRequests++
    const url = route.request().url()
    if (published && url.endsWith(`/${instrument}/${day}/manifest.json`)) return route.fulfill({ headers, json: {
      version: 1, day, symbol: instrument, rows: 1, parts: [{
        file: '19-000.csv.gz', hour: 19, rows: 1, bytes: part.length, sha256: createHash('sha256').update(part).digest('hex'),
      }],
    } })
    if (published && url.endsWith(`/${instrument}/${day}/19-000.csv.gz`)) return route.fulfill({ headers, body: part })
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
    if (path.endsWith('/git/ref/heads/main')) return route.fulfill({ headers, json: { object: { sha: 'test-commit' } } })
    if (path.endsWith('/git/commits/test-commit')) return route.fulfill({ headers, json: { tree: { sha: 'test-tree' } } })
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
  expect(archiveRequests).toBe(0)
  live!.send(JSON.stringify({ arg: { channel: 'trades-all', instId: instrument }, data: [trade('2', 15_000, '8')] }))
  await expect.poll(volume).toBe(8)

  await chart.getByRole('button', { name: '下载成交数据' }).click()
  const dialog = page.getByRole('dialog', { name: '下载成交数据' })
  await expect(dialog.getByLabel('开始日期')).toHaveValue('2027-02-20')
  expect(historyRequests).toBe(0)
  expect(archiveRequests).toBe(0)
  await dialog.getByRole('button', { name: '下载', exact: true }).click()
  await expect(chart.getByRole('status')).toContainText('OKX 接口 1 天')
  await expect.poll(volume).toBe(13)
  expect(historyRequests).toBe(1)
  expect(archiveRequests).toBe(0)
  expect(bybitRequests).toBe(0)

  await chart.getByRole('button', { name: '下载成交数据' }).click()
  await dialog.getByLabel('开始日期').fill('2026-11-19')
  await dialog.getByLabel('结束日期').fill('2026-11-19')
  await dialog.getByRole('button', { name: '下载', exact: true }).click()
  await expect.poll(() => dispatched).toBe(true)
  expect(requested).toEqual([{ version: 1, day, symbol: instrument, requestedManually: true }])
  published = true
  await page.clock.fastForward(13_000)
  await expect(chart.getByRole('status')).toContainText('OKX 日档 1 天')
  const archivedTrade = await page.evaluate(async stamp => {
    const { source } = (window as unknown as { __viewportTestAdapter: {
      source: import('../src/market-data/bybit/combined-source').CombinedBybitSource
    } }).__viewportTestAdapter
    return (await source.readArchivedHour(stamp))?.[0]
  }, Date.parse('2026-11-19T19:00:00Z'))
  expect(archivedTrade).toMatchObject({ id: '100', venue: 'OKX', size: 11 })
  await chart.getByRole('button', { name: '下载成交数据' }).click()
  await dialog.getByLabel('开始日期').fill('2026-11-19')
  await dialog.getByLabel('结束日期').fill('2026-11-19')
  await dialog.getByRole('button', { name: '下载', exact: true }).click()
  await expect(chart.getByRole('status')).toContainText('OKX 日档 1 天')
  expect(requested).toHaveLength(1)
  expect(historyRequests).toBe(1)
})
