import { expect, test, type WebSocketRoute } from '@playwright/test'
import { strToU8, zipSync } from 'fflate'
import { connectFixture } from './ctrader-fixture'
import { installViewportProbe } from './viewport-probe'

const instrument = 'US500-USDT-SWAP'
const start = Date.parse('2026-11-20T14:20:00Z')
const headers = { 'access-control-allow-origin': '*' }

test('OKX 实时和历史逐笔按 ID 衔接，手动下载 UTC 日档并保存在浏览器', async ({ page }) => {
  await page.clock.setFixedTime(start + 30_000)
  await connectFixture(page, false, { historyAvailable: stamp => stamp >= start - 86_400_000 })
  await installViewportProbe(page)
  let live: WebSocketRoute | undefined
  let bybitRequests = 0
  await page.route('https://api.bybit.com/**', route => {
    if (new URL(route.request().url()).searchParams.get('symbol') === 'SPYUSDT') bybitRequests++
    return route.fulfill({ headers, json: { retCode: 0, result: { list: [] } } })
  })
  await page.route('https://raw.githubusercontent.com/**/bybit-trades/**', route => route.fulfill({ headers, status: 404 }))
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
  const archivedDays: string[] = []
  await page.route('https://www.okx.com/api/v5/**', route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('history-trades')) {
      const data = url.searchParams.get('instId') === instrument ? [trade('1', 5000, '5')] : []
      return route.fulfill({ headers, json: { code: '0', data } })
    }
    const day = new Date(Number(url.searchParams.get('begin')) + 8 * 3600_000).toISOString().slice(0, 10)
    const filename = `${instrument}-trades-${day}.zip`
    return route.fulfill({ headers, json: { code: '0', data: [{ details: [{ groupDetails: [
      { filename, url: `https://static.okx.com/cdn/${filename}` },
    ] }] }] } })
  })
  await page.route('https://static.okx.com/cdn/**', route => {
    const filename = new URL(route.request().url()).pathname.split('/').at(-1)!
    const day = filename.slice(-14, -4)
    archivedDays.push(day)
    const time = Date.parse(day + 'T03:00:00+08:00')
    const asset = strToU8(`instrument_name,trade_id,side,price,size,created_time\n${instrument},100,buy,1.1002,11,${time}\n`)
    return route.fulfill({ headers, body: Buffer.from(zipSync({ 'trades.csv': asset })) })
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
  await expect.poll(volume).toBe(5)
  expect(live).toBeDefined()
  live!.send(JSON.stringify({ arg: { channel: 'trades-all', instId: instrument }, data: [trade('1', 5000, '5'), trade('2', 15_000, '8')] }))
  await expect.poll(volume).toBe(13)
  expect(bybitRequests).toBe(0)

  await chart.getByRole('button', { name: '下载成交数据' }).click()
  const dialog = page.getByRole('dialog', { name: '下载成交数据' })
  await dialog.getByLabel('开始日期').fill('2026-11-19')
  await dialog.getByLabel('结束日期').fill('2026-11-19')
  await dialog.getByRole('button', { name: '下载', exact: true }).click()
  await expect(chart.getByRole('status')).toContainText('已缓存 OKX 1 天')
  expect(archivedDays).toEqual(['2026-11-19', '2026-11-20'])
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
  await expect(chart.getByRole('status')).toContainText('已缓存 OKX 1 天')
  expect(archivedDays).toHaveLength(2)
})
