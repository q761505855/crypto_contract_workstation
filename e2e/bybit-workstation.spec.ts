import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { installViewportProbe } from './viewport-probe'

const archiveDay = '2026-06-18'
const start = Date.parse(archiveDay)
const second = start / 1000
const part = gzipSync(`${second + 1}.000001,first,Buy,716,1\n${second + 2},second,Sell,717,2\n${second + 65},later,Buy,725,4\n`)
const manifest = {
  version: 1, symbol: 'SPYUSDT', day: archiveDay, rows: 3,
  parts: [{ file: '00-000.csv.gz', hour: 0, rows: 3, bytes: part.byteLength,
    sha256: createHash('sha256').update(part).digest('hex') }],
}
const headers = { 'access-control-allow-origin': '*' }

test('Bybit 工作区接收实时成交并按 UTC 日回放 Git 归档', async ({ page }) => {
  const inspect = await installViewportProbe(page)
  const now = Date.now() - 2_000
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
  await expect.poll(async () => (await inspect()).last).toMatchObject({ close: 717, volume: 3 })
  await page.getByRole('button', { name: '前进一步' }).click()
  await expect.poll(async () => (await inspect()).last).toMatchObject({ close: 725, volume: 7 })
  await page.getByRole('button', { name: '返回工作站' }).click()
  await expect(page.getByRole('heading', { name: /cTrader/ })).toBeVisible()
})
