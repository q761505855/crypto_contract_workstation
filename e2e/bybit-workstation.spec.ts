import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { expect, test, type WebSocketRoute } from '@playwright/test'
import { connectFixture } from './ctrader-fixture'
import { installViewportProbe } from './viewport-probe'

const day = '2026-11-20'
const start = Date.parse(day + 'T14:20:00Z')
const second = start / 1000
const part = gzipSync(`${second + 1},first,Buy,710,40\n${second + 61},next,Sell,711,50\n`)
const manifest = { version: 1, symbol: 'SPYUSDT', day, rows: 2,
  parts: [{ file: '14-000.csv.gz', hour: 14, rows: 2, bytes: part.byteLength,
    sha256: createHash('sha256').update(part).digest('hex') }],
}
const headers = { 'access-control-allow-origin': '*' }

test('IC 主图叠加 Bybit 成交量和气泡，按回放进度揭示成交', async ({ page }) => {
  const inspect = await installViewportProbe(page)
  await page.clock.setFixedTime(new Date(start + 86_400_000 + 30_000))
  await connectFixture(page, false, { historyAvailable: stamp => stamp >= start - 86_400_000 })
  await page.route('https://api.bybit.com/**', route => route.fulfill({ headers, json: { retCode: 0, result: { list: [] } } }))
  await page.routeWebSocket('wss://stream.bybit.com/v5/public/linear', socket => socket.onMessage(message => {
    if (JSON.parse(message.toString()).op === 'subscribe') socket.send(JSON.stringify({ op: 'subscribe', success: true }))
  }))
  await page.route('https://raw.githubusercontent.com/**/bybit-trades/**', route => {
    const url = route.request().url()
    if (url.endsWith(`/SPYUSDT/${day}/manifest.json`)) return route.fulfill({ headers, json: manifest })
    if (url.endsWith(`/SPYUSDT/${day}/14-000.csv.gz`)) return route.fulfill({ headers, body: part })
    return route.fulfill({ status: 404, headers })
  })
  await page.goto('/')
  const chart = page.getByTestId('chart-host')
  const symbolButton = chart.locator('.symbol')
  await symbolButton.click()
  const picker = page.getByRole('dialog', { name: '选择交易对' })
  await picker.getByRole('tab', { name: '全部' }).click()
  await expect(picker.getByTestId('symbol-picker-row-US500')).toContainText('支持代理成交量 · SPYUSDT')
  await expect(picker.getByTestId('symbol-picker-row-ETHUSD')).toContainText('支持成交量 · ETHUSDT')
  await expect(picker.getByTestId('symbol-picker-row-USDCHF')).toContainText('暂无成交量')
  await picker.getByRole('button', { name: '选择 US500', exact: true }).click()

  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 1m', exact: true }).click()
  const controls = page.getByTestId('replay-controls')
  await controls.getByRole('button', { name: '时间定位', exact: true }).click()
  const inputTime = await page.evaluate(timestamp => {
    const offset = new Date(timestamp).getTimezoneOffset()
    return new Date(timestamp - offset * 60_000).toISOString().slice(0, 16)
  }, start)
  const locate = page.getByRole('dialog', { name: '图表时间定位' })
  await locate.getByLabel('图表跳转时间').fill(inputTime)
  await locate.getByRole('button', { name: '跳转', exact: true }).click()
  await expect(controls.locator('.replay-start-time')).toContainText(inputTime.replace('T', ' '))
  await controls.getByRole('button', { name: '创建回放', exact: true }).click()

  await chart.getByText('指标', { exact: true }).click()
  await page.locator('.klinecharts-pro-indicator-modal-list').getByText('大单气泡（Big Trades）', { exact: true }).click()
  await page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  const combined = () => page.evaluate(() => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    const panes = coreChart.getIndicatorByPaneId() as Map<string, Map<string, import('klinecharts').Indicator>>
    const volume = [...panes.values()].find(pane => pane.has('VOL'))?.get('VOL')
    const bubbles = panes.get('candle_pane')?.get('BIG_TRADES')
    return { volumeName: volume?.shortName, volume: volume?.result.at(-1)?.volume,
      points: bubbles?.extendData?.points?.map((point: { trade: { id: string; price: number }; price: number }) =>
        [point.trade.id, point.trade.price, Math.round(point.price * 1e5) / 1e5]) }
  })
  await expect.poll(async () => (await inspect()).last).toMatchObject({ timestamp: start, open: 1.1002, close: 1.1005 })
  await expect.poll(combined).toMatchObject({ volumeName: 'Bybit 成交量', volume: 40, points: [['first', 710, 1.1002]] })
  await controls.getByRole('button', { name: '下一根', exact: true }).click()
  await expect.poll(combined).toMatchObject({ volume: 50, points: [['first', 710, 1.1002], ['next', 711, 1.1002]] })
  const tool = chart.locator('.klinecharts-pro-drawing-bar').getByRole('button', { name: '框选成交分布' })
  await expect(tool).toBeEnabled()
  await tool.click()
  const ends = await page.evaluate(start => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    const bounds = coreChart.getDom('candle_pane', 'main' as import('klinecharts').DomPosition)!.getBoundingClientRect()
    const index = coreChart.getDataList().findIndex(bar => bar.timestamp === start)
    const point = (dataIndex: number, value: number) => {
      const pixel = coreChart.convertToPixel({ dataIndex, value }, { paneId: 'candle_pane' }) as { x: number; y: number }
      return { x: bounds.left + pixel.x, y: bounds.top + pixel.y }
    }
    return [point(index, 1.1006), point(index + 1, 1.1001)]
  }, start)
  await page.mouse.click(ends[0].x, ends[0].y)
  await page.mouse.move(ends[1].x, ends[1].y)
  await expect.poll(() => page.evaluate(() => {
    const adapter = (window as unknown as { __viewportTestAdapter: {
      coreChart: import('klinecharts').Chart; orderFlow: { profiles: Map<string, unknown> }
    } }).__viewportTestAdapter
    const id = [...adapter.orderFlow.profiles.keys()][0]
    const display = adapter.coreChart.getOverlayById(id)?.extendData?.profile
    return display?.rows.reduce((sum: number, row: { buy: number; sell: number }) => sum + row.buy + row.sell, 0)
  })).toBe(40)
})

test('实时成交只更新映射品种的成交量，切到未匹配品种时恢复报价量', async ({ page }) => {
  const inspect = await installViewportProbe(page)
  await page.clock.setFixedTime(start + 30_000)
  await connectFixture(page)
  let ethereum: WebSocketRoute | undefined
  await page.routeWebSocket('wss://stream.bybit.com/v5/public/linear', socket => socket.onMessage(message => {
    const { op, args } = JSON.parse(message.toString())
    if (op !== 'subscribe') return
    if (args.includes('publicTrade.ETHUSDT')) ethereum = socket
    socket.send(JSON.stringify({ op: 'subscribe', success: true }))
  }))
  await page.route('https://api.bybit.com/**', route => {
    const isEthereum = new URL(route.request().url()).searchParams.get('symbol') === 'ETHUSDT'
    return route.fulfill({ headers, json: { retCode: 0, result: { list: isEthereum
      ? [{ symbol: 'ETHUSDT', execId: 'rest', time: String(start + 10_000), side: 'Buy', price: '1.1', size: '5' }] : [] } } })
  })
  await page.goto('/')
  const chart = page.getByTestId('chart-host')
  const choose = async (ticker: string) => {
    await chart.locator('.symbol').click()
    const picker = page.getByRole('dialog', { name: '选择交易对' })
    await picker.getByRole('tab', { name: '全部' }).click()
    await picker.getByRole('button', { name: `选择 ${ticker}`, exact: true }).click()
  }
  const volume = () => page.evaluate(() => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    const panes = coreChart.getIndicatorByPaneId() as Map<string, Map<string, import('klinecharts').Indicator>>
    const vol = [...panes.values()].find(pane => pane.has('VOL'))?.get('VOL')
    return { name: vol?.shortName, value: vol?.result.at(-1)?.volume }
  })
  await choose('ETHUSD')
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 1m', exact: true }).click()
  await expect.poll(volume).toEqual({ name: 'Bybit 成交量', value: 5 })
  ethereum!.send(JSON.stringify({ topic: 'publicTrade.ETHUSDT', data: [
    { T: start + 10_000, s: 'ETHUSDT', S: 'Buy', v: '5', p: '1.1', i: 'rest' },
    { T: start + 20_000, s: 'ETHUSDT', S: 'Sell', v: '8', p: '1.103', i: 'next' },
  ] }))
  await expect.poll(volume).toEqual({ name: 'Bybit 成交量', value: 13 })
  expect((await inspect()).last?.close).toBe(1.1)
  await choose('USDCHF')
  await expect.poll(volume).toMatchObject({ name: '报价量' })
  await expect(chart.getByRole('button', { name: '框选成交分布' })).toBeDisabled()
})
