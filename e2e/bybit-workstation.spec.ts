import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { installViewportProbe } from './viewport-probe'

const archiveDay = '2026-06-18'
const start = Date.parse(archiveDay)
const second = start / 1000
const part = gzipSync(`${second + 1}.000001,first,Buy,716,36\n${second + 2},second,Sell,717,2\n${second + 65},later,Buy,725,40\n${second + 362},last,Sell,720,3\n`)
const manifest = {
  version: 1, symbol: 'SPYUSDT', day: archiveDay, rows: 4,
  parts: [{ file: '00-000.csv.gz', hour: 0, rows: 4, bytes: part.byteLength,
    sha256: createHash('sha256').update(part).digest('hex') }],
}
const headers = { 'access-control-allow-origin': '*' }

test('Bybit 工作区接收实时成交并按 UTC 日回放 Git 归档', async ({ page }) => {
  const inspect = await installViewportProbe(page)
  await page.addInitScript(() => {
    const labels = new Set<string>()
    Object.assign(window, { bybitProfileLabels: labels })
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (/^(POC|VAH|VAL) /.test(text)) labels.add(text.slice(0, 3))
      if (maxWidth === undefined) original.call(this, text, x, y)
      else original.call(this, text, x, y, maxWidth)
    }
  })
  const minute = Math.floor(Date.now() / 60_000) * 60_000
  const now = minute + 20_000
  await page.clock.setFixedTime(minute + 30_000)
  let subscriptions = 0
  await page.route('**/cloud-connection.json', route => route.fulfill({ status: 404, headers }))
  await page.route('**/ctrader-connection.json', route => route.fulfill({ status: 404, headers }))
  await page.route('https://api.github.com/**', route => route.fulfill({ status: 404, headers }))
  await page.route('https://raw.githubusercontent.com/**/bybit-trades/**', route => {
    const url = route.request().url()
    if (url.endsWith(`/${archiveDay}/manifest.json`)) return route.fulfill({ headers, json: manifest })
    if (url.endsWith(`/${archiveDay}/00-000.csv.gz`)) return route.fulfill({ headers, body: part })
    return route.fulfill({ status: 404, headers })
  })
  await page.route('https://api.bybit.com/v5/market/recent-trade?**', route => route.fulfill({ headers,
    json: { retCode: 0, result: { list: [{ symbol: 'SPYUSDT', execId: 'rest', time: String(now), side: 'Buy', price: '700', size: '1' }] } },
  }))
  await page.routeWebSocket('wss://stream.bybit.com/v5/public/linear', socket => {
    socket.onMessage(message => {
      const event = JSON.parse(message.toString())
      if (event.op === 'subscribe') {
        subscriptions++
        socket.send(JSON.stringify({ op: 'subscribe', success: true }))
        socket.send(JSON.stringify({ topic: 'publicTrade.SPYUSDT', data: [
          { T: now, s: 'SPYUSDT', S: 'Buy', v: '1', p: '700', i: 'rest' },
          { T: now + 10, s: 'SPYUSDT', S: 'Sell', v: '5', p: '701', i: 'socket' },
        ] }))
      }
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '工具', exact: true }).click()
  await page.getByRole('button', { name: 'Bybit 逐笔成交' }).click()
  await expect(page.getByRole('heading', { name: 'Bybit 逐笔成交' })).toBeVisible()
  await expect.poll(async () => (await inspect()).last).toMatchObject({ close: 701, volume: 6 })

  await page.getByLabel('UTC 日期').fill(archiveDay)
  await page.getByRole('button', { name: '历史回放', exact: true }).click()
  await expect.poll(async () => (await inspect()).last).toMatchObject({ close: 717, volume: 38 })
  await page.getByText('指标', { exact: true }).click()
  await page.locator('.klinecharts-pro-indicator-modal-list').getByText('大单气泡（Big Trades）', { exact: true }).click()
  await page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  const bubbles = () => page.evaluate(() => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    const indicator = coreChart.getIndicatorByPaneId('candle_pane', 'BIG_TRADES') as import('klinecharts').Indicator | null
    return indicator?.extendData?.points?.map((point: { trade: { id: string } }) => point.trade.id)
  })
  await expect.poll(bubbles).toEqual(['first'])
  await page.getByRole('button', { name: '前进一步' }).click()
  await expect.poll(async () => (await inspect()).last).toMatchObject({ close: 725, volume: 78 })
  await expect.poll(bubbles).toEqual(['first', 'later'])

  await page.getByLabel('UTC 起点').fill('00:06')
  await page.getByRole('button', { name: '历史回放', exact: true }).click()
  await expect.poll(async () => (await inspect()).last).toMatchObject({ close: 720, volume: 3 })
  const geometry = page.locator('.klinecharts-pro-drawing-bar > .item').nth(2)
  await geometry.locator('.icon-arrow').click()
  await page.getByText('框选成交分布', { exact: true }).click()
  const locations = await page.evaluate(() => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    coreChart.setPaneOptions({ id: 'candle_pane', gap: { top: 0.24, bottom: 0.24 } })
    const bounds = coreChart.getDom('candle_pane', 'main' as import('klinecharts').DomPosition)!.getBoundingClientRect()
    const point = (index: number, value: number) => {
      const coord = coreChart.convertToPixel({ dataIndex: index, value }, { paneId: 'candle_pane' }) as { x: number; y: number }
      return { x: bounds.left + coord.x, y: bounds.top + coord.y }
    }
    return { first: point(0, 725.5), corner: point(1, 715.5) }
  })
  const profile = () => page.evaluate(() => {
    const adapter = (window as unknown as { __viewportTestAdapter: {
      coreChart: import('klinecharts').Chart
      orderFlow: { profiles: Map<string, unknown> }
      drawings: { editing?: unknown }
    } }).__viewportTestAdapter
    const id = [...adapter.orderFlow.profiles.keys()][0]
    const overlay = adapter.coreChart.getOverlayById(id) as (import('klinecharts').Overlay & { isDrawing(): boolean }) | null
    const profile = overlay?.extendData?.profile
    return profile ? {
      id, vah: profile.vah, val: profile.val,
      drawing: overlay?.isDrawing(), editing: adapter.drawings.editing,
      volume: profile.rows.reduce((sum: number, row: { buy: number; sell: number }) => sum + row.buy + row.sell, 0),
    } : null
  })
  await page.mouse.click(locations.first.x, locations.first.y)
  await page.mouse.move(locations.corner.x, locations.corner.y)
  await expect.poll(profile).toMatchObject({ volume: 78 })
  await expect.poll(() => page.evaluate(() =>
    [...(window as unknown as { bybitProfileLabels: Set<string> }).bybitProfileLabels].sort(),
  )).toEqual(['POC', 'VAH', 'VAL'])
  await page.mouse.click(locations.corner.x, locations.corner.y)
  await expect.poll(profile, { timeout: 1500 }).toMatchObject({ drawing: false })
  const actualCorner = await page.evaluate(({ id, targetPrice }) => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    const overlay = coreChart.getOverlayById(id)!
    const bounds = coreChart.getDom('candle_pane', 'main' as import('klinecharts').DomPosition)!.getBoundingClientRect()
    const second = overlay.points[1]
    const toScreen = (point: typeof second) => {
      const position = coreChart.convertToPixel(point, { paneId: 'candle_pane' }) as { x: number; y: number }
      return { x: bounds.left + position.x, y: bounds.top + position.y }
    }
    const first = toScreen(overlay.points[0])
    const handle = toScreen(second)
    return { handle, target: toScreen({ ...second, value: targetPrice }),
      center: { x: (first.x + handle.x) / 2, y: (first.y + handle.y) / 2 } }
  }, { id: (await profile())!.id, targetPrice: 722 })
  await expect.poll(async () => {
    // KLineCharts creates the interactive handles on the first paint after hover.
    await page.mouse.move(actualCorner.center.x, actualCorner.center.y)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.mouse.move(actualCorner.handle.x, actualCorner.handle.y)
    return page.evaluate(() => {
      const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: {
        getChartStore(): { getOverlayStore(): { getHoverInstanceInfo(): { figureType: number; figureIndex: number } } }
      } } }).__viewportTestAdapter
      const { figureType, figureIndex } = coreChart.getChartStore().getOverlayStore().getHoverInstanceInfo()
      return { figureType, figureIndex }
    })
  }).toEqual({ figureType: 1, figureIndex: 1 })
  await page.mouse.down()
  await expect.poll(async () => (await profile())?.editing, { timeout: 1500 }).toBeDefined()
  await page.mouse.move(actualCorner.target.x, actualCorner.target.y, { steps: 5 })
  await expect.poll(profile).toMatchObject({ volume: 40 })
  await page.mouse.up()

  await page.getByRole('button', { name: '回到实时' }).click()
  await expect.poll(async () => (await inspect()).last).toMatchObject({ close: 701, volume: 6 })
  expect(subscriptions).toBe(1)
  await page.getByRole('button', { name: '返回工作站' }).click()
  await expect(page.getByRole('heading', { name: /cTrader/ })).toBeVisible()
})
