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

test('大单气泡阈值单位、模式和样式可刷新恢复，也支持配置导出和导入', async ({ page }) => {
  await connectFixture(page)
  await page.addInitScript(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText
    let drawingBubbleTooltip = false
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (this.canvas.closest('[data-pane-id="candle_pane"]')) {
        if (text.startsWith('大单气泡（Big Trades）')) {
          drawingBubbleTooltip = true
        } else if (drawingBubbleTooltip && text === '\ue902') {
          const point = new DOMPoint(x, y).matrixTransform(this.getTransform())
          const rect = this.canvas.getBoundingClientRect()
          Object.assign(window, { bubbleGear: { x: rect.left + point.x / devicePixelRatio, y: rect.top + point.y / devicePixelRatio } })
          drawingBubbleTooltip = false
        }
      }
      if (maxWidth === undefined) fillText.call(this, text, x, y)
      else fillText.call(this, text, x, y, maxWidth)
    }
  })
  const chart = page.getByTestId('chart-host')
  const settings = page.getByRole('dialog', { name: '大单气泡（Big Trades）设置' })
  const buyFill = settings.getByLabel('主动买入填充色', { exact: true })
  const bubbleMode = settings.getByLabel('大单模式', { exact: true })
  const buyTransparency = settings.getByLabel('主动买入填充色透明度')
  const unit = settings.getByLabel('阈值单位', { exact: true })
  const marker = settings.getByLabel('标记形状', { exact: true })
  const dynamicSize = settings.getByLabel('按成交量调整大小', { exact: true })
  const dynamicOpacity = settings.getByLabel('按成交量调整透明度', { exact: true })
  const maxRadius = settings.getByLabel('最大半径', { exact: true })
  const fixedRadius = settings.getByLabel('固定半径', { exact: true })
  const maxBubbles = settings.getByLabel('最大显示数量', { exact: true })
  const palette = settings.getByRole('button', { name: '配色', exact: true })
  const confirm = settings.getByRole('button', { name: '保存', exact: true })
  const openSettings = async () => {
    const showInfo = page.getByRole('button', { name: '显示主图指标信息', exact: true })
    if (await showInfo.isVisible()) await showInfo.click()
    await expect(async () => {
      const gear = await page.evaluate(() => (window as unknown as { bubbleGear?: { x: number; y: number } }).bubbleGear)
      expect(gear).toBeDefined()
      await page.mouse.click(gear!.x + 3, gear!.y + 3)
      await expect(settings).toBeVisible({ timeout: 400 })
    }).toPass({ timeout: 5000 })
    await expect(palette).toHaveAttribute('aria-expanded', 'false')
    await expect(buyFill).toHaveCount(0)
    await palette.click()
  }
  await page.goto('/')
  await expect(page.getByRole('contentinfo')).toContainText('EURUSD')
  await chart.getByText('指标', { exact: true }).click()
  const indicatorList = page.locator('.klinecharts-pro-indicator-modal-list')
  await indicatorList.getByText('MA(移动平均线)', { exact: true }).first().click()
  await indicatorList.getByText('大单气泡（Big Trades）', { exact: true }).click()
  await page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  await openSettings()
  await expect(bubbleMode).toHaveValue('volume')
  await expect(unit).toHaveValue('notional')
  await expect(maxBubbles).toHaveValue('1000')
  await expect(maxBubbles).toHaveAttribute('max', '1000')
  await maxBubbles.fill('250')
  await expect(dynamicSize).toBeChecked()
  await expect(dynamicOpacity).not.toBeChecked()
  await expect(maxRadius).toHaveValue('20')
  await expect(maxRadius).toHaveAttribute('max', '80')
  await maxRadius.fill('80')
  await marker.selectOption('square')
  await dynamicSize.uncheck()
  await dynamicOpacity.check()
  await expect(maxRadius).toHaveCount(0)
  await fixedRadius.fill('11')
  await settings.getByLabel('显示成交量', { exact: true }).check()
  const appearance = settings.getByRole('button', { name: '气泡样式', exact: true })
  await appearance.click()
  await expect(fixedRadius).toHaveCount(0)
  await appearance.click()
  await expect(fixedRadius).toHaveValue('11')
  await settings.getByLabel('最低成交额（USDT）', { exact: true }).fill('1200')
  await unit.selectOption('quantity')
  await settings.getByLabel('最低成交数量', { exact: true }).fill('0.025')
  await unit.selectOption('contracts')
  await settings.getByLabel('最低成交张数', { exact: true }).fill('12.5')
  await settings.getByLabel('最高成交张数（0 为不限）', { exact: true }).fill('20')
  await expect(buyFill).toHaveValue('#49d4ae')
  await expect(buyTransparency).toHaveValue('58')
  await buyFill.fill('#123456')
  await bubbleMode.selectOption('aggregate')
  await buyTransparency.fill('100')
  await settings.getByLabel('主动卖出描边色透明度').fill('0')
  await confirm.click()
  await expect(settings).toBeHidden()

  await page.reload()
  await openSettings()
  await expect(bubbleMode).toHaveValue('aggregate')
  await expect(marker).toHaveValue('square')
  await expect(dynamicSize).not.toBeChecked()
  await expect(dynamicOpacity).toBeChecked()
  await expect(fixedRadius).toHaveValue('11')
  await dynamicSize.check()
  await expect(maxRadius).toHaveValue('80')
  await dynamicSize.uncheck()
  await expect(maxBubbles).toHaveValue('250')
  await expect(unit).toHaveValue('contracts')
  await expect(settings.getByLabel('最低成交张数', { exact: true })).toHaveValue('12.5')
  await expect(settings.getByLabel('最高成交张数（0 为不限）', { exact: true })).toHaveValue('20')
  await unit.selectOption('notional')
  await expect(settings.getByLabel('最低成交额（USDT）', { exact: true })).toHaveValue('1200')
  await unit.selectOption('quantity')
  await expect(settings.getByLabel('最低成交数量', { exact: true })).toHaveValue('0.025')
  await unit.selectOption('contracts')
  await expect(buyFill).toHaveValue('#123456')
  await expect(buyTransparency).toHaveValue('100')
  await expect(settings.getByLabel('主动卖出描边色透明度')).toHaveValue('0')
  await confirm.click()
  await expect(settings).toBeHidden()

  await page.getByRole('button', { name: '工具', exact: true }).click()
  await page.getByTestId('open-data-manager').click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出应用配置' }).click(),
  ])
  const archive = JSON.parse(await readFile((await download.path())!, 'utf8'))
  const styles = archive.data.preferences.chartIndicators.main.find((setting: { name: string }) => setting.name === 'BIG_TRADES').styles
  const thresholds = archive.data.preferences.chartIndicators.orderFlow.bubbles
  expect(thresholds).toMatchObject({ thresholdUnit: 'contracts', minQuantity: 0.025, minContracts: 12.5, maxContracts: 20 })
  expect(thresholds).toMatchObject({ marker: 'square', showText: true, sizeByVolume: false, opacityByVolume: true, fixedRadius: 11, maxRadius: 80, maxBubbles: 250 })
  expect(styles.bubbleMode).toBe('aggregate')
  expect(styles.bubbleColors.map(({ color }: { color: string }) => color))
    .toEqual(['#12345600', '#ff827e6b', '#49d4aee6', '#ff827e'])
  styles.bubbleColors[0].color = '#654321'
  styles.bubbleMode = 'volume'
  thresholds.thresholdUnit = 'lots'
  thresholds.minLots = 0.02
  thresholds.maxLots = 0
  thresholds.marker = 'circle'
  thresholds.sizeByVolume = true
  thresholds.opacityByVolume = false
  thresholds.maxRadius = 72
  thresholds.maxBubbles = 600
  page.once('dialog', dialog => dialog.accept())
  await page.getByTestId('import-backup-file').setInputFiles({
    name: 'big-trades-style.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)),
  })
  await expect(page.getByTestId('backup-status')).toContainText('刷新页面')
  await page.reload()
  await openSettings()
  await expect(bubbleMode).toHaveValue('volume')
  await expect(unit).toHaveValue('lots')
  await expect(marker).toHaveValue('circle')
  await expect(dynamicSize).toBeChecked()
  await expect(dynamicOpacity).not.toBeChecked()
  await expect(maxRadius).toHaveValue('72')
  await expect(maxBubbles).toHaveValue('600')
  await expect(fixedRadius).toHaveCount(0)
  await expect(settings.getByLabel('最低成交手数', { exact: true })).toHaveValue('0.02')
  await expect(settings.getByLabel('最高成交手数（0 为不限）', { exact: true })).toHaveValue('0')
  await expect(buyFill).toHaveValue('#654321')
  await expect(buyTransparency).toHaveValue('0')
  await page.setViewportSize({ width: 390, height: 740 })
  await expect(confirm).toBeInViewport()
  expect(await settings.locator('.workspace-dialog-body').evaluate(body => body.scrollWidth <= body.clientWidth)).toBe(true)
})

test('订单流分组和设置可独立使用并随配置恢复', async ({ page }) => {
  await connectFixture(page)
  const visibleProfile = '可见范围成交分布（Volume Profile）'
  await page.addInitScript(title => {
    const state = window as unknown as { profileEyes: { icon: string; x: number; y: number }[] }
    const fillText = CanvasRenderingContext2D.prototype.fillText
    let drawingProfileTooltip = false
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (this.canvas.closest('[data-pane-id="candle_pane"]')) {
        if (text === title) {
          state.profileEyes = []
          drawingProfileTooltip = true
        } else if (drawingProfileTooltip && (text === '\ue901' || text === '\ue903')) {
          const point = new DOMPoint(x, y).matrixTransform(this.getTransform())
          const rect = this.canvas.getBoundingClientRect()
          state.profileEyes.push({ icon: text, x: rect.left + point.x / devicePixelRatio + 3, y: rect.top + point.y / devicePixelRatio + 3 })
        } else {
          drawingProfileTooltip = false
        }
      }
      if (maxWidth === undefined) fillText.call(this, text, x, y)
      else fillText.call(this, text, x, y, maxWidth)
    }
  }, visibleProfile)
  await page.goto('/')
  const chart = page.getByTestId('chart-host')
  const list = page.locator('.klinecharts-pro-indicator-modal-list')
  const footprint = '足迹图（Footprint）'
  const profile = '框选成交分布（Profile）'
  const candleProfile = 'K线成交量分布图'
  const vwap = 'VWAP'
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
  const section = (dialog: ReturnType<typeof page.getByRole>, name: string) => dialog.getByRole('button', { name, exact: true })

  await open()
  await expect(list.locator('li.title').first()).toHaveText('订单流')
  await list.getByText(profile, { exact: true }).click()
  await expect(page.getByRole('dialog', { name: profile + '设置' })).toHaveCount(0)
  const profileDialog = await settings(profile)
  const rowSizeLabel = '档宽比例（%）'
  await expect(profileDialog.getByLabel(rowSizeLabel)).toHaveValue('0.01')
  await section(profileDialog, '配色').click()
  await expect(profileDialog.getByLabel('POC 线色', { exact: true })).toHaveAttribute('type', 'color')
  await profileDialog.getByLabel('价值区成交量色', { exact: true }).fill('#a87929')
  await expect(profileDialog.getByLabel('价位档数')).toHaveCount(0)
  await profileDialog.getByLabel('显示 Delta', { exact: true }).uncheck()
  await section(profileDialog, '关键价位').click()
  await profileDialog.getByLabel('显示 POC').uncheck()
  await expect(profileDialog.getByLabel('POC 线色', { exact: true })).toHaveCount(0)
  await profileDialog.getByRole('button', { name: '保存', exact: true }).click()
  const candleProfileDialog = await settings(candleProfile)
  await candleProfileDialog.getByLabel(rowSizeLabel).fill('0')
  await candleProfileDialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(candleProfileDialog.getByRole('alert')).toContainText('档宽比例（%） 无效')
  await candleProfileDialog.getByLabel(rowSizeLabel).fill('0.018')
  await expect(candleProfileDialog.getByLabel('显示 Delta', { exact: true })).toBeChecked()
  await candleProfileDialog.getByLabel('显示 Delta', { exact: true }).uncheck()
  await candleProfileDialog.getByLabel('显示各档成交量').check()
  await section(candleProfileDialog, '关键价位').click()
  await expect(candleProfileDialog.getByLabel('显示价格线标签', { exact: true })).not.toBeChecked()
  await expect(candleProfileDialog.getByLabel('显示 VAH / VAL', { exact: true })).toBeChecked()
  await candleProfileDialog.getByLabel('显示 POC').uncheck()
  await candleProfileDialog.getByLabel('价值区（%）').fill('82')
  await section(candleProfileDialog, '配色').click()
  await expect(candleProfileDialog.getByLabel('价值区成交量色', { exact: true })).toHaveValue('#a87929')
  await candleProfileDialog.getByLabel('成交量色', { exact: true }).fill('#456789')
  await candleProfileDialog.getByRole('button', { name: '保存', exact: true }).click()
  const bubbleDialog = await settings(bubbles)
  await section(bubbleDialog, '配色').click()
  await expect(bubbleDialog.getByLabel('主动买入填充色', { exact: true })).toHaveAttribute('type', 'color')
  await bubbleDialog.getByLabel('标记形状').selectOption('diamond')
  await bubbleDialog.getByLabel('空心标记').check()
  await expect(bubbleDialog.getByLabel('主动买入填充色', { exact: true })).toHaveCount(0)
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
  await section(footprintDialog, '配色').click()
  await expect(footprintDialog.getByLabel('失衡色', { exact: true })).toHaveAttribute('type', 'color')
  await footprintDialog.getByLabel('失衡色', { exact: true }).fill('#345678')
  await footprintDialog.getByLabel('失衡色透明度', { exact: true }).fill('100')
  await expect(footprintDialog.getByLabel('图形内容', { exact: true })).toHaveValue('matchText')
  await footprintDialog.getByLabel('数值内容', { exact: true }).selectOption('bidAsk')
  await footprintDialog.getByLabel('图形内容', { exact: true }).selectOption('delta')
  await footprintDialog.getByLabel('显示数值', { exact: true }).uncheck()
  await expect(footprintDialog.getByLabel('字号', { exact: true })).toHaveCount(0)
  await expect(footprintDialog.getByLabel('数值内容', { exact: true })).toHaveCount(0)
  await footprintDialog.getByLabel('显示数值', { exact: true }).check()
  await section(footprintDialog, '价位分组与筛选').click()
  await expect(footprintDialog.getByLabel('自动目标档数', { exact: true })).toBeVisible()
  await footprintDialog.getByLabel('价位分组', { exact: true }).selectOption('manual')
  await expect(footprintDialog.getByLabel('自动目标档数', { exact: true })).toHaveCount(0)
  await expect(footprintDialog.getByLabel('手动每档 ticks', { exact: true })).toBeVisible()
  await footprintDialog.getByLabel('价位分组', { exact: true }).selectOption('auto')
  await footprintDialog.getByLabel('显示样式').selectOption('histogram')
  await footprintDialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(list.getByRole('button', { name: footprint, exact: true })).toHaveAttribute('aria-pressed', 'false')
  await list.getByRole('button', { name: footprint, exact: true }).click()
  await list.getByRole('button', { name: cvd, exact: true }).click()
  const viewportProfile = await settings(visibleProfile)
  await expect(viewportProfile.getByLabel(rowSizeLabel)).toHaveValue('0.018')
  await viewportProfile.getByLabel(rowSizeLabel).fill('0.02')
  await expect(viewportProfile.getByLabel('位置', { exact: true })).toHaveValue('right')
  await viewportProfile.getByLabel('位置', { exact: true }).selectOption('left')
  await viewportProfile.getByLabel('距边缘偏移（%）', { exact: true }).fill('12')
  await viewportProfile.getByLabel('总宽度（占主图 %）', { exact: true }).fill('19')
  await viewportProfile.getByLabel('显示列标题', { exact: true }).uncheck()
  await section(viewportProfile, '关键价位').click()
  await expect(viewportProfile.getByLabel('显示 POC', { exact: true })).toBeChecked()
  await expect(viewportProfile.getByLabel('显示 VAH / VAL', { exact: true })).toBeChecked()
  await viewportProfile.getByLabel('显示 POC', { exact: true }).uncheck()
  await viewportProfile.getByLabel('显示价格线标签', { exact: true }).uncheck()
  await expect(viewportProfile.getByLabel('价值区（%）', { exact: true })).toHaveValue('82')
  await viewportProfile.getByLabel('价值区（%）', { exact: true }).fill('77')
  await section(viewportProfile, '配色').click()
  await viewportProfile.getByLabel('价值区成交量色', { exact: true }).fill('#5494ce')
  await viewportProfile.getByLabel('显示内容', { exact: true }).selectOption('delta')
  await expect(viewportProfile.getByLabel('成交量颜色', { exact: true })).toHaveCount(0)
  await expect(viewportProfile.getByLabel('价值区成交量色', { exact: true })).toHaveCount(0)
  await viewportProfile.getByLabel('正 Delta 颜色', { exact: true }).fill('#123456')
  await viewportProfile.getByLabel('显示 Delta', { exact: true }).uncheck()
  await expect(viewportProfile.getByLabel('正 Delta 颜色', { exact: true })).toHaveCount(0)
  await expect(viewportProfile.getByLabel('成交量颜色', { exact: true })).toHaveAttribute('type', 'color')
  await viewportProfile.getByRole('button', { name: '保存', exact: true }).click()
  for (const name of [vwap, visibleProfile, candleProfile]) {
    const button = list.getByRole('button', { name, exact: true })
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await button.click()
  }
  await expect(list.getByRole('button', { name: cvd, exact: true })).toHaveAttribute('aria-pressed', 'true')
  for (const name of [vwap, visibleProfile, candleProfile]) {
    await expect(list.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true')
  }
  const cvdDialog = await settings(cvd)
  await expect(cvdDialog.getByLabel('显示样式', { exact: true })).toHaveValue('candlestick')
  await section(cvdDialog, '配色').click()
  await expect(cvdDialog.getByLabel('正值色', { exact: true })).toHaveAttribute('type', 'color')
  await cvdDialog.getByLabel('显示零线', { exact: true }).uncheck()
  await expect(cvdDialog.getByLabel('零线色', { exact: true })).toHaveCount(0)
  await cvdDialog.getByLabel('显示样式', { exact: true }).selectOption('histogram')
  await expect(cvdDialog.getByLabel('线宽', { exact: true })).toHaveCount(0)
  await cvdDialog.getByRole('button', { name: '取消', exact: true }).click()
  await close()

  const showInfo = chart.getByRole('button', { name: '显示主图指标信息', exact: true })
  if (await showInfo.isVisible()) await showInfo.click()
  const eyes = () => page.evaluate(() =>
    (window as unknown as { profileEyes?: { icon: string; x: number; y: number }[] }).profileEyes ?? [])
  const storedVisibility = () => page.evaluate(() => {
    const saved = localStorage.getItem('crypto-contract-workstation:ctrader:chart.indicators.v1')
    return JSON.parse(saved ?? 'null')?.main.find((item: { name: string }) => item.name === 'VISIBLE_VOLUME_PROFILE')?.visible
  })
  const clickEye = async (icon: string) => {
    const [eye] = await eyes()
    expect(eye?.icon).toBe(icon)
    await page.mouse.click(eye.x, eye.y)
  }
  await expect.poll(async () => (await eyes()).map(eye => eye.icon)).toEqual(['\ue901'])
  await clickEye('\ue901')
  await expect.poll(storedVisibility).toBe(false)
  await expect.poll(async () => (await eyes()).map(eye => eye.icon)).toEqual(['\ue903'])
  await page.reload()
  await expect.poll(async () => (await eyes()).map(eye => eye.icon)).toEqual(['\ue903'])
  await clickEye('\ue903')
  await expect.poll(storedVisibility).toBe(true)
  await expect.poll(async () => (await eyes()).map(eye => eye.icon)).toEqual(['\ue901'])
  await open()
  await expect(list.getByRole('button', { name: footprint, exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(list.getByRole('button', { name: cvd, exact: true })).toHaveAttribute('aria-pressed', 'true')
  const restored = await settings(footprint)
  await section(restored, '配色').click()
  await expect(restored.getByLabel('失衡色', { exact: true })).toHaveValue('#345678')
  await expect(restored.getByLabel('失衡色透明度', { exact: true })).toHaveValue('100')
  await expect(restored.getByLabel('数值内容', { exact: true })).toHaveValue('bidAsk')
  await expect(restored.getByLabel('图形内容', { exact: true })).toHaveValue('delta')
  await expect(restored.getByLabel('显示样式')).toHaveValue('histogram')
  await restored.getByRole('button', { name: '取消', exact: true }).click()
  const restoredProfile = await settings(visibleProfile)
  await expect(restoredProfile.getByLabel('位置', { exact: true })).toHaveValue('left')
  await expect(restoredProfile.getByLabel('距边缘偏移（%）', { exact: true })).toHaveValue('12')
  await expect(restoredProfile.getByLabel('显示列标题', { exact: true })).not.toBeChecked()
  await expect(restoredProfile.getByLabel('显示 Delta', { exact: true })).not.toBeChecked()
  await section(restoredProfile, '关键价位').click()
  await expect(restoredProfile.getByLabel('价值区（%）', { exact: true })).toHaveValue('77')
  await expect(restoredProfile.getByLabel('显示 POC', { exact: true })).not.toBeChecked()
  await restoredProfile.getByRole('button', { name: '取消', exact: true }).click()
  await expect(list.getByRole('button', { name: candleProfile, exact: true })).toHaveAttribute('aria-pressed', 'true')
  const restoredCandleProfile = await settings(candleProfile)
  await expect(restoredCandleProfile.getByLabel(rowSizeLabel)).toHaveValue('0.02')
  await expect(restoredCandleProfile.getByLabel('显示 Delta', { exact: true })).not.toBeChecked()
  await section(restoredCandleProfile, '关键价位').click()
  await expect(restoredCandleProfile.getByLabel('价值区（%）', { exact: true })).toHaveValue('77')
  await section(restoredCandleProfile, '配色').click()
  await expect(restoredCandleProfile.getByLabel('成交量色', { exact: true })).toHaveValue('#456789')
  await expect(restoredCandleProfile.getByLabel('价值区成交量色', { exact: true })).toHaveValue('#a87929')
  await restoredCandleProfile.getByRole('button', { name: '取消', exact: true }).click()
  await close()

  await page.getByRole('button', { name: '工具', exact: true }).click()
  await page.getByTestId('open-data-manager').click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出应用配置' }).click(),
  ])
  const archive = JSON.parse(await readFile((await download.path())!, 'utf8'))
  const main = archive.data.preferences.chartIndicators.main as import('../src/chart/indicator-preferences').ChartIndicatorSetting[]
  expect(main.filter(({ name }) => ['VWAP', 'VISIBLE_VOLUME_PROFILE', 'CANDLE_VOLUME_PROFILE'].includes(name))).toEqual(expect.arrayContaining([
    { name: 'VWAP', calcParams: [], visible: true, styles: null },
    { name: 'VISIBLE_VOLUME_PROFILE', calcParams: [], visible: true, styles: null },
    { name: 'CANDLE_VOLUME_PROFILE', calcParams: [], visible: true, styles: null },
  ]))
  archive.data.preferences.chartIndicators.main = main.filter(({ name }) => name !== 'VWAP')
  const orderFlow = archive.data.preferences.chartIndicators.orderFlow
  expect(orderFlow.profile).toMatchObject({ valueArea: 77, rowSizePercent: 0.02, showPoc: false, showDelta: false })
  expect(orderFlow.candleProfile).toMatchObject({ showPoc: false, showDelta: false, showValues: true })
  expect(orderFlow.candleProfile).not.toHaveProperty('valueArea')
  expect(orderFlow.candleProfile.volumeColor).toMatch(/^#456789/)
  expect(orderFlow.candleProfile).not.toHaveProperty('valueAreaColor')
  expect(orderFlow.visibleProfile).toMatchObject({ placement: 'left', offset: 12, width: 19, type: 'delta', showHeaders: false })
  expect(orderFlow.visibleProfile).toMatchObject({ showPoc: false, showValueArea: true, showLabels: false, showDelta: false })
  expect(orderFlow.visibleProfile).not.toHaveProperty('valueArea')
  expect(orderFlow.visibleProfile.valueAreaColor).toMatch(/^#5494ce/)
  expect(orderFlow.visibleProfile.positiveColor).toMatch(/^#123456/)
  expect(orderFlow.bubbles).toMatchObject({ marker: 'diamond', hollow: true, minRadius: 0, mode: 'aggregate', minNotional: 1200 })
  expect(orderFlow.footprint).toMatchObject({ type: 'bidAsk', plotType: 'delta', layout: 'histogram', imbalanceColor: '#34567800' })
  orderFlow.profile.rows = 35
  orderFlow.profile.rowSizePercent = 0.025
  orderFlow.profile.valueArea = 74
  orderFlow.profile.valueAreaColor = '#be8b3c'
  Object.assign(orderFlow.candleProfile, { rows: 36, showDelta: true, showValueArea: false, showPoc: true })
  Object.assign(orderFlow.visibleProfile, { placement: 'right', offset: 0, type: 'volume', rows: 60,
    showPoc: true, valueArea: 84, valueAreaColor: '#135680' })
  orderFlow.footprint.plotType = 'volume'
  orderFlow.footprint.imbalanceColor = 'rgba(18,52,86,0.25)'
  page.once('dialog', dialog => dialog.accept())
  await page.getByTestId('import-backup-file').setInputFiles({
    name: 'order-flow.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)),
  })
  await expect(page.getByTestId('backup-status')).toContainText('刷新页面')
  await page.reload()
  await open()
  await expect(list.getByRole('button', { name: vwap, exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(list.getByRole('button', { name: visibleProfile, exact: true })).toHaveAttribute('aria-pressed', 'true')
  const importedViewportProfile = await settings(visibleProfile)
  await expect(importedViewportProfile.getByLabel(rowSizeLabel)).toHaveValue('0.025')
  await expect(importedViewportProfile.getByLabel('位置', { exact: true })).toHaveValue('right')
  await expect(importedViewportProfile.getByLabel('距边缘偏移（%）', { exact: true })).toHaveValue('0')
  await expect(importedViewportProfile.getByLabel('显示内容', { exact: true })).toHaveValue('volume')
  await section(importedViewportProfile, '关键价位').click()
  await expect(importedViewportProfile.getByLabel('显示 POC', { exact: true })).toBeChecked()
  await expect(importedViewportProfile.getByLabel('显示价格线标签', { exact: true })).not.toBeChecked()
  await expect(importedViewportProfile.getByLabel('价值区（%）', { exact: true })).toHaveValue('74')
  await section(importedViewportProfile, '配色').click()
  await expect(importedViewportProfile.getByLabel('价值区成交量色', { exact: true })).toHaveValue('#135680')
  await importedViewportProfile.getByRole('button', { name: '取消', exact: true }).click()
  const imported = await settings(profile)
  await expect(imported.getByLabel(rowSizeLabel)).toHaveValue('0.025')
  await expect(imported.getByLabel('显示 Delta', { exact: true })).not.toBeChecked()
  await section(imported, '关键价位').click()
  await expect(imported.getByLabel('价值区（%）', { exact: true })).toHaveValue('74')
  await expect(imported.getByLabel('显示 POC')).not.toBeChecked()
  await imported.getByRole('button', { name: '取消', exact: true }).click()
  const importedCandleProfile = await settings(candleProfile)
  await expect(importedCandleProfile.getByLabel(rowSizeLabel)).toHaveValue('0.025')
  await expect(importedCandleProfile.getByLabel('显示 Delta', { exact: true })).toBeChecked()
  await section(importedCandleProfile, '关键价位').click()
  await expect(importedCandleProfile.getByLabel('显示 POC', { exact: true })).toBeChecked()
  await expect(importedCandleProfile.getByLabel('显示 VAH / VAL', { exact: true })).not.toBeChecked()
  await importedCandleProfile.getByLabel('显示 VAH / VAL', { exact: true }).check()
  await expect(importedCandleProfile.getByLabel('价值区（%）', { exact: true })).toHaveValue('74')
  await section(importedCandleProfile, '配色').click()
  await expect(importedCandleProfile.getByLabel('成交量色', { exact: true })).toHaveValue('#456789')
  await expect(importedCandleProfile.getByLabel('价值区成交量色', { exact: true })).toHaveValue('#be8b3c')
  await importedCandleProfile.getByRole('button', { name: '取消', exact: true }).click()
  const importedFootprint = await settings(footprint)
  await section(importedFootprint, '配色').click()
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
  await page.addInitScript(() => {
    const modes = new Set<GlobalCompositeOperation>()
    Object.assign(window, { candleProfileLevelModes: modes })
    const stroke = CanvasRenderingContext2D.prototype.stroke
    CanvasRenderingContext2D.prototype.stroke = function (...args: Parameters<typeof stroke>) {
      if (this.strokeStyle === '#37c7ef') modes.add(this.globalCompositeOperation)
      return Reflect.apply(stroke, this, args)
    }
  })
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
  const indicators = page.locator('.klinecharts-pro-indicator-modal-list')
  const candleProfileToggle = indicators.getByRole('button', { name: 'K线成交量分布图', exact: true })
  await candleProfileToggle.click()
  await indicators.getByRole('button', { name: 'K线成交量分布图设置', exact: true }).click()
  const candleSettings = page.getByRole('dialog', { name: 'K线成交量分布图设置', exact: true })
  await candleSettings.getByRole('button', { name: '配色', exact: true }).click()
  await candleSettings.getByLabel('VAH / VAL 线色', { exact: true }).fill('#37c7ef')
  await candleSettings.getByRole('button', { name: '保存', exact: true }).click()
  await indicators.getByRole('button', { name: '大单气泡（Big Trades）', exact: true }).click()
  await indicators.getByRole('button', { name: 'VWAP', exact: true }).click()
  await indicators.getByRole('button', { name: '可见范围成交分布（Volume Profile）', exact: true }).click()
  const visibleProfileSettings = page.getByRole('dialog', { name: '可见范围成交分布（Volume Profile）设置' })
  await indicators.getByRole('button', { name: '可见范围成交分布（Volume Profile）设置', exact: true }).click()
  await visibleProfileSettings.getByLabel('位置', { exact: true }).selectOption('left')
  await visibleProfileSettings.getByRole('button', { name: '关键价位', exact: true }).click()
  await visibleProfileSettings.getByLabel('价值区（%）', { exact: true }).fill('74')
  await visibleProfileSettings.getByRole('button', { name: '保存', exact: true }).click()
  await page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  const perCandleProfiles = () => page.evaluate(start => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    const indicator = coreChart.getIndicatorByPaneId('candle_pane', 'CANDLE_VOLUME_PROFILE') as import('klinecharts').Indicator | null
    const { profiles } = (indicator?.extendData ?? {}) as import('../src/chart/order-flow-indicators').CandleProfileDisplay
    return [start, start + 60_000].map(timestamp => {
      const profile = profiles?.get(timestamp)
      if (!profile) return null
      return { poc: profile.poc, val: profile.val, vah: profile.vah, buy: profile.rows.reduce((sum, row) => sum + row.buy, 0),
        sell: profile.rows.reduce((sum, row) => sum + row.sell, 0) }
    })
  }, start)
  const combined = () => page.evaluate(() => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    const panes = coreChart.getIndicatorByPaneId() as Map<string, Map<string, import('klinecharts').Indicator>>
    const volume = [...panes.values()].find(pane => pane.has('VOL'))?.get('VOL')
    const bubbles = panes.get('candle_pane')?.get('BIG_TRADES')
    const bars = bubbles?.extendData?.bars as import('../src/chart/order-flow-renderers').BubbleDisplay['bars']
    const candles = coreChart.getDataList()
    const profile = panes.get('candle_pane')?.get('VISIBLE_VOLUME_PROFILE')?.extendData as import('../src/chart/order-flow-indicators').VisibleProfileDisplay | undefined
    const vwap = panes.get('candle_pane')?.get('VWAP')?.result.at(-1)?.price
    return { volumeName: volume?.shortName, volume: volume?.result.at(-1)?.volume, updating: bubbles?.extendData?.updating,
      vwap, profileSettings: profile?.settings, profilePrices: profile?.prices, profileBuy: profile?.rows?.reduce((total, row) => total + row.buy, 0),
      profileSell: profile?.rows?.reduce((total, row) => total + row.sell, 0),
      points: Array.from(bars ?? []).flatMap(([stamp, row]) => {
        const open = candles.find(candle => candle.timestamp === stamp)?.open ?? 0
        const points = row.pointRanges.flatMap(({ points, from, until }) => points.slice(from, until))
        return points.filter(({ trade }) => trade.price * trade.size >= Number(bubbles?.calcParams[0]))
          .map(({ trade }) => [trade.id, trade.price, Math.round(trade.price * (open / row.firstPrice!) * 1e5) / 1e5])
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
  await expect.poll(combined).toMatchObject({ profileSell: 0, profileSettings: { placement: 'left', valueArea: 74 } })
  await expect.poll(perCandleProfiles).toEqual([{ poc: 1.1002, val: 1.1002, vah: 1.1002, buy: 40, sell: 0 }, null])
  await expect.poll(() => page.evaluate(() =>
    Array.from((window as unknown as { candleProfileLevelModes: Set<GlobalCompositeOperation> }).candleProfileLevelModes),
  )).toEqual(['source-over'])
  // Switch with the per-candle profile active and require another foreground draw.
  await chart.getByText('设置', { exact: true }).locator('..').click()
  const settings = page.locator('.klinecharts-pro-setting-modal-content')
  await settings.locator('.klinecharts-pro-select').first().click()
  await page.evaluate(() => (window as unknown as { candleProfileLevelModes: Set<GlobalCompositeOperation> }).candleProfileLevelModes.clear())
  await settings.getByText('收盘价折线', { exact: true }).last().click()
  await page.locator('.klinecharts-pro-modal .close-icon').click()
  await expect.poll(() => page.evaluate(() =>
    Array.from((window as unknown as { candleProfileLevelModes: Set<GlobalCompositeOperation> }).candleProfileLevelModes),
  )).toEqual(['source-over'])
  expect(await perCandleProfiles()).toEqual([{ poc: 1.1002, val: 1.1002, vah: 1.1002, buy: 40, sell: 0 }, null])
  expect((await combined()).profilePrices).toMatchObject({ poc: expect.any(Number), vah: expect.any(Number), val: expect.any(Number) })
  expect((await combined()).profileBuy).toBeGreaterThanOrEqual(40)
  expect((await combined()).vwap).toBeCloseTo(1.1002, 3)
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
  await expect.poll(combined).toMatchObject({ profileSell: 50 })
  await expect.poll(perCandleProfiles).toEqual([
    { poc: 1.1002, val: 1.1002, vah: 1.1002, buy: 40, sell: 0 },
    { poc: 1.1002, val: 1.1002, vah: 1.1002, buy: 0, sell: 50 },
  ])
  await chart.getByText('指标', { exact: true }).click()
  await candleProfileToggle.click()
  await page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  const scrollProfile = (beforeLast: boolean) => page.evaluate(beforeLast => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    if (beforeLast) coreChart.scrollToDataIndex(coreChart.getDataList().length - 3)
    else coreChart.scrollToRealTime()
  }, beforeLast)
  await scrollProfile(true)
  await expect.poll(async () => (await combined()).profileSell).toBe(0)
  await scrollProfile(false)
  await expect.poll(async () => (await combined()).profileSell).toBe(50)
  expect(futureReads).toBe(readsBeforeStep)
  expect(await page.evaluate(() => (window as unknown as { __replayStepScans: number }).__replayStepScans)).toBe(0)
  const drawingBar = chart.locator('.klinecharts-pro-drawing-bar')
  const tool = drawingBar.getByRole('button', { name: '框选成交分布' })
  await expect(tool).toBeEnabled()
  const shapeTool = drawingBar.locator('.item:has(> .icon-arrow)').nth(2)
  await shapeTool.locator('.icon-arrow').click()
  const firstShape = shapeTool.locator('.list li').first()
  await expect(firstShape).toHaveText('矩形')
  expect(await shapeTool.locator(':scope > span > svg').innerHTML())
    .toBe(await firstShape.locator('svg').innerHTML())

  const profileIcon = tool.locator('svg')
  await expect(profileIcon).toHaveClass('icon-overlay')
  await expect(profileIcon).toHaveCSS('width', '32px')
  await expect(tool).toHaveAttribute('aria-pressed', 'false')
  const rail = (await drawingBar.boundingBox())!
  const button = (await tool.boundingBox())!
  expect(Math.abs(rail.x + rail.width / 2 - button.x - button.width / 2)).toBeLessThan(1)
  await tool.click()
  await expect(tool).toHaveAttribute('aria-pressed', 'true')
  await expect(profileIcon).toHaveClass(/selected/)
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
  await expect(tool).toHaveAttribute('aria-pressed', 'false')
  await expect(profileIcon).toHaveClass('icon-overlay')
  const profileState = (save = false) => page.evaluate(save => {
    const state = window as unknown as { __viewportTestAdapter: {
      coreChart: import('klinecharts').Chart
      orderFlow: { profiles: Map<string, { range: { fromUs: number; untilUs: number }; operation?: AbortController }> }
      drawings: { rendered: Map<string, import('../src/chart/drawings').ChartDrawing> }
    }; __savedProfile?: unknown; __replayStepScans: number }
    const { coreChart, orderFlow, drawings } = state.__viewportTestAdapter
    const [id, request] = [...orderFlow.profiles][0]
    const overlay = coreChart.getOverlayById(id)!
    const rows = overlay.extendData?.profile?.rows as { low: number; high: number; buy: number; sell: number }[] | undefined
    if (save) state.__savedProfile = request
    return { ...request.range, savedTimes: drawings.rendered.get(id)?.points.map(point => point.timestamp),
      sameProfile: state.__savedProfile === request, busy: !!request.operation, scans: state.__replayStepScans,
      bounds: [rows?.[0]?.low, rows?.at(-1)?.high], total: rows?.reduce((sum, row) => sum + row.buy + row.sell, 0),
      handles: overlay.points.map(point => point.value) }
  }, save)
  await expect.poll(() => profileState()).toMatchObject({ savedTimes: [start, start + 60_000], total: 40, busy: false, scans: 0 })
  const original = await profileState(true)
  const handle = await page.evaluate(start => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    const pane = coreChart.getDom('candle_pane', 'main' as import('klinecharts').DomPosition)!.getBoundingClientRect()
    const index = coreChart.getDataList().findIndex(bar => bar.timestamp === start)
    const toPixel = (dataIndex: number) => coreChart.convertToPixel({ dataIndex, value: 1.1002 }, { paneId: 'candle_pane' }) as { x: number; y: number }
    const point = toPixel(index + 1)
    return { x: pane.left + point.x, y: pane.top + point.y, next: pane.left + toPixel(index + 2).x,
      far: pane.right - 4, top: pane.top + 1 }
  }, start)
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.mouse.move(handle.x, handle.top, { steps: 4 })
  await page.mouse.up()
  expect(await profileState()).toEqual(original)

  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.mouse.move(handle.next, handle.y + 12, { steps: 4 })
  await expect.poll(() => profileState()).toMatchObject({ total: 90, busy: false, scans: 0 })
  await page.mouse.up()
  await expect.poll(() => profileState()).toMatchObject({ savedTimes: [start, start + 120_000], total: 90, busy: false, scans: 0 })
  expect(handle.far).toBeGreaterThan(handle.next)
  await page.mouse.move(handle.next - 1, handle.y)
  await page.mouse.down()
  await page.mouse.move(handle.far, handle.top, { steps: 4 })
  await expect.poll(() => profileState()).toMatchObject({ untilUs: (start + 120_000) * 1000, total: 90, busy: false, scans: 0 })
  await page.mouse.up()
  await chart.getByText('指标', { exact: true }).click()
  await page.getByRole('button', { name: '框选成交分布（Profile）设置', exact: true }).click()
  const profileSettings = page.getByRole('dialog', { name: '框选成交分布（Profile）设置' })
  await profileSettings.getByRole('button', { name: '关键价位', exact: true }).click()
  await profileSettings.getByLabel('价值区（%）', { exact: true }).fill('80')
  await profileSettings.getByRole('button', { name: '保存', exact: true }).click()
  await page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  await expect.poll(() => page.evaluate(() => {
    const adapter = (window as unknown as { __viewportTestAdapter: {
      coreChart: import('klinecharts').Chart; orderFlow: { profiles: Map<string, unknown> }
    } }).__viewportTestAdapter
    const display = adapter.coreChart.getOverlayById([...adapter.orderFlow.profiles.keys()][0])?.extendData
    return { rows: display?.profile?.rows.length, valueArea: display?.settings?.valueArea }
  })).toEqual({ rows: 1, valueArea: 80 })

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
      cvd: cvd?.result.at(-1),
    }
  }, start)).toMatchObject({ spacing: 110, volume: 90,
    cvd: { open: expect.any(Number), high: expect.any(Number), low: expect.any(Number), close: -9 } })
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __footprintTextLayers: Record<string, number> }
  ).__footprintTextLayers), { timeout: 3000 }).toEqual({ '40': 1 })
})

test('实时成交可按数量与手数显示大单，切到未匹配品种时恢复报价量', async ({ page }) => {
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
  await page.evaluate(() => {
    const state = window as unknown as { bubbleLabels: string[] }
    state.bubbleLabels = []
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (this.fillStyle === '#f2f5fa') state.bubbleLabels.push(text)
      if (maxWidth === undefined) fillText.call(this, text, x, y)
      else fillText.call(this, text, x, y, maxWidth)
    }
  })
  const bubbleLabels = () => page.evaluate(() => (window as unknown as { bubbleLabels: string[] }).bubbleLabels)
  const list = page.locator('.klinecharts-pro-indicator-modal-list')
  const label = '大单气泡（Big Trades）'
  const closeIndicators = () => page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  await chart.getByText('指标', { exact: true }).click()
  await list.getByRole('button', { name: label, exact: true }).click()
  await list.getByRole('button', { name: `${label}设置`, exact: true }).click()
  const bubbleSettings = page.getByRole('dialog', { name: `${label}设置` })
  await bubbleSettings.getByLabel('阈值单位').selectOption('quantity')
  await bubbleSettings.getByLabel('最低成交数量', { exact: true }).fill('5')
  await bubbleSettings.getByLabel('显示成交量', { exact: true }).check()
  await bubbleSettings.getByRole('button', { name: '保存', exact: true }).click()
  await closeIndicators()
  ethereum!.send(JSON.stringify({ topic: 'publicTrade.ETHUSDT', data: [
    { T: start + 20_000, s: 'ETHUSDT', S: 'Sell', v: '8', p: '1.1002', i: 'next' },
  ] }))
  await expect.poll(volume).toEqual({ name: 'OKX / Bybit 成交量', value: 8 })
  await expect.poll(bubbleLabels).toContain('8')
  await chart.getByText('指标', { exact: true }).click()
  await list.getByRole('button', { name: `${label}设置`, exact: true }).click()
  await bubbleSettings.getByLabel('阈值单位').selectOption('lots')
  await bubbleSettings.getByLabel('最低成交手数', { exact: true }).fill('0.00005')
  await bubbleSettings.getByLabel('按成交量调整大小', { exact: true }).uncheck()
  await bubbleSettings.getByLabel('固定半径', { exact: true }).fill('26')
  await bubbleSettings.getByRole('button', { name: '保存', exact: true }).click()
  await closeIndicators()
  await expect.poll(bubbleLabels).toContain('0.00008')
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

test('限制气泡显示数量，缩放和刷新后复用完整归档计算结果', async ({ page }) => {
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
  await page.route('https://www.okx.com/api/v5/market/history-trades?*', route => route.fulfill({ status: 503, headers }))
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
  const shownBubbleCount = () => page.evaluate(() => {
    const { coreChart } = (window as unknown as { __viewportTestAdapter: { coreChart: import('klinecharts').Chart } }).__viewportTestAdapter
    const indicator = coreChart.getIndicatorByPaneId('candle_pane', 'BIG_TRADES') as import('klinecharts').Indicator | null
    const points = indicator?.extendData?.points as import('../src/chart/order-flow-renderers').BubbleDisplay['points']
    return Array.from(points?.values() ?? []).reduce((total, candle) => total + candle.length, 0)
  })
  await expect.poll(shownBubbleCount).toBe(400)
  await page.evaluate(() => {
    const { orderFlow } = (window as unknown as { __viewportTestAdapter: { orderFlow: import('../src/chart/order-flow-chart').OrderFlowChart } }).__viewportTestAdapter
    orderFlow.setPreferences({ bubbles: { maxBubbles: 100 } })
  })
  await expect.poll(shownBubbleCount).toBe(100)
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
  await expect.poll(shownBubbleCount).toBe(1)
  await zoom(3)
  await expect.poll(async () => (await bubbleIds()).length).toBe(401)
  await expect.poll(shownBubbleCount).toBe(100)
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
