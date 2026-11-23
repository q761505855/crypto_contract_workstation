import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { expect, test, type WebSocketRoute } from '@playwright/test'
import { connectFixture } from './ctrader-fixture'
import { installViewportProbe } from './viewport-probe'

const day = '2026-11-20'
const start = Date.parse(day + 'T14:20:00Z')
const second = start / 1000
const part = gzipSync(`${second + 1},first,Buy,710,40\n${second + 61},next,Sell,711,50\n`)
const future = gzipSync(`${Date.parse(day + 'T22:00:01Z') / 1000},future,Buy,712,60\n`)
const manifest = { version: 1, symbol: 'SPYUSDT', day, rows: 2,
  parts: [{ file: '14-000.csv.gz', hour: 14, rows: 2, bytes: part.byteLength,
    sha256: createHash('sha256').update(part).digest('hex') }],
}
const headers = { 'access-control-allow-origin': '*' }

test.beforeEach(async ({ page }) => {
  await page.route('https://raw.githubusercontent.com/**/okx-trades/**', route => route.fulfill({ headers, status: 404 }))
  await page.route('https://www.okx.com/api/v5/**', route => route.fulfill({ headers, json: {
    code: route.request().url().includes('market-data-history') ? '0' : '50001', data: [],
  } }))
  await page.routeWebSocket('wss://ws.okx.com/ws/v5/business', socket => socket.onMessage(message => {
    if (JSON.parse(message.toString()).op === 'subscribe') socket.send(JSON.stringify({ event: 'error', code: '50001' }))
  }))
})

test('大单气泡模式和样式保存后可刷新恢复，也支持配置导出和导入', async ({ page }) => {
  await connectFixture(page)
  await page.addInitScript(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (text === '\ue902' && this.canvas.closest('[data-pane-id="candle_pane"]')) {
        const point = new DOMPoint(x, y).matrixTransform(this.getTransform())
        const rect = this.canvas.getBoundingClientRect()
        Object.assign(window, { bubbleGear: { x: rect.left + point.x / devicePixelRatio, y: rect.top + point.y / devicePixelRatio } })
      }
      if (maxWidth === undefined) fillText.call(this, text, x, y)
      else fillText.call(this, text, x, y, maxWidth)
    }
  })
  const chart = page.getByTestId('chart-host')
  const settings = page.locator('.klinecharts-pro-indicator-setting-modal-content')
  const buyFill = settings.getByLabel('主动买入填充', { exact: true })
  const bubbleMode = settings.getByLabel('气泡模式', { exact: true })
  const buyTransparency = settings.getByLabel('主动买入填充透明度')
  const confirm = page.getByText('确定', { exact: true })
  const openSettings = async () => {
    const showInfo = page.getByRole('button', { name: '显示主图指标信息', exact: true })
    if (await showInfo.isVisible()) await showInfo.click()
    await expect(async () => {
      const gear = await page.evaluate(() => (window as unknown as { bubbleGear?: { x: number; y: number } }).bubbleGear)
      expect(gear).toBeDefined()
      await page.mouse.click(gear!.x + 3, gear!.y + 3)
      await expect(buyFill).toBeVisible({ timeout: 400 })
    }).toPass({ timeout: 5000 })
  }
  await page.goto('/')
  await expect(page.getByRole('contentinfo')).toContainText('EURUSD')
  await chart.getByText('指标', { exact: true }).click()
  await page.locator('.klinecharts-pro-indicator-modal-list').getByText('大单气泡（Big Trades）', { exact: true }).click()
  await page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  await openSettings()
  await expect(bubbleMode).toHaveValue('volume')
  await expect(buyFill).toHaveValue('#49d4ae')
  await expect(buyTransparency).toHaveValue('58')
  await buyFill.fill('#123456')
  await bubbleMode.selectOption('aggregate')
  await buyTransparency.fill('100')
  await settings.getByLabel('主动卖出描边透明度').fill('0')
  await confirm.click()

  await page.reload()
  await openSettings()
  await expect(bubbleMode).toHaveValue('aggregate')
  await expect(buyFill).toHaveValue('#123456')
  await expect(buyTransparency).toHaveValue('100')
  await expect(settings.getByLabel('主动卖出描边透明度')).toHaveValue('0')
  await confirm.click()

  await page.getByRole('button', { name: '工具', exact: true }).click()
  await page.getByTestId('open-data-manager').click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出应用配置' }).click(),
  ])
  const archive = JSON.parse(await readFile((await download.path())!, 'utf8'))
  const styles = archive.data.preferences.chartIndicators.main.find((setting: { name: string }) => setting.name === 'BIG_TRADES').styles
  expect(styles.bubbleMode).toBe('aggregate')
  expect(styles.bubbleColors.map(({ color }: { color: string }) => color))
    .toEqual(['#12345600', '#ff827e6b', '#49d4aee6', '#ff827e'])
  styles.bubbleColors[0].color = '#654321'
  styles.bubbleMode = 'volume'
  page.once('dialog', dialog => dialog.accept())
  await page.getByTestId('import-backup-file').setInputFiles({
    name: 'big-trades-style.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)),
  })
  await expect(page.getByTestId('backup-status')).toContainText('刷新页面')
  await page.reload()
  await openSettings()
  await expect(bubbleMode).toHaveValue('volume')
  await expect(buyFill).toHaveValue('#654321')
  await expect(buyTransparency).toHaveValue('0')
})

test('订单流分组和设置可独立使用并随配置恢复', async ({ page }) => {
  await connectFixture(page)
  await page.goto('/')
  const chart = page.getByTestId('chart-host')
  const list = page.locator('.klinecharts-pro-indicator-modal-list')
  const footprint = '足迹图（Footprint）'
  const profile = '框选成交分布（Profile）'
  const cvd = '累计成交量差（CVD）'
  const bubbles = '大单气泡（Big Trades）'
  const open = () => chart.getByText('指标', { exact: true }).click()
  const close = () => page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  const settings = async (name: string) => {
    await list.getByRole('button', { name: name + '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: name + '设置' })
    await expect(dialog).toBeVisible()
    return dialog
  }

  await open()
  await expect(list.locator('li.title').first()).toHaveText('订单流')
  await list.getByText(profile, { exact: true }).click()
  await expect(page.getByRole('dialog', { name: profile + '设置' })).toHaveCount(0)
  const profileDialog = await settings(profile)
  await expect(profileDialog.getByLabel('POC 线色', { exact: true })).toHaveAttribute('type', 'color')
  await profileDialog.getByLabel('价位档数').fill('64')
  await profileDialog.getByLabel('显示 POC').uncheck()
  await profileDialog.getByRole('button', { name: '保存', exact: true }).click()
  const bubbleDialog = await settings(bubbles)
  await expect(bubbleDialog.getByLabel('主动买入填充色', { exact: true })).toHaveAttribute('type', 'color')
  await bubbleDialog.getByLabel('标记形状').selectOption('diamond')
  await bubbleDialog.getByLabel('空心标记').check()
  await bubbleDialog.getByLabel('最小半径').fill('0')
  await bubbleDialog.getByLabel('大单模式').selectOption('aggregate')
  await bubbleDialog.getByLabel('最低成交额（USDT）').fill('1200')
  await bubbleDialog.getByRole('button', { name: '保存', exact: true }).click()
  const bubbleToggle = list.getByRole('button', { name: bubbles, exact: true })
  await expect(bubbleToggle).toHaveAttribute('aria-pressed', 'false')
  await bubbleToggle.click()
  const activeBubbles = await settings(bubbles)
  await expect(activeBubbles.getByLabel('大单模式')).toHaveValue('aggregate')
  await expect(activeBubbles.getByLabel('最低成交额（USDT）')).toHaveValue('1200')
  await activeBubbles.getByRole('button', { name: '取消', exact: true }).click()
  await bubbleToggle.click()

  const footprintDialog = await settings(footprint)
  await expect(footprintDialog.getByLabel('失衡色', { exact: true })).toHaveAttribute('type', 'color')
  await footprintDialog.getByLabel('失衡色', { exact: true }).fill('#345678')
  await footprintDialog.getByLabel('失衡色透明度', { exact: true }).fill('100')
  await expect(footprintDialog.getByLabel('图形内容', { exact: true })).toHaveValue('matchText')
  await footprintDialog.getByLabel('数值内容', { exact: true }).selectOption('bidAsk')
  await footprintDialog.getByLabel('图形内容', { exact: true }).selectOption('delta')
  await footprintDialog.getByLabel('显示样式').selectOption('histogram')
  await footprintDialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(list.getByRole('button', { name: footprint, exact: true })).toHaveAttribute('aria-pressed', 'false')
  await list.getByRole('button', { name: footprint, exact: true }).click()
  await list.getByRole('button', { name: cvd, exact: true }).click()
  await expect(list.getByRole('button', { name: cvd, exact: true })).toHaveAttribute('aria-pressed', 'true')
  const cvdDialog = await settings(cvd)
  await expect(cvdDialog.getByLabel('正值色', { exact: true })).toHaveAttribute('type', 'color')
  await cvdDialog.getByRole('button', { name: '取消', exact: true }).click()
  await close()

  await page.reload()
  await open()
  await expect(list.getByRole('button', { name: footprint, exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(list.getByRole('button', { name: cvd, exact: true })).toHaveAttribute('aria-pressed', 'true')
  const restored = await settings(footprint)
  await expect(restored.getByLabel('失衡色', { exact: true })).toHaveValue('#345678')
  await expect(restored.getByLabel('失衡色透明度', { exact: true })).toHaveValue('100')
  await expect(restored.getByLabel('数值内容', { exact: true })).toHaveValue('bidAsk')
  await expect(restored.getByLabel('图形内容', { exact: true })).toHaveValue('delta')
  await expect(restored.getByLabel('显示样式')).toHaveValue('histogram')
  await restored.getByRole('button', { name: '取消', exact: true }).click()
  await close()

  await page.getByRole('button', { name: '工具', exact: true }).click()
  await page.getByTestId('open-data-manager').click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出应用配置' }).click(),
  ])
  const archive = JSON.parse(await readFile((await download.path())!, 'utf8'))
  const orderFlow = archive.data.preferences.chartIndicators.orderFlow
  expect(orderFlow.profile).toMatchObject({ rows: 64, showPoc: false })
  expect(orderFlow.bubbles).toMatchObject({ marker: 'diamond', hollow: true, minRadius: 0, mode: 'aggregate', minNotional: 1200 })
  expect(orderFlow.footprint).toMatchObject({ type: 'bidAsk', plotType: 'delta', layout: 'histogram', imbalanceColor: '#34567800' })
  orderFlow.profile.rows = 35
  orderFlow.footprint.plotType = 'volume'
  orderFlow.footprint.imbalanceColor = 'rgba(18,52,86,0.25)'
  page.once('dialog', dialog => dialog.accept())
  await page.getByTestId('import-backup-file').setInputFiles({
    name: 'order-flow.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)),
  })
  await expect(page.getByTestId('backup-status')).toContainText('刷新页面')
  await page.reload()
  await open()
  const imported = await settings(profile)
  await expect(imported.getByLabel('价位档数')).toHaveValue('35')
  await expect(imported.getByLabel('显示 POC')).not.toBeChecked()
  await imported.getByRole('button', { name: '取消', exact: true }).click()
  const importedFootprint = await settings(footprint)
  await expect(importedFootprint.getByLabel('失衡色', { exact: true })).toHaveValue('#123456')
  await expect(importedFootprint.getByLabel('失衡色透明度', { exact: true })).toHaveValue('75')
  await expect(importedFootprint.getByLabel('数值内容', { exact: true })).toHaveValue('bidAsk')
  await expect(importedFootprint.getByLabel('图形内容', { exact: true })).toHaveValue('volume')
})

test('IC 主图叠加 Bybit 成交量和气泡，按回放进度揭示成交', async ({ page }) => {
  let futureReads = 0
  let anchorReads = 0
  let nearbyReads = 0
  let finishRead: () => void = () => {}
  let finishAnchor: () => void = () => {}
  const futureReady = new Promise<void>(resolve => { finishRead = resolve })
  const anchorReady = new Promise<void>(resolve => { finishAnchor = resolve })
  const nearby = gzipSync(`${Date.parse(`${day}T13:10:00Z`) / 1000},nearby,Buy,710,1\n`)
  const inspect = await installViewportProbe(page)
  await page.clock.setFixedTime(new Date(start + 86_400_000 + 30_000))
  await connectFixture(page, false, { historyAvailable: stamp => stamp >= start - 86_400_000 })
  await page.route('https://api.bybit.com/**', route => route.fulfill({ headers, json: { retCode: 0, result: { list: [] } } }))
  await page.routeWebSocket('wss://stream.bybit.com/v5/public/linear', socket => socket.onMessage(message => {
    if (JSON.parse(message.toString()).op === 'subscribe') socket.send(JSON.stringify({ op: 'subscribe', success: true }))
  }))
  await page.route('https://raw.githubusercontent.com/**/bybit-trades/**', async route => {
    const url = route.request().url()
    if (url.endsWith(`/SPYUSDT/${day}/manifest.json`)) return route.fulfill({ headers, json: {
      ...manifest, rows: 4, parts: [
        { file: '13-000.csv.gz', hour: 13, rows: 1, bytes: nearby.byteLength, sha256: createHash('sha256').update(nearby).digest('hex') },
        ...manifest.parts,
        { file: '22-000.csv.gz', hour: 22, rows: 1, bytes: future.byteLength, sha256: createHash('sha256').update(future).digest('hex') },
      ],
    } })
    if (url.endsWith(`/SPYUSDT/${day}/13-000.csv.gz`)) {
      nearbyReads++
      return route.fulfill({ headers, body: nearby })
    }
    if (url.endsWith(`/SPYUSDT/${day}/14-000.csv.gz`)) {
      anchorReads++
      await anchorReady
      return route.fulfill({ headers, body: part })
    }
    if (url.endsWith(`/SPYUSDT/${day}/22-000.csv.gz`)) {
      futureReads++
      await futureReady
      return route.fulfill({ headers, body: future })
    }
    return route.fulfill({ status: 404, headers })
  })
  await page.goto('/')
  const chart = page.getByTestId('chart-host')
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 1m', exact: true }).click()
  const symbolButton = chart.locator('.symbol')
  await symbolButton.click()
  const picker = page.getByRole('dialog', { name: '选择交易对' })
  await picker.getByRole('tab', { name: '全部' }).click()
  await expect(picker.getByTestId('symbol-picker-row-US500')).toContainText('支持代理成交量 · US500-USDT-SWAP')
  await expect(picker.getByTestId('symbol-picker-row-ETHUSD')).toContainText('支持成交量 · ETH-USDT-SWAP')
  await expect(picker.getByTestId('symbol-picker-row-USDCHF')).toContainText('暂无成交量')
  await picker.getByRole('button', { name: '选择 US500', exact: true }).click()

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
    const bars = bubbles?.extendData?.bars as import('../src/chart/order-flow-renderers').BubbleDisplay['bars']
    const candles = coreChart.getDataList()
    return { volumeName: volume?.shortName, volume: volume?.result.at(-1)?.volume, updating: bubbles?.extendData?.updating,
      points: Array.from(bars ?? []).flatMap(([stamp, row]) => {
        const open = candles.find(candle => candle.timestamp === stamp)?.open ?? 0
        const points = row.pointRanges.flatMap(({ points, from, until }) => points.slice(from, until))
        return points.map(({ trade }) => [trade.id, trade.price, Math.round(trade.price * (open / row.firstPrice!) * 1e5) / 1e5])
      }) }
  })
  expect(futureReads).toBe(0)
  await expect.poll(async () => (await inspect()).last?.timestamp).toBe(start)
  await chart.getByRole('button', { name: '下载成交数据' }).click()
  const downloadDialog = page.getByRole('dialog', { name: '下载成交数据' })
  await downloadDialog.getByLabel('锚点日期').fill(day)
  await downloadDialog.getByLabel('往前天数').fill('0')
  await downloadDialog.getByLabel('往后天数').fill('0')
  await downloadDialog.getByRole('button', { name: '下载', exact: true }).click()
  await downloadDialog.getByRole('button', { name: '只下载归档' }).click()
  try {
    try {
      await expect.poll(() => [anchorReads, nearbyReads]).toEqual([1, 1])
      expect((await combined()).volume).toBeUndefined()
    } finally { finishAnchor() }
    await expect.poll(() => futureReads).toBeGreaterThan(0)
    await expect.poll(combined).toMatchObject({
      updating: { fromUs: Date.parse(`${day}T22:00:00Z`) * 1000, untilUs: Date.parse(`${day}T23:00:00Z`) * 1000 },
      volume: 40, points: [['first', 710, 1.1002]],
    })
  } finally { finishRead() }
  await expect.poll(async () => (await inspect()).last).toMatchObject({ timestamp: start, open: 1.1002, close: 1.1005 })
  await expect.poll(combined).toMatchObject({ volumeName: 'OKX / Bybit 成交量', volume: 40, points: [['first', 710, 1.1002]] })
  await expect.poll(async () => (await combined()).updating).toBeUndefined()
  expect(nearbyReads).toBe(1)
  const readsBeforeStep = futureReads
  await page.evaluate(() => {
    const state = window as unknown as { __replayStepScans: number; __viewportTestAdapter: {
      source: import('../src/market-data/bybit/combined-source').CombinedBybitSource
    } }
    const { source } = state.__viewportTestAdapter
    state.__replayStepScans = 0
    const visit = source.visitTrades.bind(source)
    source.visitTrades = (...args) => {
      state.__replayStepScans++
      return visit(...args)
    }
  })
  await controls.getByRole('button', { name: '下一根', exact: true }).click()
  await expect.poll(combined).toMatchObject({ volume: 50, points: [['first', 710, 1.1002], ['next', 711, 1.1002]] })
  expect(futureReads).toBe(readsBeforeStep)
  expect(await page.evaluate(() => (window as unknown as { __replayStepScans: number }).__replayStepScans)).toBe(0)
  const tool = chart.locator('.klinecharts-pro-drawing-bar').getByRole('button', { name: '框选成交分布' })
  await expect(tool).toBeEnabled()
  const rail = (await chart.locator('.klinecharts-pro-drawing-bar').boundingBox())!
  const button = (await tool.boundingBox())!
  expect(Math.abs(rail.x + rail.width / 2 - button.x - button.width / 2)).toBeLessThan(1)
  await tool.click()
  const endpoints = () => page.evaluate(start => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    const bounds = coreChart.getDom('candle_pane', 'main' as import('klinecharts').DomPosition)!.getBoundingClientRect()
    const index = coreChart.getDataList().findIndex(bar => bar.timestamp === start)
    const point = (dataIndex: number, value: number) => {
      const pixel = coreChart.convertToPixel({ dataIndex, value }, { paneId: 'candle_pane' }) as { x: number; y: number }
      return { x: bounds.left + pixel.x, y: bounds.top + pixel.y }
    }
    return [point(index, 1.1006), point(index + 1, 1.1001)]
  }, start)
  const ends = await endpoints()
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
  await page.mouse.click(ends[1].x, ends[1].y)
  const profileState = (operation: 'read' | 'store') => page.evaluate(operation => {
    const state = window as unknown as { __viewportTestAdapter: {
      orderFlow: { profiles: Map<string, { low: number; high: number; operation?: AbortController }> }
      drawings: { rendered: Map<string, import('../src/chart/drawings').ChartDrawing> }
    }; __savedProfile?: unknown }
    const [id, profile] = [...state.__viewportTestAdapter.orderFlow.profiles][0]
    const drawing = state.__viewportTestAdapter.drawings.rendered.get(id)
    if (operation === 'store') state.__savedProfile = profile
    return { low: profile.low, high: profile.high, savedLow: drawing && Math.min(...drawing.points.map(point => point.value)),
      sameProfile: state.__savedProfile === profile, busy: !!profile.operation }
  }, operation)
  await expect.poll(async () => (await profileState('read')).savedLow).toBeDefined()
  const original = await profileState('read')
  const [, handle] = await endpoints()
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.mouse.move(handle.x, handle.y - 15, { steps: 4 })
  await expect.poll(async () => (await profileState('read')).low).not.toBe(original.low)
  await expect.poll(async () => (await profileState('read')).busy).toBe(false)
  const preview = await profileState('store')
  await page.mouse.up()
  await expect.poll(() => profileState('read')).toMatchObject({ sameProfile: true, savedLow: preview.low })
  await chart.getByText('指标', { exact: true }).click()
  await page.getByRole('button', { name: '框选成交分布（Profile）设置', exact: true }).click()
  const profileSettings = page.getByRole('dialog', { name: '框选成交分布（Profile）设置' })
  await profileSettings.getByLabel('价位档数').fill('16')
  await profileSettings.getByRole('button', { name: '保存', exact: true }).click()
  await page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  await expect.poll(() => page.evaluate(() => {
    const adapter = (window as unknown as { __viewportTestAdapter: {
      coreChart: import('klinecharts').Chart; orderFlow: { profiles: Map<string, unknown> }
    } }).__viewportTestAdapter
    return adapter.coreChart.getOverlayById([...adapter.orderFlow.profiles.keys()][0])?.extendData?.profile?.rows.length
  })).toBe(16)

  await page.evaluate(() => {
    const state = window as unknown as { __periodArchiveReads: number; __viewportTestAdapter: {
      source: import('../src/market-data/bybit/combined-source').CombinedBybitSource
    } }
    const { source } = state.__viewportTestAdapter
    state.__periodArchiveReads = 0
    const read = source.readArchivedHour.bind(source)
    source.readArchivedHour = (...args) => {
      state.__periodArchiveReads++
      return read(...args)
    }
  })
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 5m', exact: true }).click()
  await expect.poll(async () => (await combined()).points.map(point => point[0])).toEqual(['first', 'next'])
  await expect.poll(async () => (await combined()).volume).toBe(90)
  expect(await page.evaluate(() => (window as unknown as { __periodArchiveReads: number }).__periodArchiveReads)).toBe(0)
  await page.evaluate(() => {
    const state = window as unknown as {
      __viewportTestAdapter: { coreChart: import('klinecharts').Chart }
      __footprintTextLayers: Record<string, number>
    }
    state.__footprintTextLayers = {}
    const native = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (text === '40' && this.fillStyle === '#e7eef8') {
        const pane = state.__viewportTestAdapter.coreChart.getDom('candle_pane', 'main' as import('klinecharts').DomPosition)
        const layer = Array.from(pane?.querySelectorAll('canvas') ?? []).indexOf(this.canvas)
        if (layer >= 0) state.__footprintTextLayers[text] = layer
      }
      if (maxWidth === undefined) native.call(this, text, x, y)
      else native.call(this, text, x, y, maxWidth)
    }
  })
  await chart.getByText('指标', { exact: true }).click()
  const list = page.locator('.klinecharts-pro-indicator-modal-list')
  await list.getByRole('button', { name: '足迹图（Footprint）', exact: true }).click()
  await list.getByRole('button', { name: '足迹图（Footprint）设置', exact: true }).click()
  const mixedFootprint = page.getByRole('dialog', { name: '足迹图（Footprint）设置' })
  await mixedFootprint.getByRole('combobox', { name: '图形内容', exact: true }).selectOption('delta')
  await mixedFootprint.getByRole('combobox', { name: '显示样式', exact: true }).selectOption('histogram')
  await mixedFootprint.getByRole('button', { name: '保存', exact: true }).click()
  await list.getByRole('button', { name: '累计成交量差（CVD）', exact: true }).click()
  await page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  await expect.poll(() => page.evaluate(start => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    const panes = coreChart.getIndicatorByPaneId() as Map<string, Map<string, import('klinecharts').Indicator>>
    const footprint = panes.get('candle_pane')?.get('FOOTPRINT')?.extendData as import('../src/chart/order-flow-indicators').FootprintDisplay | undefined
    const cvd = [...panes.values()].find(pane => pane.has('CVD'))?.get('CVD')
    const rows = footprint?.rows?.get(start)
    return {
      spacing: coreChart.getBarSpace(),
      volume: rows?.reduce((total, row) => total + row.buy + row.sell, 0),
      delta: cvd?.result.at(-1)?.delta,
    }
  }, start)).toMatchObject({ spacing: 110, volume: 90, delta: -9 })
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __footprintTextLayers: Record<string, number> }
  ).__footprintTextLayers), { timeout: 3000 }).toEqual({ '40': 1 })
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
  let bybitRequests = 0
  await page.route('https://api.bybit.com/**', route => {
    bybitRequests++
    return route.fulfill({ headers, json: { retCode: 0, result: { list: [] } } })
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
  await expect.poll(() => ethereum).toBeDefined()
  expect(bybitRequests).toBe(0)
  ethereum!.send(JSON.stringify({ topic: 'publicTrade.ETHUSDT', data: [
    { T: start + 20_000, s: 'ETHUSDT', S: 'Sell', v: '8', p: '1.103', i: 'next' },
  ] }))
  await expect.poll(volume).toEqual({ name: 'OKX / Bybit 成交量', value: 8 })
  expect((await inspect()).last?.close).toBe(1.1)
  await choose('USDCHF')
  await expect.poll(volume).toMatchObject({ name: '报价量' })
  await expect(chart.getByRole('button', { name: '框选成交分布' })).toBeDisabled()
  await expect(chart.getByRole('button', { name: '下载成交数据' })).toBeDisabled()
})

test('通过 UTC 锚点和前后天数选择日期范围并复用已缓存日档', async ({ page }) => {
  const dayMs = 86_400_000
  const now = Date.parse('2026-11-22T02:00:30Z')
  await page.clock.install({ time: now })
  await connectFixture(page, false, { historyAvailable: stamp => stamp >= now - 7 * dayMs })
  const inspect = await installViewportProbe(page)
  await page.route('**/cloud-connection.json', route => route.fulfill({ headers,
    json: { schemaVersion: 1, project: 'crypto-contract-workstation', token: 'cache-test-token' },
  }))
  const requested: unknown[] = []
  const dispatched: string[] = []
  let published = false
  let loadedParts = 0
  const checkedDays = new Set<string>()
  await page.route('https://raw.githubusercontent.com/**/bybit-trades/**', route => {
    const url = route.request().url()
    const cacheDay = /\/BTCUSDT\/(\d{4}-\d\d-\d\d)\/manifest\.json$/.exec(url)?.[1]
    if (cacheDay) checkedDays.add(cacheDay)
    if (published && (cacheDay === day || cacheDay === '2026-11-21')) {
      return route.fulfill({ headers, json: { ...manifest, day: cacheDay, symbol: 'BTCUSDT' } })
    }
    if (published && url.endsWith(`/BTCUSDT/${day}/14-000.csv.gz`)) {
      loadedParts++
      return route.fulfill({ headers, body: part })
    }
    return route.fulfill({ status: 404, headers })
  })
  const files = new Map<string, string>()
  await page.route('https://api.github.com/**', route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && path === '/repos/q761505855/crypto_contract_workstation/dispatches') {
      dispatched.push(request.postDataJSON().event_type)
      return route.fulfill({ headers, status: 204 })
    }
    if (path.endsWith('/git/ref/heads/main')) return route.fulfill({ headers, json: { object: { sha: 'test-commit' } } })
    if (path.endsWith('/git/commits/test-commit')) return route.fulfill({ headers, json: { tree: { sha: 'test-tree' } } })
    const entry = /\/bybit-requests\/BTCUSDT\/(\d{4}-\d\d-\d\d)\.json$/.exec(path)
    if (entry && request.method() === 'PUT') {
      const { content } = request.postDataJSON()
      requested.push(JSON.parse(Buffer.from(content, 'base64').toString()))
      files.set(path, content)
      return route.fulfill({ headers, status: 201, json: { content: { sha: 'test-file' } } })
    }
    if (entry && !published && files.has(path)) return route.fulfill({ headers, json: { type: 'file', path, sha: 'test-file',
      encoding: 'base64', content: files.get(path) } })
    return route.fulfill({ headers, status: 404, body: '' })
  })
  await page.goto('/')
  await page.getByTestId('chart-host').locator('.symbol').click()
  const picker = page.getByRole('dialog', { name: '选择交易对' })
  await picker.getByRole('tab', { name: '全部' }).click()
  await picker.getByRole('button', { name: '选择 BTCUSD', exact: true }).click()
  await expect(page.getByRole('contentinfo')).toContainText('BTCUSD · 15m')
  await expect.poll(async () => (await inspect()).rightmost).toBeGreaterThan(Date.parse('2026-11-22'))
  expect(checkedDays.size).toBe(0)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __viewportTestAdapter: {
    getVisibleBybitDay(): string
  } }).__viewportTestAdapter.getVisibleBybitDay())).toBe('2026-11-22')
  const download = page.getByTestId('chart-host').getByRole('button', { name: '下载成交数据' })
  const status = page.getByTestId('chart-host').getByRole('status')
  const dialog = page.getByRole('dialog', { name: '下载成交数据' })
  const anchor = dialog.getByLabel('锚点日期')
  const before = dialog.getByLabel('往前天数')
  const after = dialog.getByLabel('往后天数')
  const confirm = dialog.getByRole('button', { name: '下载', exact: true })
  await download.click()
  await expect(anchor).toHaveValue('2026-11-22')
  await expect(before).toHaveValue('0')
  await expect(after).toHaveValue('0')
  await expect(dialog.getByText('2026-11-22', { exact: true })).toBeVisible()
  await before.fill('1')
  await after.fill('1')
  await expect(dialog.getByText('2026-11-21 至 2026-11-22')).toBeVisible()
  await anchor.fill('2026-11-23')
  await confirm.click()
  await expect(dialog.getByRole('alert')).toContainText('锚点日期不能晚于当前 UTC 日期')
  await anchor.fill('2026-11-01')
  await expect(dialog.getByText('2026-10-31 至 2026-11-02')).toBeVisible()
  await before.fill('-1')
  await confirm.click()
  await expect(dialog.getByRole('alert')).toContainText('须为大于或等于 0 的整数')
  await dialog.getByRole('button', { name: '关闭下载成交数据' }).click()
  await page.evaluate(end => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    coreChart.setBarSpace(3)
    const { realTo } = coreChart.getVisibleRange()
    const target = coreChart.getDataList().findIndex(candle => candle.timestamp === end)
    if (target < 0) throw new Error('未加载测试日期的 K 线')
    coreChart.scrollByDistance((realTo - target - 1) * coreChart.getBarSpace(), 0)
  }, Date.parse(day + 'T22:00:00Z'))
  await expect.poll(async () => new Date((await inspect()).rightmost!).toISOString().slice(0, 10)).toBe(day)
  expect((await inspect()).last!.timestamp).toBeGreaterThan(Date.parse('2026-11-22'))
  expect(checkedDays.size).toBe(0)
  expect(requested).toEqual([])
  expect(dispatched).toEqual([])
  await download.click()
  await expect(anchor).toHaveValue(day)
  await before.fill('1')
  await after.fill('1')
  await expect(dialog.getByText('2026-11-19 至 2026-11-21')).toBeVisible()
  await before.fill('0')
  await confirm.click()
  await dialog.getByRole('button', { name: '只下载归档' }).click()
  await expect.poll(() => requested).toEqual(expect.arrayContaining([day, '2026-11-21'].map(day => ({
    version: 1, symbol: 'BTCUSDT', day, requestedManually: true,
  }))))
  expect(requested).toHaveLength(2)
  await expect.poll(() => dispatched).toEqual(['bybit-trades-requested'])
  await expect(status).toContainText('等待后台下载并缓存 BTCUSDT')
  published = true
  await page.clock.fastForward(13_000)
  await expect(status).toContainText('Bybit 日档 2 天')
  await expect.poll(() => loadedParts).toBeGreaterThan(0)
  await download.click()
  await before.fill('0')
  await after.fill('0')
  await confirm.click()
  await expect(dialog.getByRole('row').filter({ hasText: day })).toContainText('已加载')
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await download.click()
  await anchor.fill('2026-11-21')
  await before.fill('0')
  await after.fill('0')
  await confirm.click()
  await expect(dialog.getByRole('row').filter({ hasText: '2026-11-21' })).toContainText('已加载')
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  expect(requested).toHaveLength(2)
  await expect(page.getByRole('contentinfo')).toContainText('实时行情')
})

test('保留全部达标气泡，缩放和刷新后复用归档计算结果', async ({ page }) => {
  const now = Date.parse('2026-11-22T02:00:30Z')
  const archivedSecond = Date.parse(day + 'T23:50:00Z') / 1000
  const archivedRows = 400
  let partReads = 0
  let releasePart!: () => void
  const firstPart = new Promise<void>(resolve => { releasePart = resolve })
  const archivePart = gzipSync(Array.from({ length: archivedRows }, (_, index) =>
    `${archivedSecond}.${String(index).padStart(6, '0')},archive-${index},Buy,1.1,100000\n`).join(''))
  await page.clock.setFixedTime(now)
  await connectFixture(page, false, { historyAvailable: stamp => stamp >= start })
  await installViewportProbe(page)
  await page.route('https://raw.githubusercontent.com/**/bybit-trades/**', async route => {
    const url = route.request().url()
    if (url.endsWith(`/BTCUSDT/${day}/manifest.json`)) return route.fulfill({ headers, json: {
      version: 1, symbol: 'BTCUSDT', day, rows: archivedRows,
      parts: [{ file: '23-000.csv.gz', hour: 23, rows: archivedRows, bytes: archivePart.byteLength,
        sha256: createHash('sha256').update(archivePart).digest('hex') }],
    } })
    if (url.endsWith(`/BTCUSDT/${day}/23-000.csv.gz`)) {
      partReads++
      if (partReads === 1) await firstPart
      return route.fulfill({ headers, body: archivePart })
    }
    return route.fulfill({ headers, status: 404 })
  })
  let bitcoin: WebSocketRoute | undefined
  await page.routeWebSocket('wss://stream.bybit.com/v5/public/linear', socket => socket.onMessage(message => {
    const { op, args } = JSON.parse(message.toString())
    if (op !== 'subscribe') return
    if (args.includes('publicTrade.BTCUSDT')) bitcoin = socket
    socket.send(JSON.stringify({ op: 'subscribe', success: true }))
  }))
  await page.goto('/')
  const chart = page.getByTestId('chart-host')
  await chart.locator('.symbol').click()
  const picker = page.getByRole('dialog', { name: '选择交易对' })
  await picker.getByRole('tab', { name: '全部' }).click()
  await picker.getByRole('button', { name: '选择 BTCUSD', exact: true }).click()
  await expect(page.getByRole('contentinfo')).toContainText('BTCUSD · 15m')
  const zoom = (space: number) => page.evaluate(value => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    coreChart.setBarSpace(value)
  }, space)
  const loadArchive = async () => {
    await chart.getByRole('button', { name: '下载成交数据' }).click()
    const dialog = page.getByRole('dialog', { name: '下载成交数据' })
    await dialog.getByLabel('锚点日期').fill(day)
    await dialog.getByLabel('往前天数').fill('0')
    await dialog.getByLabel('往后天数').fill('0')
    await dialog.getByRole('button', { name: '下载', exact: true }).click()
    const row = dialog.getByRole('row').filter({ hasText: day })
    await expect(row).toContainText(/Git 已缓存|已加载/)
    if ((await row.textContent())?.includes('已加载')) {
      await dialog.getByRole('button', { name: '完成', exact: true }).click()
    } else {
      await dialog.getByRole('button', { name: '只下载归档' }).click()
      await expect(chart.getByRole('status')).toContainText('Bybit 日档 1 天')
    }
  }
  await zoom(3)
  expect(partReads).toBe(0)
  await loadArchive()
  await expect.poll(() => partReads).toBe(1)
  try {
    const scanContinued = await page.evaluate(stamp => {
      const { source, orderFlow } = (window as unknown as { __viewportTestAdapter: {
        source: { changed(reset: boolean, range: { fromUs: number; untilUs: number }): void }
        orderFlow: { flowOperation?: AbortController }
      } }).__viewportTestAdapter
      const reading = orderFlow.flowOperation
      for (let offset = 5; offset > 0; offset--) source.changed(true, { fromUs: (stamp - offset) * 1000, untilUs: Infinity })
      return !!reading && !reading.signal.aborted && orderFlow.flowOperation === reading
    }, now)
    expect(scanContinued).toBe(true)
  } finally { releasePart() }
  await chart.getByText('指标', { exact: true }).click()
  await page.locator('.klinecharts-pro-indicator-modal-list').getByText('大单气泡（Big Trades）', { exact: true }).click()
  await page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  const bubbleIds = () => page.evaluate(() => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    const indicator = coreChart.getIndicatorByPaneId('candle_pane', 'BIG_TRADES') as import('klinecharts').Indicator | null
    const bars = indicator?.extendData?.bars as import('../src/chart/order-flow-renderers').BubbleDisplay['bars']
    return Array.from(bars?.values() ?? []).flatMap(bar =>
      bar.pointRanges.flatMap(({ points, from, until }) => points.slice(from, until).map(point => point.trade.id)))
  })
  await expect.poll(async () => (await bubbleIds()).length).toBe(400)
  expect((await bubbleIds()).every(id => id.startsWith('archive-'))).toBe(true)
  await expect.poll(() => !!bitcoin).toBe(true)
  bitcoin!.send(JSON.stringify({ topic: 'publicTrade.BTCUSDT', data: [
    { T: now - 10_000, s: 'BTCUSDT', S: 'Sell', v: '25000', p: '1.1', i: 'live-trade' },
  ] }))
  await expect.poll(async () => {
    const ids = await bubbleIds()
    return [ids.length, new Set(ids).size, ids.at(-1), ids.slice(0, -1).every(id => id.startsWith('archive-'))]
  }).toEqual([401, 401, 'live-trade', true])
  const reads = partReads
  await page.evaluate(stamp => {
    const state = window as unknown as { __viewportTestAdapter: { source: import('../src/market-data/bybit/combined-source').CombinedBybitSource }; __archivedScans: number }
    const source = state.__viewportTestAdapter.source
    const visit = source.visitTrades.bind(source)
    state.__archivedScans = 0
    source.visitTrades = (...args) => {
      if (args[0].fromUs <= stamp * 1000 && args[0].untilUs > stamp * 1000) state.__archivedScans++
      return visit(...args)
    }
  }, archivedSecond * 1000)
  await zoom(20)
  await expect.poll(async () => (await bubbleIds()).length).toBe(1)
  await zoom(3)
  await expect.poll(async () => (await bubbleIds()).length).toBe(401)
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 5m', exact: true }).click()
  await expect(page.getByRole('contentinfo')).toContainText('BTCUSD · 5m')
  await zoom(3)
  await expect.poll(async () => (await bubbleIds()).length).toBe(401)
  expect(await page.evaluate(() => (window as unknown as { __archivedScans: number }).__archivedScans)).toBe(0)
  expect(partReads).toBe(reads)
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 15m', exact: true }).click()
  await expect(page.getByRole('contentinfo')).toContainText('BTCUSD · 15m')
  await page.reload()
  await expect(page.getByRole('contentinfo')).toContainText('BTCUSD · 15m')
  await zoom(3)
  await expect.poll(async () => (await bubbleIds()).length).toBe(0)
  expect(partReads).toBe(reads)
  await loadArchive()
  await expect.poll(async () => (await bubbleIds()).length).toBe(400)
  expect(partReads).toBe(reads)

  await page.evaluate(() => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    coreChart.overrideIndicator({ name: 'BIG_TRADES', calcParams: [150_000], styles: { bubbleMode: 'aggregate' } }, 'candle_pane')
  })
  const timestamp = Math.floor(archivedSecond / (15 * 60)) * (15 * 60 * 1000)
  await expect(async () => {
    const position = await page.evaluate(stamp => {
      const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
      const indicator = coreChart.getIndicatorByPaneId('candle_pane', 'BIG_TRADES') as import('klinecharts').Indicator
      if (indicator.extendData?.mode !== 'aggregate' || !indicator.extendData.bars?.get(stamp)?.pointRanges.length) return null
      const pane = coreChart.getDom('candle_pane', 'main' as import('klinecharts').DomPosition)!.getBoundingClientRect()
      const point = coreChart.convertToPixel({ timestamp: stamp, value: 1.1 }, { paneId: 'candle_pane' }) as { x: number; y: number }
      return { x: pane.left + point.x, y: pane.top + point.y }
    }, timestamp)
    expect(position).toBeTruthy()
    await page.mouse.move(position!.x, position!.y)
    await expect(chart.locator('.bybit-trade-tooltip')).toContainText('400 笔', { timeout: 500 })
  }).toPass({ timeout: 10_000 })
  // A filtered Volume cache cannot supply below-threshold trades for Aggregate.
  expect(partReads).toBe(reads + 1)
})
