import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { alignOpenTime, nextOpenTime } from '../src/market-data/intervals'
import { PIVOTS_DEFAULT_PARAMS } from '../src/chart/pivots'
import { fixtureMinutePrices, installArchiveFixtures } from './archive-fixtures'
import { traceNativeRestoreWrites } from './storage-diagnostics'
import { installViewportProbe } from './viewport-probe'

test('keeps hedged positions and their risk orders isolated through reload and session import', async ({ page }) => {
  test.setTimeout(120_000)
  await mockBinance(page, true)
  await page.goto('./')
  await expectCanvasContent(page)
  const controls = page.getByTestId('replay-controls')
  await jumpChart(page, '2026-07-22T00:00')
  await expect(controls.getByText(/起点：/)).toContainText('2026/7/22')
  await setReplayEnd(page, '2026-07-22T05:00')
  await controls.getByRole('button', { name: '创建回放' }).click()
  const panel = page.getByTestId('simulation-panel')
  await panel.getByRole('button', { name: '开多', exact: true }).click()
  await panel.getByRole('button', { name: '空', exact: true }).click()
  await panel.getByRole('button', { name: '开空', exact: true }).click()
  const long = panel.getByTestId('position-long')
  const short = panel.getByTestId('position-short')
  const longRisk = await openPositionEditor(page, 'long', 'risk')
  await longRisk.getByLabel('止盈价格').fill('70000')
  await longRisk.getByRole('button', { name: '设置止盈' }).click()
  await longRisk.getByLabel('止损价格').fill('50000')
  await longRisk.getByRole('button', { name: '设置止损' }).click()
  await longRisk.getByRole('button', { name: '完成' }).click()
  const shortRisk = await openPositionEditor(page, 'short', 'risk')
  await shortRisk.getByLabel('止盈价格').fill('50000')
  await shortRisk.getByRole('button', { name: '设置止盈' }).click()
  await shortRisk.getByLabel('止损价格').fill('70000')
  await shortRisk.getByRole('button', { name: '设置止损' }).click()
  await shortRisk.getByRole('button', { name: '完成' }).click()
  await expect(long.getByTestId('position-summary')).toContainText('70000 / 50000')
  await expect(short.getByTestId('position-summary')).toContainText('50000 / 70000')
  const shortQuantity = await short.getByText('数量', { exact: true }).locator('..').locator('dd').textContent()
  const longReduce = await openPositionEditor(page, 'long', 'reduce')
  await longReduce.getByRole('button', { name: '减 25%' }).click()
  await longReduce.getByRole('button', { name: '完成' }).click()
  await expect(short.getByText('数量', { exact: true }).locator('..').locator('dd')).toHaveText(shortQuantity!)

  await page.getByTestId('open-data-manager').click()
  const backups = page.getByTestId('backup-sync-panel')
  const downloadEvent = page.waitForEvent('download')
  await backups.getByTestId('export-session-backup').click()
  const path = await (await downloadEvent).path()
  expect(path).not.toBeNull()
  await page.getByTestId('close-data-manager').click()
  await page.reload()
  await expect(long.getByTestId('position-summary')).toContainText('70000 / 50000')
  await expect(short.getByTestId('position-summary')).toContainText('50000 / 70000')
  await page.screenshot({ path: test.info().outputPath('hedged-positions.png'), fullPage: true })
  await (await openPositionEditor(page, 'long', 'reduce')).getByRole('button', { name: '全部平仓' }).click()
  await expect(long).toHaveCount(0)
  await expect(short.getByTestId('position-summary')).toContainText('50000 / 70000')
  await (await openPositionEditor(page, 'short', 'reduce')).getByRole('button', { name: '全部平仓' }).click()
  await expect(panel).toContainText('当前无持仓')

  await page.getByTestId('open-data-manager').click()
  page.once('dialog', dialog => dialog.accept())
  await backups.getByTestId('import-backup-file').setInputFiles(path!)
  await expect(backups.getByTestId('backup-status')).toContainText('导入完成')
  await page.reload()
  await expect(long.getByTestId('position-summary')).toContainText('70000 / 50000')
  await expect(short.getByTestId('position-summary')).toContainText('50000 / 70000')
  await expect(short.getByText('数量', { exact: true }).locator('..').locator('dd')).toHaveText(shortQuantity!)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await showTradingPanel(page, 'dock')
  await short.getByRole('button', { name: '止盈止损' }).click()
  await expect(shortRisk.getByRole('button', { name: '设置止损' })).toBeVisible()
})

test.beforeEach(async ({ context }) => {
  // Cover every page in the context; individual manual cloud mocks override this.
  await context.route('https://api.github.com/**', (route) =>
    route.fulfill({ status: 404, json: { message: 'Not Found' } }),
  )
})

test('updates another open tab after configuration sync and preserves its next layout edit', async ({ page, context }) => {
  test.setTimeout(120_000)
  await mockBinance(page, true)
  const github = await mockGitHub(page, true)
  await page.goto('./')
  await expectCanvasContent(page)
  const other = await context.newPage()
  await mockBinance(other, true)
  await other.goto('./')
  await expectCanvasContent(other)
  await page.getByRole('button', { name: '工作区', exact: true }).click()
  await page.getByRole('dialog', { name: '工作区面板', exact: true }).getByLabel('账户摘要', { exact: true }).uncheck()
  await page.clock.runFor(1_500)
  await expect(page.getByTestId('config-sync-status')).toContainText('已与云端同步')
  await other.getByRole('button', { name: '工作区', exact: true }).click()
  const dialog = other.getByRole('dialog', { name: '工作区面板', exact: true })
  await expect(dialog.getByLabel('账户摘要', { exact: true })).not.toBeChecked()
  await dialog.getByLabel('下单面板', { exact: true }).uncheck()
  await page.clock.runFor(1_500)
  await expect.poll(() => {
    const file = github.files.get('projects/crypto-contract-workstation/config/preferences.json')
    return file ? JSON.parse(file.bytes.toString()).workspace.panels : null
  }).toMatchObject({ account: false, order: false })
})

test('keeps an active replay on its symbol when cloud preferences restore another product', async ({ page }) => {
  test.setTimeout(120_000)
  await mockBinance(page, true)
  await installViewportProbe(page)
  await page.goto('./')
  await expectCanvasContent(page)
  await jumpChart(page, '2026-07-22T00:00')
  await expect(page.getByTestId('replay-controls').getByText(/起点：/)).toContainText('2026/7/22')
  await setReplayEnd(page, '2026-07-22T05:00')
  const controls = page.getByTestId('replay-controls')
  await controls.getByRole('button', { name: '创建回放', exact: true }).click()
  await expect(controls.getByRole('button', { name: '下一根', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    localStorage.setItem('marketData.selectedSymbol', JSON.stringify({ ticker: 'ETHUSDT', pricePrecision: 2, volumePrecision: 3 }))
    window.dispatchEvent(new CustomEvent('workstation:preferences-restored', { detail: { source: 'cloud' } }))
  })
  await page.clock.runFor(1_000)
  await expectCanvasContent(page)
  await expect(page.locator('.klinecharts-pro-period-bar .symbol')).toContainText('BTCUSDT')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('marketData.selectedSymbol')!).ticker)).toBe('ETHUSDT')
  await controls.getByRole('button', { name: '下一根', exact: true }).click()
  await expectCanvasContent(page)
  await expect(page.locator('.klinecharts-pro-period-bar .symbol')).toContainText('BTCUSDT')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('marketData.selectedSymbol')!).ticker)).toBe('ETHUSDT')
  await controls.getByRole('button', { name: '回放设置', exact: true }).click()
  await page.getByRole('dialog', { name: '回放会话操作' }).getByRole('button', { name: '结束会话', exact: true }).click()
  await expect(page.locator('.klinecharts-pro-period-bar .symbol')).toContainText('ETHUSDT')
})

test('automatically archives RSI levels and alpha colors and restores cloud configuration before mounting', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await mockBinance(page, true)
  const github = await mockGitHub(page, true)
  await installViewportProbe(page)
  await page.addInitScript(() => {
    if (!localStorage.getItem('chart.indicators.v1')) localStorage.setItem('chart.indicators.v1', JSON.stringify({ schemaVersion: 1, main: [], sub: [{ height: 200, indicators: [{ name: 'RSI', calcParams: [6, 12, 24], visible: true, styles: null }] }] }))
    const labels: string[] = []
    const gears: { x: number; y: number }[] = []
    Object.assign(window, { rsiTestLabels: labels, rsiTestGears: gears })
    const draw = CanvasRenderingContext2D.prototype.fillText
    let rsi = false
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) {
      if (String(text).startsWith('RSI(')) rsi = true
      if (text === '\ue902' && rsi) {
        const p = new DOMPoint(x, y).matrixTransform(this.getTransform())
        const rect = this.canvas.getBoundingClientRect()
        gears.push({ x: rect.left + p.x / devicePixelRatio, y: rect.top + p.y / devicePixelRatio })
        rsi = false
      }
      if (/超卖|超买|^50$|\([+-][\d.]+%\)/.test(String(text))) labels.push(String(text))
      return draw.call(this, text, x, y, ...args)
    }
  })
  await page.goto('./')
  await expectCanvasContent(page)
  await expect(page.getByTestId('config-sync-status')).toContainText('已与云端同步')
  await expect.poll(() => page.evaluate(() => (window as unknown as { rsiTestLabels: string[] }).rsiTestLabels)).toEqual(expect.arrayContaining(['超卖 30', '50', '超买 70']))
  await page.clock.runFor(600)
  await waitForChartRender(page)
  const gear = await page.evaluate(() => (window as unknown as { rsiTestGears: { x: number; y: number }[] }).rsiTestGears.at(-1))
  expect(gear).toBeDefined()
  await page.mouse.move(gear!.x, gear!.y)
  await page.clock.runFor(50)
  await page.mouse.click(gear!.x + 5, gear!.y + 5)
  const settings = page.locator('.klinecharts-pro-indicator-setting-modal-content')
  await expect(settings).toBeVisible()
  await settings.getByLabel('超卖水平', { exact: true }).fill('20')
  await settings.getByLabel('超买水平', { exact: true }).fill('80')
  await settings.getByLabel('超卖线颜色', { exact: true }).fill('#123456')
  await settings.getByLabel('超卖线颜色透明度', { exact: true }).fill('100')
  await settings.getByLabel('50 中线颜色透明度', { exact: true }).fill('50')
  await page.locator('.klinecharts-pro-modal').getByText('确定', { exact: true }).click()
  await page.clock.runFor(1_500)
  const configPath = 'projects/crypto-contract-workstation/config/preferences.json'
  const cloud = () => {
    const file = github.files.get(configPath)
    return file ? JSON.parse(file.bytes.toString()) : null
  }
  await expect.poll(cloud).toMatchObject({ chartIndicators: { sub: [{ indicators: [{ name: 'RSI', calcParams: [6, 12, 24], styles: { rsiLevels: { oversold: 20, overbought: 80 }, rsiLines: [{ color: '#12345600' }, { color: '#76808f80' }] } }] }] } })
  await expect(page.getByTestId('config-sync-status')).toContainText('已与云端同步')
  await expect.poll(() => page.evaluate(() => (window as unknown as { rsiTestLabels: string[] }).rsiTestLabels)).toEqual(expect.arrayContaining(['超卖 20', '超买 80']))
  const host = await page.getByTestId('chart-host').boundingBox()
  await page.mouse.move(host!.x + host!.width / 2, host!.y + 100)
  await expect.poll(() => page.evaluate(() => (window as unknown as { rsiTestLabels: string[] }).rsiTestLabels.some(text => /\([+-][\d.]+%\)/.test(text)))).toBe(true)
  await page.screenshot({ path: test.info().outputPath('rsi-alpha-and-price-difference.png'), fullPage: true })
  await page.getByTestId('open-data-manager').click()
  const backupPanel = page.getByTestId('backup-sync-panel')
  const download = page.waitForEvent('download')
  await backupPanel.getByRole('button', { name: '导出应用配置', exact: true }).click()
  const archive = await (await download).path()
  expect(archive).not.toBeNull()
  const json = JSON.parse(await readFile(archive!, 'utf8'))
  expect(json.data.preferences.chartIndicators).toEqual(cloud().chartIndicators)
  json.data.preferences.chartIndicators.sub[0].indicators[0].styles.rsiLevels.oversold = 25
  page.once('dialog', dialog => dialog.accept())
  await backupPanel.getByTestId('import-backup-file').setInputFiles({ name: 'rsi-alpha.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) })
  await expect(backupPanel.getByTestId('backup-status')).toContainText('导入完成')
  // Reload before the debounce expires: pending imported settings must survive.
  await page.reload()
  await expectCanvasContent(page)
  await expect.poll(cloud).toMatchObject({ chartIndicators: { sub: [{ indicators: [{ styles: { rsiLevels: { oversold: 25, overbought: 80 } } }] }] } })
  // Simulate a browser without existing preferences. Cloud files stay in the mock repository.
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expectCanvasContent(page)
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('chart.indicators.v1')!))
  expect(restored).toEqual(cloud().chartIndicators)
  await expect(page.getByTestId('config-sync-status')).toContainText('已与云端同步')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.screenshot({ path: test.info().outputPath('automatic-cloud-restore-mobile.png'), fullPage: true })
})

test('selects Heikin Ashi from settings, retains real prices and restores the selection from a config archive', async ({ page }) => {
  test.setTimeout(120_000)
  await mockBinance(page, true)
  await installViewportProbe(page)
  await page.goto('./')
  await expectCanvasContent(page)
  const selectType = async (name: string) => {
    await page.locator('.klinecharts-pro-period-bar').getByText('设置', { exact: true }).locator('..').click()
    const settings = page.locator('.klinecharts-pro-setting-modal-content')
    await settings.locator('.klinecharts-pro-select').first().click()
    await settings.getByText(name, { exact: true }).last().click()
    await page.locator('.klinecharts-pro-modal .close-icon').click()
  }
  await selectType('平均 K 线（Heikin Ashi）')
  const note = page.getByRole('note').filter({ hasText: '平均 K 线' })
  await expect(note).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('chart.candleType.v1'))).toBe('"heikin_ashi"')
  await page.reload()
  await expectCanvasContent(page)
  await expect(note).toBeVisible()
  await page.getByTestId('open-data-manager').click()
  const panel = page.getByTestId('backup-sync-panel')
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: '导出应用配置', exact: true }).click()
  const path = await (await download).path()
  expect(path).not.toBeNull()
  await page.getByTestId('close-data-manager').click()
  await selectType('全实心')
  await expect(note).toHaveCount(0)
  await page.getByTestId('open-data-manager').click()
  page.once('dialog', dialog => dialog.accept())
  await panel.getByTestId('import-backup-file').setInputFiles(path!)
  await expect(panel.getByTestId('backup-status')).toContainText('刷新')
  // An open ordinary chart must not overwrite the imported HA preference.
  await page.reload()
  await expectCanvasContent(page)
  await expect(note).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('heikin-ashi.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(note).toBeVisible()
  await page.locator('.klinecharts-pro-period-bar').getByText('设置', { exact: true }).locator('..').click()
  const typeSelect = page.locator('.klinecharts-pro-setting-modal-content .klinecharts-pro-select').first()
  await expect(typeSelect).toContainText('平均 K 线（Heikin Ashi）')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.screenshot({ path: test.info().outputPath('heikin-ashi-settings-mobile.png'), fullPage: true })
  await page.locator('.klinecharts-pro-modal').getByText('恢复默认', { exact: true }).click()
  await expect(note).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('chart.candleType.v1'))).toBe('"candle_solid"')

  const result = await page.evaluate(async () => {
    type Row = { timestamp: number; open: number; high: number; low: number; close: number; volume: number }
    const adapter = (window as unknown as { __viewportTestAdapter: {
      chart: { cancelHistoryRequests(): void }
      coreChart: {
        applyNewData(rows: Row[], more: boolean): void
        updateData(row: Row): void
        getDataList(): Row[]
        getChartStore(): {
          getHeikinAshiData(index: number): Row
          addData(rows: Row[], type: string, more: boolean): Promise<void>
        }
      }
    } }).__viewportTestAdapter
    adapter.chart.cancelHistoryRequests()
    const core = adapter.coreChart
    const store = core.getChartStore()
    const raw = [
      { timestamp: 60000, open: 100, high: 110, low: 98, close: 108, volume: 5 },
      { timestamp: 120000, open: 120, high: 130, low: 118, close: 128, volume: 8 },
      { timestamp: 180000, open: 90, high: 95, low: 80, close: 85, volume: 3 },
    ]
    await store.addData(structuredClone(raw), 'init', false)
    const initial = structuredClone(store.getHeikinAshiData(2))
    core.updateData({ ...raw[2], close: 89 })
    const updated = structuredClone(store.getHeikinAshiData(2))
    core.updateData({ ...raw[2], timestamp: 240000, open: 90, high: 100, close: 96 })
    const appended = structuredClone(store.getHeikinAshiData(3))
    await store.addData([{ timestamp: 0, open: 50, high: 60, low: 40, close: 50, volume: 1 }], 'forward', false)
    const prepended = structuredClone(store.getHeikinAshiData(1))
    const realClose = core.getDataList().at(-1)!.close
    await store.addData([{ ...raw[0], open: 10, high: 14, low: 8, close: 12 }], 'init', false)
    const reset = structuredClone(store.getHeikinAshiData(0))
    return { initial, updated, appended, prepended, realClose, reset, raw }
  })
  expect(result.initial).toMatchObject({ open: 114, high: 114, low: 80, close: 87.5 })
  expect(result.updated).toMatchObject({ open: 114, high: 114, close: 88.5 })
  expect(result.appended).toMatchObject({ open: 101.25, high: 101.25, close: 91.5 })
  expect(result.prepended).toMatchObject({ open: 50, high: 110, low: 50, close: 104 })
  expect(result.realClose).toBe(96)
  expect(result.reset).toMatchObject({ open: 11, high: 14, low: 8, close: 11 })
  expect(result.raw[2].close).toBe(85)
})

test('organizes the workspace, hides every extra panel and restores chart sizing on mobile', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await mockBinance(page, true)
  await page.goto('./')
  await expectCanvasContent(page)
  for (const label of ['下单面板', '持仓面板', '回放控制', '底部状态']) {
    const collapse = page.getByRole('button', { name: `收起${label}`, exact: true })
    await expect(collapse).toHaveAttribute('aria-expanded', 'true', { timeout: 2500 })
    await collapse.click()
    const expand = page.getByRole('button', { name: `展开${label}`, exact: true })
    await expect(expand).toBeVisible()
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    await expand.click()
    await expect(collapse).toHaveAttribute('aria-expanded', 'true')
  }
  for (const label of ['下单面板', '回放控制', '底部状态']) await page.getByRole('button', { name: `收起${label}`, exact: true }).click()
  await expect(page.getByTestId('replay-controls')).toBeHidden()
  await expect(page.locator('.status-footer').getByText('历史训练模拟', { exact: true })).toBeHidden()
  await page.reload()
  for (const label of ['下单面板', '回放控制', '底部状态']) {
    const expand = page.getByRole('button', { name: `展开${label}`, exact: true })
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    await expand.click()
  }
  await expect(page.getByTestId('replay-controls')).toBeVisible()
  await expect(page.locator('.status-footer').getByText('历史训练模拟', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '工作区', exact: true }).click({ timeout: 2500 })
  const settings = page.getByRole('dialog', { name: '工作区面板' })
  for (const label of ['账户摘要', '下单面板', '持仓与复盘', '回放控制', '底部状态']) await settings.getByLabel(label, { exact: true }).uncheck()
  await settings.getByRole('button', { name: '关闭工作区面板' }).click()
  await expect(page.getByRole('region', { name: '行情图表' })).toBeVisible()
  await expect(page.getByRole('button', { name: '工作区', exact: true })).toBeVisible()
  await expect(page.getByTestId('replay-controls')).toBeHidden()
  await expect(page.getByRole('complementary', { name: '模拟下单面板' })).toBeHidden()
  await page.getByRole('button', { name: '工作区', exact: true }).click()
  await settings.getByRole('button', { name: '显示全部面板' }).click()
  await settings.getByRole('button', { name: '关闭工作区面板' }).click()
  await page.getByRole('button', { name: '图表尺寸', exact: true }).click()
  const sizes = page.getByRole('dialog', { name: '图表尺寸设置' })
  await sizes.getByLabel('图表区域高度', { exact: true }).fill('620')
  await sizes.getByRole('button', { name: '关闭图表尺寸设置' }).click()
  await expect(page.getByRole('region', { name: '行情图表' })).toHaveCSS('height', '620px')
  await page.reload()
  await expect(page.getByRole('region', { name: '行情图表' })).toHaveCSS('height', '620px')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: '下单', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '下单', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '模拟下单面板' })).toBeVisible()
  await page.getByRole('button', { name: '收起下单面板' }).click()
  await expect(page.getByRole('complementary', { name: '模拟下单面板' })).toBeHidden()
  await page.getByRole('button', { name: /^持仓/ }).last().click()
  await expect(page.getByRole('region', { name: '持仓与复盘面板' })).toBeVisible()
  await page.getByRole('button', { name: '收起持仓面板' }).click()
  await page.getByRole('button', { name: '图表尺寸', exact: true }).click()
  await sizes.getByLabel('图表区域高度', { exact: true }).fill('480')
  await sizes.getByRole('button', { name: '关闭图表尺寸设置' }).click()
  await expect(page.getByRole('region', { name: '行情图表' })).toHaveCSS('height', '480px')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test('uses the redesigned desktop and touch workspace without losing chart or trade state', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await mockBinance(page, true)
  await page.goto('./')
  await expectCanvasContent(page)
  const originalChart = await page.getByTestId('chart-host').elementHandle()
  const controls = page.getByTestId('replay-controls')
  await controls.getByRole('button', { name: '时间定位', exact: true }).click()
  const time = page.getByRole('dialog', { name: '图表时间定位' })
  await time.getByLabel('图表跳转时间').fill('2026-07-22T00:00')
  await time.getByRole('button', { name: '跳转', exact: true }).click()
  await expect(controls.getByText(/起点：/)).toContainText('2026/7/22')
  await controls.getByRole('button', { name: '回放设置', exact: true }).click()
  const setup = page.getByRole('dialog', { name: '回放会话设置' })
  await setup.getByLabel('回放结束时间').fill('2026-07-22T05:00')
  await setup.getByRole('button', { name: '开始历史回放' }).click()
  const order = page.getByRole('complementary', { name: '模拟下单面板' })
  await order.getByLabel('保证金金额', { exact: true }).fill('100')
  await order.getByRole('button', { name: '计算预估' }).click()
  await expect(order).toContainText('预计成交价')
  await order.getByRole('button', { name: '开多', exact: true }).click()
  await order.getByRole('button', { name: '空', exact: true }).click()
  await order.getByRole('button', { name: '开空', exact: true }).click()
  const long = page.getByTestId('position-long'), short = page.getByTestId('position-short')
  await long.getByRole('button', { name: '止盈止损' }).click()
  const risk = page.getByRole('dialog', { name: '多仓 · 止盈止损' })
  await risk.getByLabel('止盈价格').fill('70000')
  await risk.getByRole('button', { name: '设置止盈' }).click()
  await risk.getByLabel('止损价格').fill('50000')
  await risk.getByRole('button', { name: '设置止损' }).click()
  await risk.getByRole('button', { name: '完成' }).click()
  await expect(long).toContainText('70000 / 50000')
  await expect(short).toContainText('— / —')
  await page.getByRole('tab', { name: '成交记录', exact: true }).click()
  await expect(page.getByRole('tabpanel')).toContainText('开仓 · 空仓')
  await page.getByRole('tab', { name: '复盘统计', exact: true }).click()
  await expect(page.getByRole('tabpanel')).toContainText('成交次数')
  await page.getByRole('tab', { name: '账户流水', exact: true }).click()
  await expect(page.getByRole('tabpanel')).toContainText('initial_balance')
  await page.getByRole('tab', { name: /^持仓/ }).click()
  await page.getByRole('button', { name: '账户详情', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '模拟账户详情' })).toContainText('累计手续费')
  await page.getByRole('button', { name: '关闭模拟账户详情' }).click()
  await order.getByLabel('保证金金额', { exact: true }).fill('157')
  for (const label of ['账户摘要', '下单面板', '持仓面板', '回放控制', '底部状态']) {
    await page.getByRole('button', { name: `收起${label}`, exact: true }).click()
    const expand = page.getByRole('button', { name: `展开${label}`, exact: true })
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    await expand.click()
    await expect(page.getByRole('button', { name: `收起${label}`, exact: true })).toHaveAttribute('aria-expanded', 'true')
  }
  await expect(order.getByLabel('保证金金额', { exact: true })).toHaveValue('157')
  await expect(long).toContainText('70000 / 50000')
  await expect(short).toContainText('— / —')
  await order.getByLabel('保证金金额', { exact: true }).fill('100')
  await page.getByRole('button', { name: '收起底部状态', exact: true }).click()
  await page.getByRole('button', { name: '收起下单面板', exact: true }).click()
  await page.clock.runFor(100)
  await waitForChartRender(page)
  await page.screenshot({ path: test.info().outputPath('desktop-collapse.png'), fullPage: true })
  await page.getByRole('button', { name: '展开下单面板', exact: true }).click()
  await page.getByRole('button', { name: '专注看图', exact: true }).click()
  await expect(order).toBeHidden()
  await expect(page.getByRole('button', { name: '展开底部状态', exact: true })).toBeHidden()
  await page.getByRole('button', { name: '退出专注', exact: true }).click()
  await page.getByRole('button', { name: '展开底部状态', exact: true }).click()
  await expect(order.getByLabel('保证金金额', { exact: true })).toHaveValue('100')
  await page.screenshot({ path: test.info().outputPath('desktop-workspace.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '下单', exact: true }).click()
  await expect(order.getByLabel('保证金金额', { exact: true })).toHaveValue('100')
  await page.getByRole('button', { name: '收起下单面板' }).click()
  await page.getByRole('button', { name: /^持仓/ }).last().click()
  await expect(long).toBeVisible()
  await expect(short).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('mobile-positions.png'), fullPage: true })
  await short.getByRole('button', { name: '止盈止损' }).click()
  const shortRisk = page.getByRole('dialog', { name: '空仓 · 止盈止损' })
  await shortRisk.getByLabel('止损价格').fill('70000')
  await shortRisk.getByRole('button', { name: '设置止损' }).click()
  await shortRisk.getByRole('button', { name: '完成' }).click()
  await expect(short).toContainText('— / 70000')
  await short.getByRole('button', { name: '减仓 / 平仓' }).click()
  const reduce = page.getByRole('dialog', { name: '空仓 · 减仓和平仓' })
  await reduce.getByRole('button', { name: '减 25%' }).click()
  await reduce.getByRole('button', { name: '全部平仓' }).click()
  await expect(short).toHaveCount(0)
  await expect(long).toContainText('70000 / 50000')
  await page.getByRole('button', { name: '收起持仓面板' }).click()
  await page.getByRole('button', { name: '图表尺寸', exact: true }).click()
  const dimensions = page.getByRole('dialog', { name: '图表尺寸设置' })
  const paneSlider = dimensions.locator('input[type=range]').nth(1)
  await paneSlider.fill('140')
  await dimensions.getByRole('button', { name: '关闭图表尺寸设置' }).click()
  await page.getByRole('separator', { name: '图表高度', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  await page.screenshot({ path: test.info().outputPath('mobile-chart.png'), fullPage: true })
  for (const viewport of [{ width: 844, height: 390 }, { width: 320, height: 740 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width)
    await expect(page.getByRole('button', { name: '工作区', exact: true })).toBeVisible()
  }
  expect(await originalChart!.evaluate(node => node === document.querySelector('[data-testid="chart-host"]'))).toBe(true)
  await page.reload()
  await expect(long).toContainText('70000 / 50000')
  await page.getByRole('button', { name: '实时行情', exact: true }).click()
  await expect(page.getByTestId('live-status')).toContainText('只读模式')
  await page.getByRole('button', { name: '历史模拟', exact: true }).click()
  await expect(long).toContainText('70000 / 50000')
  expect(errors).toEqual([])
})

async function selectChartPeriod(page: import('@playwright/test').Page, value: string) {
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: `选择周期 ${value}`, exact: true }).click()
}

async function jumpChart(page: import('@playwright/test').Page, value: string) {
  await page.getByRole('button', { name: '时间定位', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图表时间定位', exact: true })
  await dialog.getByLabel('图表跳转时间').fill(value)
  await dialog.getByRole('button', { name: '跳转', exact: true }).click()
  // Cold jumps commit a complete minute month. The persistent viewport time is
  // the completion signal; background upload warnings can replace footer text.
  const start = page.locator('.replay-start-time')
  if (await start.count()) {
    const period = (await page.getByRole('button', { name: '图表周期', exact: true }).innerText()).trim().split(/\s/)[0]
    const timestamp = await page.evaluate(value => new Date(value).getTime(), value)
    const expected = await page.evaluate(time => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(time), alignOpenTime(timestamp, period, 'floor'))
    await expect(start).toHaveText(`起点：${expected}`, { timeout: 60_000 })
  } else {
    await expect(page.locator('.status-footer')).toContainText('图表已跳转到', { timeout: 60_000 })
  }
}

async function setReplayEnd(page: import('@playwright/test').Page, value: string) {
  await page.getByRole('button', { name: '回放设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '回放会话设置', exact: true })
  await expect(dialog.getByLabel('回放结束时间')).toHaveValue('')
  await dialog.getByLabel('回放结束时间').fill(value)
  await dialog.getByRole('button', { name: '应用设置', exact: true }).click()
}

async function showTradingPanel(page: import('@playwright/test').Page, panel: 'order' | 'dock') {
  const entry = page.getByRole('button', { name: panel === 'order' ? '下单' : /^持仓 \(/, exact: panel === 'order' }).last()
  if (await entry.isVisible()) {
    if (await entry.getAttribute('aria-expanded') !== 'true') await entry.click()
  } else {
    const expand = page.getByRole('button', { name: panel === 'order' ? '展开下单面板' : '展开持仓面板', exact: true })
    if (await expand.isVisible()) await expand.click()
  }
}

async function setWorkspacePanel(page: import('@playwright/test').Page, label: string, visible: boolean) {
  await page.getByRole('button', { name: '工作区', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '工作区面板', exact: true })
  await settings.getByLabel(label, { exact: true }).setChecked(visible)
  await settings.getByRole('button', { name: '关闭工作区面板' }).click()
}

async function expectTradeCount(page: import('@playwright/test').Page, count: string) {
  await showTradingPanel(page, 'dock')
  await page.getByRole('tab', { name: '复盘统计', exact: true }).click()
  await expect(page.getByRole('tabpanel').getByText('成交次数', { exact: true }).locator('..').locator('dd')).toHaveText(count)
  await page.getByRole('tab', { name: /^持仓/ }).click()
}

async function openPositionEditor(page: import('@playwright/test').Page, side: 'long' | 'short', kind: 'risk' | 'reduce') {
  await showTradingPanel(page, 'dock')
  await page.getByRole('tab', { name: /^持仓/ }).click()
  await page.getByTestId(`position-${side}`).getByRole('button', { name: kind === 'risk' ? '止盈止损' : '减仓 / 平仓', exact: true }).click()
  return page.getByRole('dialog', { name: `${side === 'long' ? '多仓' : '空仓'} · ${kind === 'risk' ? '止盈止损' : '减仓和平仓'}`, exact: true })
}

async function waitForChartRender(page: import('@playwright/test').Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

const intervalMilliseconds: Record<string, number> = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 3_600_000,
  '2h': 2 * 3_600_000,
  '4h': 4 * 3_600_000,
  '6h': 6 * 3_600_000,
  '8h': 8 * 3_600_000,
  '12h': 12 * 3_600_000,
  '1d': 86_400_000,
  '3d': 3 * 86_400_000,
  '1w': 7 * 86_400_000,
  '1M': 30 * 86_400_000,
}

async function mockBinance(page: import('@playwright/test').Page, pacedClock = false, symbolPrices: Record<string, number> = {}, options: { trend?: boolean; now?: number } = {}) {
  if (pacedClock) await page.clock.install()
  const archives = await installArchiveFixtures(page, symbolPrices, options)
  const liveSockets: Array<{ sendPrice(price: string, eventAt?: number): void; streams: Set<string> }> = []
  await page.routeWebSocket('wss://fstream.binance.com/**', (socket) => {
    const url = new URL(socket.url())
    expect(url.pathname).toBe('/market/stream')
    const streams = new Set((url.searchParams.get('streams') ?? '').split('/'))
    expect([...streams].every(stream => stream.includes('@kline_'))).toBe(true)
    let latestPrice = '60005'
    const sendPrice = (price: string, eventAt?: number) => {
      latestPrice = price
      const eventTime = eventAt ?? options.now ?? Date.now()
      for (const stream of streams) {
        const [symbolText, type] = stream.split('@')
        const symbol = symbolText.toUpperCase()
        const timeframe = type.replace('kline_', '')
        const openTime = alignOpenTime(eventTime, timeframe, 'floor')
        socket.send(JSON.stringify({ stream, data: {
          e: 'kline', E: eventTime, s: symbol, k: {
            t: openTime, T: nextOpenTime(openTime, timeframe) - 1,
            s: symbol, i: timeframe, o: '60000', h: String(Math.max(60020, Number(price))),
            l: '59980', c: price, v: '12', q: '720060', n: 18, x: false,
          },
        } }))
      }
    }
    liveSockets.push({ sendPrice, streams })
    socket.onMessage((message) => {
      const { method, params, id } = JSON.parse(String(message)) as { method: string; params: string[]; id: string }
      for (const stream of params) {
        expect(stream).toContain('@kline_')
        if (method === 'SUBSCRIBE') streams.add(stream)
        else if (method === 'UNSUBSCRIBE') streams.delete(stream)
      }
      socket.send(JSON.stringify({ result: null, id }))
      // A delayed subscription reply must not overwrite a newer simulated trade.
      if (method === 'SUBSCRIBE') setTimeout(() => sendPrice(latestPrice), 100)
    })
    setTimeout(() => sendPrice(latestPrice), 100)
  })
  await page.route('https://fapi.binance.com/**', async (route) => {
    // Exercise the real guard limits while advancing time between mock replies.
    if (pacedClock) await page.clock.fastForward(7_000)
    const url = new URL(route.request().url())
    if (url.pathname === '/fapi/v1/exchangeInfo') {
      await route.fulfill({
        json: {
          symbols: [
            {
              symbol: 'BTCUSDT',
              baseAsset: 'BTC',
              quoteAsset: 'USDT',
              contractType: 'PERPETUAL',
              status: 'TRADING',
              onboardDate: 1_569_974_400_000,
              pricePrecision: 2,
              quantityPrecision: 3,
            },
            {
              symbol: 'ETHUSDT',
              baseAsset: 'ETH',
              quoteAsset: 'USDT',
              contractType: 'PERPETUAL',
              status: 'TRADING',
              onboardDate: 1_569_974_400_000,
              pricePrecision: 2,
              quantityPrecision: 3,
            },
          ],
        },
      })
      return
    }
    expect(url.pathname).not.toContain('markPrice')
    if (url.pathname === '/fapi/v1/klines') {
      const timeframe = url.searchParams.get('interval') ?? '15m'
      const interval = intervalMilliseconds[timeframe] ?? 15 * 60_000
      const start = Number(url.searchParams.get('startTime'))
      const end = Number(url.searchParams.get('endTime'))
      const limit = Number(url.searchParams.get('limit') ?? 500)
      const rows: unknown[][] = []
      const priceScale = (symbolPrices[url.searchParams.get('symbol') ?? ''] ?? 60_000) / 60_000
      for (
        let openTime = alignOpenTime(start, timeframe, 'ceil');
        openTime <= end && rows.length < limit;
        openTime = nextOpenTime(openTime, timeframe)
      ) {
        const offset = (openTime / interval) % 200
        const open = (60_000 + offset) * priceScale
        const close = open + Math.sin(offset) * 20 * priceScale
        const prices = options.trend
          ? fixtureMinutePrices(openTime, { price: symbolPrices[url.searchParams.get('symbol') ?? ''], trend: true })
          : [open.toFixed(2), (Math.max(open, close) + 12 * priceScale).toFixed(2),
              (Math.min(open, close) - 12 * priceScale).toFixed(2), close.toFixed(2)]
        rows.push([
          openTime,
          ...prices,
          '100.5',
          nextOpenTime(openTime, timeframe) - 1,
          '6030000',
          100,
          '0',
          '0',
          '0',
        ])
      }
      await route.fulfill({ json: rows })
      return
    }
    await route.abort('failed')
  })
  return { liveSockets, archiveRequests: archives.requests }
}

interface MockGitHubFile {
  bytes: Buffer
  sha: string
}

async function mockGitHub(page: import('@playwright/test').Page, shared = false) {
  const repoPath = shared ? '/repos/q761505855/personal-cloud-storage' : '/repos/alice/trading-backup'
  const files = new Map<string, MockGitHubFile>()
  const trees = new Map<string, Map<string, MockGitHubFile>>([['tree-0', new Map()]])
  const commits = new Map<string, { tree: string; parent?: string }>([['commit-0', { tree: 'tree-0' }]])
  const blobs = new Map<string, Buffer>()
  let head = 'commit-0'
  let sequence = 0
  await page.route('https://api.github.com/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const suffix = url.pathname.slice(repoPath.length)
    if (url.pathname.startsWith(`${repoPath}/`) && suffix.startsWith('/git/')) {
      if (request.method() === 'GET' && suffix === '/git/ref/heads/main') {
        await route.fulfill({ json: { object: { sha: head } } })
        return
      }
      if (request.method() === 'GET' && suffix.startsWith('/git/commits/')) {
        const commit = commits.get(suffix.split('/').at(-1)!)
        await route.fulfill({ status: commit ? 200 : 404, json: commit ? { tree: { sha: commit.tree } } : {} })
        return
      }
      if (request.method() === 'POST' && suffix === '/git/blobs') {
        const bytes = Buffer.from(request.postDataJSON().content, 'base64')
        const sha = `blob-${++sequence}`
        blobs.set(sha, bytes)
        await route.fulfill({ json: { sha } })
        return
      }
      if (request.method() === 'POST' && suffix === '/git/trees') {
        const body = request.postDataJSON()
        const next = new Map(trees.get(body.base_tree))
        for (const entry of body.tree) next.set(entry.path, { bytes: blobs.get(entry.sha)!, sha: entry.sha })
        const sha = `tree-${++sequence}`
        trees.set(sha, next)
        await route.fulfill({ json: { sha } })
        return
      }
      if (request.method() === 'POST' && suffix === '/git/commits') {
        const body = request.postDataJSON()
        const sha = `commit-${++sequence}`
        commits.set(sha, { tree: body.tree, parent: body.parents[0] })
        await route.fulfill({ json: { sha } })
        return
      }
      if (request.method() === 'PATCH' && suffix === '/git/refs/heads/main') {
        const body = request.postDataJSON()
        const commit = commits.get(body.sha)
        if (body.force !== false || commit?.parent !== head) {
          await route.fulfill({ status: 422, json: { message: 'Conflict' } })
          return
        }
        head = body.sha
        files.clear()
        for (const [path, file] of trees.get(commit.tree)!) files.set(path, file)
        await route.fulfill({ json: { object: { sha: head } } })
        return
      }
    }
    if (
      request.method() === 'GET' &&
      url.pathname === repoPath
    ) {
      await route.fulfill({
        json: {
          full_name: 'alice/trading-backup',
          private: true,
          default_branch: 'main',
          permissions: { push: true },
        },
      })
      return
    }
    const match = url.pathname.startsWith(`${repoPath}/contents/`) ? [url.pathname, url.pathname.slice(`${repoPath}/contents/`.length)] : null
    if (match === null) {
      await route.fulfill({ status: 404, json: { message: 'Not Found' } })
      return
    }
    const path = match[1]
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
    if (request.method() === 'GET') {
      const ref = url.searchParams.get('ref')
      const snapshot = ref && ref !== 'main' ? trees.get(commits.get(ref)?.tree ?? '') : files
      const file = snapshot?.get(path)
      if (file === undefined) {
        await route.fulfill({
          status: 404,
          json: { message: 'Not Found' },
        })
        return
      }
      if (request.headers().accept?.includes('raw+json')) {
        await route.fulfill({ body: file.bytes })
        return
      }
      await route.fulfill({
        json: {
          type: 'file',
          path,
          sha: file.sha,
          size: file.bytes.length,
          encoding: 'base64',
          content: file.bytes.toString('base64'),
        },
      })
      return
    }
    if (request.method() === 'PUT') {
      const body = request.postDataJSON() as {
        content: string
        sha?: string
      }
      const current = files.get(path)
      if (
        (current !== undefined && body.sha !== current.sha) ||
        (current === undefined && body.sha !== undefined)
      ) {
        await route.fulfill({
          status: 409,
          json: { message: 'Conflict' },
        })
        return
      }
      const sha = `sha-${++sequence}`
      files.set(path, {
        bytes: Buffer.from(body.content, 'base64'),
        sha,
      })
      const tree = `tree-${++sequence}`
      trees.set(tree, new Map(files))
      const nextHead = `commit-${++sequence}`
      commits.set(nextHead, { tree, parent: head })
      head = nextHead
      await route.fulfill({ json: { content: { sha } } })
      return
    }
    await route.fulfill({ status: 405 })
  })
  return { files }
}

async function expectCanvasContent(page: import('@playwright/test').Page) {
  const canvases = page.getByTestId('chart-host').locator('canvas')
  await expect.poll(() => canvases.count()).toBeGreaterThan(0)
  // Grid pixels appear before archive validation and IndexedDB writes finish.
  await expect(page.locator('.klinecharts-pro-content > .klinecharts-pro-loading')).toBeHidden({ timeout: 60_000 })
  await expect
    .poll(() =>
      canvases.evaluateAll((elements) =>
        elements.some((element) => {
          const canvas = element as HTMLCanvasElement
          const context = canvas.getContext('2d')
          if (!context || canvas.width === 0 || canvas.height === 0) return false
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
          for (let index = 3; index < pixels.length; index += 4) {
            if (pixels[index] !== 0) return true
          }
          return false
        }),
      ),
    )
    .toBe(true)
}

test.describe('mobile workstation', () => {
  test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2 })

  test('fits the mobile chart viewport and adjusts indicator heights without archiving responsive shrinkage', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockBinance(page, true)
    await page.addInitScript(() => {
      if (localStorage.getItem('chart.indicators.v1') !== null) return
      localStorage.setItem('chart.indicators.v1', JSON.stringify({
        schemaVersion: 1,
        main: [{ name: 'MA', calcParams: [5, 10, 30, 60], visible: true, styles: null }],
        sub: [
          { height: 80, indicators: [{ name: 'VOL', calcParams: [5, 10, 20], visible: true, styles: null }] },
          { height: 280, indicators: [{ name: 'MACD', calcParams: [12, 26, 9], visible: true, styles: null }] },
        ],
      }))
    })
    await page.goto('./')
    const host = page.getByTestId('chart-host')
    const originalHost = await host.elementHandle()
    const panes = page.locator('[k-line-chart-id] > div > div').filter({ has: page.locator('canvas') })
    const heights = () => panes.evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().height)))
    const savedHeights = () => page.evaluate(() => JSON.parse(localStorage.getItem('chart.indicators.v1')!).sub.map((pane: { height: number }) => pane.height))
    await expectCanvasContent(page)
    await expect.poll(async () => (await heights())[0]).toBeGreaterThanOrEqual(180)
    expect((await host.boundingBox())!.height).toBeLessThan(844)
    expect((await heights()).slice(1, -1).every(height => height > 0)).toBe(true)
    await page.clock.runFor(500)
    expect(await savedHeights()).toEqual([80, 280])
    await page.screenshot({ path: 'test-results/mobile-fixed-chart.png', fullPage: true })
    const beforeAdd = (await host.boundingBox())!.height
    await page.getByText('指标', { exact: true }).locator('..').tap()
    await page.locator('.klinecharts-pro-indicator-modal-list li.row').filter({ hasText: /^RSI/ }).tap()
    await page.locator('.klinecharts-pro-modal .close-icon').tap()
    await page.clock.runFor(500)
    await expect(panes).toHaveCount(5)
    expect((await host.boundingBox())!.height).toBe(beforeAdd)
    expect((await heights())[0]).toBeGreaterThanOrEqual(180)
    expect((await heights()).slice(1, -1).every(height => height > 0)).toBe(true)
    await page.getByRole('button', { name: '图表尺寸', exact: true }).tap()
    const sizes = page.getByRole('dialog', { name: '图表尺寸设置' })
    await sizes.getByLabel('VOL 高度', { exact: true }).fill('140')
    await sizes.getByRole('button', { name: '关闭图表尺寸设置' }).tap()
    await expect.poll(savedHeights).toEqual([140, 280, 100])

    await page.setViewportSize({ width: 1280, height: 1000 })
    await page.clock.runFor(500)
    expect((await heights())[0]).toBeGreaterThanOrEqual(180)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.clock.runFor(500)
    await expect.poll(async () => (await heights())[0]).toBeGreaterThanOrEqual(180)
    expect(await savedHeights()).toEqual([140, 280, 100])
    expect(await originalHost!.evaluate((node) => node === document.querySelector('[data-testid="chart-host"]'))).toBe(true)
    await page.reload()
    await expect.poll(async () => (await heights())[0]).toBeGreaterThanOrEqual(180)
    expect(await savedHeights()).toEqual([140, 280, 100])
    await jumpChart(page, '2026-07-22T00:00')
    expect(await page.evaluate(() => scrollX)).toBe(0)
  })

  test('keeps touch navigation and header reachable halfway down a manually enlarged chart', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockBinance(page, true)
    await page.goto('./')
    await expectCanvasContent(page)
    await page.getByRole('button', { name: '图表尺寸', exact: true }).tap()
    const sizes = page.getByRole('dialog', { name: '图表尺寸设置' })
    await sizes.getByLabel('图表区域高度', { exact: true }).fill('1600')
    await sizes.getByRole('button', { name: '关闭图表尺寸设置' }).tap()
    await expect(page.getByRole('region', { name: '行情图表' })).toHaveCSS('height', '1600px')
    await page.evaluate(() => scrollTo(0, 600))
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(400)
    const navigation = page.getByRole('navigation', { name: '工作台快捷操作' })
    const expectInViewport = async (locator: import('@playwright/test').Locator) => {
      const bounds = (await locator.boundingBox())!
      expect(bounds.y).toBeGreaterThanOrEqual(0)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(844)
    }
    await expectInViewport(navigation)
    await expectInViewport(page.getByRole('button', { name: '工作区', exact: true }))
    await navigation.getByRole('button', { name: '下单', exact: true }).tap()
    await expect(page.getByRole('complementary', { name: '模拟下单面板' })).toBeVisible()
    await page.getByRole('button', { name: '收起下单面板' }).tap()
    await expectInViewport(navigation)
    await navigation.getByRole('button', { name: /^持仓/ }).tap()
    await expect(page.getByRole('region', { name: '持仓与复盘面板' })).toBeVisible()
    await page.getByRole('button', { name: '收起持仓面板' }).tap()
    await navigation.getByRole('button', { name: '更多', exact: true }).tap()
    await expect(page.getByRole('dialog', { name: '工作区面板' })).toBeVisible()
    await page.getByRole('button', { name: '关闭工作区面板' }).tap()
    await expectInViewport(page.getByRole('button', { name: '图表尺寸', exact: true }))
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  })

  for (const width of [320, 390, 768]) {
    test(`fits ${width}px screens and keeps chart tools and dialogs reachable`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      await mockBinance(page, true)
      await page.goto('./')
      await expectCanvasContent(page)
      const assertNoOverflow = async () => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
      }
      const assertFits = async (locator: import('@playwright/test').Locator) => {
        const box = await locator.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      }
      await assertNoOverflow()
      const host = page.getByTestId('chart-host')
      expect((await host.boundingBox())!.width).toBeLessThanOrEqual(width)
      const controls = page.getByTestId('replay-controls')
      expect((await controls.boundingBox())!.y).toBeGreaterThanOrEqual(
        (await host.boundingBox())!.y + (await host.boundingBox())!.height,
      )
      await controls.getByRole('button', { name: '回放设置', exact: true }).tap()
      await page.getByText('交易参数', { exact: true }).click()
      await assertFits(page.getByLabel('维持保证金率', { exact: true }))
      await assertNoOverflow()
      await page.getByRole('dialog', { name: '回放会话设置' }).getByRole('button', { name: '应用设置' }).tap()

      await selectChartPeriod(page, '1h')
      await expect(page.getByLabel('图表周期')).toContainText('1h')
      await page.locator('.klinecharts-pro-period-bar .symbol').tap()
      const picker = page.getByTestId('symbol-picker')
      await assertFits(picker)
      await picker.getByRole('tab', { name: '全部' }).tap()
      await picker.getByRole('button', { name: '选择 ETHUSDT' }).tap()
      await expect(page.locator('.klinecharts-pro-period-bar .symbol')).toHaveText('ETHUSDT')

      for (const tool of ['指标', '设置']) {
        const button = page.getByText(tool, { exact: true }).locator('..')
        await assertFits(button)
        await button.tap()
        const dialog = page.locator('.klinecharts-pro-modal .inner')
        await expect(dialog).toBeVisible()
        await assertFits(dialog)
        expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
        await page.locator('.klinecharts-pro-modal .close-icon').tap()
      }

      await page.getByTestId('open-data-manager').tap()
      const drawer = page.getByTestId('data-manager')
      await assertFits(drawer)
      expect(await drawer.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await drawer.getByRole('button', { name: '关闭' }).tap()
      await assertNoOverflow()
      await page.screenshot({ path: `test-results/mobile-${width}.png`, fullPage: true })
    })
  }

  test('creates and advances a replay, trades, and preserves input across rotation', async ({ page }) => {
    // Cold chart history and the historical jump persist canonical ordinary minutes.
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 390, height: 844 })
    await mockBinance(page, true)
    await page.goto('./')
    await expectCanvasContent(page)
    const originalHost = await page.getByTestId('chart-host').elementHandle()
    const controls = page.getByTestId('replay-controls')
    await jumpChart(page, '2026-07-22T00:00')
    await expect(controls.getByText(/起点：/)).toContainText('2026/7/22')
    await setReplayEnd(page, '2026-07-22T05:00')
    await controls.getByRole('button', { name: '创建回放' }).tap()
    const panel = page.getByTestId('simulation-panel')
    await showTradingPanel(page, 'order')
    await panel.getByLabel('保证金金额', { exact: true }).fill('123')
    const orderEntry = page.getByRole('navigation', { name: '工作台快捷操作' }).getByRole('button', { name: '下单', exact: true })
    await expect(orderEntry).toHaveAttribute('aria-expanded', 'true', { timeout: 2500 })
    await orderEntry.tap()
    await expect(orderEntry).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('complementary', { name: '模拟下单面板' })).toBeHidden()
    await orderEntry.tap()
    await expect(orderEntry).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.getByLabel('保证金金额', { exact: true })).toHaveValue('123')
    await panel.getByRole('button', { name: '开多', exact: true }).tap()
    await page.getByRole('button', { name: '收起下单面板' }).tap()
    await showTradingPanel(page, 'dock')
    await expect(panel.getByTestId('position-summary')).toContainText('多仓')
    const dockEntry = page.getByRole('navigation', { name: '工作台快捷操作' }).getByRole('button', { name: /^持仓/ })
    await expect(dockEntry).toHaveAttribute('aria-expanded', 'true')
    await dockEntry.tap()
    await expect(dockEntry).toHaveAttribute('aria-expanded', 'false')
    await expect(panel.getByTestId('position-summary')).toBeHidden()
    await dockEntry.tap()
    await expect(dockEntry).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.getByTestId('position-summary')).toContainText('多仓')
    await page.getByRole('button', { name: '收起持仓面板' }).tap()
    await controls.getByRole('button', { name: '下一根', exact: true }).tap()
    await expect(controls.locator('.replay-position')).toContainText('2/')
    for (const viewport of [{ width: 844, height: 390 }, { width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await page.clock.runFor(50)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width)
      await showTradingPanel(page, 'order')
      await expect(panel.getByLabel('保证金金额', { exact: true })).toHaveValue('123')
      if (viewport.width < 1024) {
        await page.getByRole('button', { name: '收起下单面板' }).tap()
        await showTradingPanel(page, 'dock')
      }
      await expect(panel.getByTestId('position-summary')).toContainText('多仓')
      if (viewport.width < 1024) await page.getByRole('button', { name: '收起持仓面板' }).tap()
    }
    expect(await originalHost!.evaluate((node) => node === document.querySelector('[data-testid="chart-host"]'))).toBe(true)
    await page.getByRole('button', { name: '专注看图' }).tap()
    await expect(page.getByRole('complementary', { name: '模拟下单面板' })).toBeHidden()
    await page.getByRole('button', { name: '退出专注' }).tap()
    await showTradingPanel(page, 'order')
    await expect(panel.getByLabel('保证金金额', { exact: true })).toHaveValue('123')
    await page.getByRole('button', { name: '收起下单面板' }).tap()
    await page.screenshot({ path: test.info().outputPath('mobile-workspace.png'), fullPage: true })
    await page.getByRole('button', { name: '实时行情' }).tap()
    await page.getByRole('button', { name: '行情状态', exact: true }).tap()
    await expect(page.getByTestId('live-status')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  })

  test('pins shortcuts in the dropdown and preserves them after reload', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 })
    await mockBinance(page, true)
    await page.goto('./')
    const trigger = page.getByRole('button', { name: '图表周期', exact: true })
    await trigger.tap()
    const menu = page.getByRole('dialog', { name: '选择图表周期' })
    await menu.getByRole('button', { name: '固定周期 1d', exact: true }).tap()
    await menu.getByRole('button', { name: '取消固定周期 5m', exact: true }).tap()
    await expect(trigger).toContainText('15m')
    await expect(menu).toBeVisible()
    await trigger.tap()
    const shortcuts = page.getByRole('group', { name: '快捷周期' })
    await expect(shortcuts.getByRole('button')).toHaveText(['15m', '1h', '4h', '1d'])
    await shortcuts.getByRole('button', { name: '快捷周期 1d', exact: true }).tap()
    await expect(trigger).toContainText('1d')
    await page.reload()
    await expect(shortcuts.getByRole('button')).toHaveText(['15m', '1h', '4h', '1d'])
    await page.screenshot({ path: 'test-results/mobile-shortcuts.png', fullPage: true })
  })

  test('keeps mobile workspace navigation and horizontal gestures inside the shortcut strip', async ({ page, context }) => {
    await page.setViewportSize({ width: 320, height: 844 })
    await mockBinance(page, true)
    await page.addInitScript(() => {
      localStorage.setItem('chart.pinnedPeriods.v1', JSON.stringify(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']))
    })
    await page.goto('./')
    const host = page.getByTestId('chart-host')
    const originalHost = await host.elementHandle()
    await page.getByRole('button', { name: '工作区', exact: true }).tap()
    const settings = page.getByRole('dialog', { name: '工作区面板' })
    await settings.getByLabel('回放控制', { exact: true }).uncheck()
    await settings.getByRole('button', { name: '关闭工作区面板' }).tap()
    await expect(page.getByTestId('replay-controls')).toBeHidden()
    await expect(page.getByTestId('open-data-manager')).toBeVisible()
    await page.getByRole('button', { name: '历史模拟', exact: true }).tap()
    const strip = page.getByRole('group', { name: '快捷周期' })
    expect(await strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    const bounds = (await strip.boundingBox())!
    const client = await context.newCDPSession(page)
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + bounds.width - 10, y: bounds.y + bounds.height / 2, id: 0 }] })
    for (let step = 1; step <= 8; step++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bounds.x + bounds.width - 10 - step * 20, y: bounds.y + bounds.height / 2, id: 0 }] })
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(40)
    expect(await page.evaluate(() => ({ x: scrollX, width: document.documentElement.scrollWidth }))).toEqual({ x: 0, width: 320 })
    await expect(page.getByRole('button', { name: '图表周期', exact: true })).toContainText('15m')
    await page.screenshot({ path: 'test-results/mobile-collapsed.png', fullPage: true })
    expect(await originalHost!.evaluate((node) => node === document.querySelector('[data-testid="chart-host"]'))).toBe(true)
  })

  test('handles real axis swipes, pinch and cancellation while keeping the fixed mobile viewport stable', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockBinance(page)
    const { axis, pricePerPixel, readTimeTicks } = await trackPriceAxis(page)
    await page.goto('./')
    await expectCanvasContent(page)
    await expect.poll(pricePerPixel).toBeGreaterThan(0)
    await page.getByRole('button', { name: '自动', exact: true }).tap()
    await page.evaluate(() => scrollTo(0, 0))
    await waitForChartRender(page)
    const client = await context.newCDPSession(page)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: { x: number; y: number; id: number }[]) =>
      client.send('Input.dispatchTouchEvent', { type, touchPoints: points })
    const bounds = (await axis.boundingBox())!
    const x = bounds.x + bounds.width / 2
    const y = bounds.y + bounds.height / 2
    const initial = await pricePerPixel()
    const times = await readTimeTicks()
    const initialScroll = await page.evaluate(() => scrollY)
    await touch('touchStart', [{ x, y, id: 0 }])
    // Drift into the plot: the gesture must stay attached to its starting axis.
    for (let step = 1; step <= 8; step++) {
      await touch('touchMove', [{ x: x - step * 6, y: y + step * 6, id: 0 }])
    }
    await touch('touchEnd', [])
    await expect.poll(pricePerPixel).toBeGreaterThan(initial * 1.1)
    await expect(page.getByRole('button', { name: '手动', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => scrollY)).toBe(initialScroll)
    expect(await readTimeTicks()).toEqual(times)

    const beforePinch = await pricePerPixel()
    await touch('touchStart', [{ x, y: y - 20, id: 0 }, { x, y: y + 20, id: 1 }])
    for (let step = 1; step <= 5; step++) {
      await touch('touchMove', [{ x, y: y - 20 - step * 3, id: 0 }, { x, y: y + 20 + step * 3, id: 1 }])
    }
    await touch('touchEnd', [])
    await expect.poll(pricePerPixel).toBeLessThan(beforePinch * 0.8)
    expect(await readTimeTicks()).toEqual(times)

    await touch('touchStart', [{ x, y, id: 0 }])
    await touch('touchCancel', [])
    const beforeNextDrag = await pricePerPixel()
    await touch('touchStart', [{ x, y, id: 0 }])
    await touch('touchMove', [{ x, y: y - 40, id: 0 }])
    await touch('touchEnd', [])
    await expect.poll(pricePerPixel).toBeLessThan(beforeNextDrag * 0.9)
    await page.touchscreen.tap(x, y)
    await page.touchscreen.tap(x, y)
    await expect(page.getByRole('button', { name: '自动', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(pricePerPixel).toBeCloseTo(initial, 4)
    await page.getByRole('button', { name: '自动', exact: true }).tap()
    await expect.poll(pricePerPixel).toBeCloseTo(initial, 4)
    // Reset the scroll position before checking plot gestures independently.
    await page.evaluate((top) => scrollTo(0, top), initialScroll)

    await touch('touchStart', [{ x: 120, y, id: 0 }, { x: 180, y, id: 1 }])
    for (let step = 1; step <= 5; step++) {
      await touch('touchMove', [{ x: 120 - step * 6, y, id: 0 }, { x: 180 + step * 6, y, id: 1 }])
    }
    await touch('touchEnd', [])
    await expect.poll(readTimeTicks).not.toEqual(times)
    expect(await page.evaluate(() => scrollY)).toBe(initialScroll)

    const beforeSwipe = await readTimeTicks()
    await touch('touchStart', [{ x: 120, y, id: 0 }])
    for (let step = 1; step <= 8; step++) {
      await touch('touchMove', [{ x: 120 + step * 10, y, id: 0 }])
    }
    await touch('touchEnd', [])
    await expect.poll(readTimeTicks).not.toEqual(beforeSwipe)
    expect(await page.evaluate(() => scrollY)).toBe(initialScroll)
    expect(await page.evaluate(() => scrollX)).toBe(0)

    // The automatic chart fits this viewport, so vertical swipes must not shift it.
    await touch('touchStart', [{ x: 150, y, id: 0 }])
    for (let step = 1; step <= 8; step++) {
      await touch('touchMove', [{ x: 150, y: y - step * 10, id: 0 }])
    }
    await touch('touchEnd', [])
    expect(await page.evaluate(() => scrollY)).toBe(initialScroll)
  })
})

test('round-trips pinned periods through JSON archives and cloud configuration', async ({ page }) => {
  await mockBinance(page, true)
  const github = await mockGitHub(page)
  await page.goto('./')
  await expectCanvasContent(page)
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  const menu = page.getByRole('dialog', { name: '选择图表周期' })
  await menu.getByRole('button', { name: '固定周期 1d', exact: true }).click()
  await menu.getByRole('button', { name: '取消固定周期 5m', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByTestId('open-data-manager').click()
  const panel = page.getByTestId('backup-sync-panel')
  const downloadEvent = page.waitForEvent('download')
  await panel.getByRole('button', { name: '导出应用配置', exact: true }).click()
  const download = await downloadEvent
  const stream = await download.createReadStream()
  let json = ''
  for await (const chunk of stream) json += chunk.toString()
  const archive = JSON.parse(json)
  expect(archive.data.preferences.pinnedPeriods).toEqual(['15m', '1h', '4h', '1d'])

  archive.data.preferences.pinnedPeriods = []
  page.once('dialog', (dialog) => dialog.accept())
  await panel.getByTestId('import-backup-file').setInputFiles({ name: 'preferences.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) })
  await expect(panel.getByTestId('backup-status')).toContainText('导入完成')
  await page.reload()
  const shortcuts = page.getByRole('group', { name: '快捷周期' })
  await expect(shortcuts.getByRole('button')).toHaveCount(0)

  await page.getByTestId('open-data-manager').click()
  await panel.getByTestId('github-owner').fill('alice')
  await panel.getByTestId('github-repository').fill('trading-backup')
  await panel.getByTestId('github-token').fill('github_pat_e2e_secret')
  await panel.getByRole('checkbox', { name: '会话与交易', exact: true }).uncheck()
  await panel.getByRole('checkbox', { name: '历史行情', exact: true }).uncheck()
  await panel.getByTestId('github-upload').click()
  await expect(panel.getByTestId('backup-status')).toContainText('上传完成')
  expect([...github.files.keys()].sort()).toEqual(['config/favorites.json', 'config/preferences.json', 'manifest.json'])
  expect(JSON.parse(github.files.get('config/preferences.json')!.bytes.toString()).pinnedPeriods).toEqual([])

  await page.getByTestId('close-data-manager').click()
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await menu.getByRole('button', { name: '固定周期 1d', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(shortcuts.getByRole('button')).toHaveText(['1d'])
  await page.getByTestId('open-data-manager').click()
  // Closing the drawer discards in-memory credentials; re-enter them for this visit.
  await panel.getByTestId('github-owner').fill('alice')
  await panel.getByTestId('github-repository').fill('trading-backup')
  await panel.getByTestId('github-token').fill('github_pat_e2e_secret')
  await panel.getByRole('checkbox', { name: '会话与交易', exact: true }).uncheck()
  await panel.getByRole('checkbox', { name: '历史行情', exact: true }).uncheck()
  await panel.getByTestId('github-compare').click()
  await expect(panel.getByTestId('backup-status')).toContainText('差异 1 个')
  page.once('dialog', (dialog) => dialog.accept())
  await panel.getByTestId('github-pull').click()
  await expect(panel.getByTestId('backup-status')).toContainText('云端恢复完成')
  await page.reload()
  await expect(shortcuts.getByRole('button')).toHaveCount(0)
})

test('preserves the inspected time across periods and locates the latest live candle', async ({ page }) => {
  test.setTimeout(120_000)
  const now = Date.UTC(2025, 10, 1, 0, 15)
  await page.clock.install({ time: now })
  const { liveSockets } = await mockBinance(page, false, {}, { now })
  const inspect = await installViewportProbe(page)
  await page.goto('./')
  await expectCanvasContent(page)
  await selectChartPeriod(page, '1m')
  const controls = page.getByTestId('replay-controls')
  const target = new Date('2025-09-15T12:17').getTime()
  await jumpChart(page, '2025-09-15T12:17')
  await expect.poll(async () => (await inspect()).rightmost).toBe(target).catch(async error => { console.log(JSON.stringify((await inspect()).events)); throw error })
  for (const text of ['1h', '1d', '1w', '1m']) {
    await selectChartPeriod(page, text)
    await expect.poll(async () => (await inspect()).debug.restore).toBeNull().catch(async error => { const state = await inspect(); console.log(JSON.stringify({ ...state, timestamps: undefined })); throw error })
    await expect.poll(async () => (await inspect()).rightmost).toBe(alignOpenTime(target, text, 'floor'))
  }
  await page.getByRole('button', { name: '实时行情', exact: true }).click()
  await expect(page.getByTestId('live-status')).toContainText('已连接')
  const live = liveSockets.at(-1)!
  const browserTime = await page.evaluate(() => Date.now())
  await page.clock.fastForward(60_000 - browserTime % 60_000 + 5_000)
  const liveTime = await page.evaluate(() => Date.now())
  live.sendPrice('60009', liveTime)
  await expect(page.getByTestId('live-status')).toContainText('60009')
  await page.getByRole('button', { name: '定位最新', exact: true }).click()
  await expect.poll(async () => (await inspect()).rightmost).toBe(alignOpenTime(liveTime, '1m', 'floor')).catch(async error => { const state = await inspect(); console.log(JSON.stringify({ ...state, timestamps: undefined, footer: await page.locator('.status-footer').innerText() })); throw error })
  expect((await inspect()).last?.close).toBe(60009)
  await page.screenshot({ path: 'test-results/viewport-live-latest.png' })
})

test('prepares only next month when creating and restoring a long replay and rolls the buffer forward', async ({ page }) => {
  // This case commits several complete minute months through native IndexedDB.
  // Keep the request-window assertions strict while budgeting for disk I/O.
  test.setTimeout(300_000)
  const now = Date.UTC(2026, 10, 1, 0, 15)
  await page.clock.install({ time: now })
  const { archiveRequests } = await mockBinance(page, false, {}, { now })
  const inspect = await installViewportProbe(page)
  await page.goto('./')
  await expectCanvasContent(page)
  await selectChartPeriod(page, '1d')
  await expect(page.locator('.klinecharts-pro-content > .klinecharts-pro-loading')).toBeHidden({ timeout: 60_000 })
  const controls = page.getByTestId('replay-controls')
  await jumpChart(page, '2026-01-31T12:00')
  const start = Date.UTC(2026, 0, 31)
  await expect.poll(async () => (await inspect()).rightmost).toBe(start)
  const beforeCreate = archiveRequests.length
  await expect(controls.getByText(/起点：/)).toContainText('2026/1/31')
  await controls.getByRole('button', { name: '创建回放', exact: true }).click()
  await expect(controls.getByRole('button', { name: '下一根', exact: true })).toBeEnabled({ timeout: 120_000 }).catch(async error => {
    console.log(JSON.stringify({ probe: await inspect(), requests: archiveRequests, controls: await controls.innerText() }))
    throw error
  })
  await expect(controls).toContainText('1/274')
  const createdRequests = archiveRequests.slice(beforeCreate).filter(url => url.endsWith('.zip'))
  expect(createdRequests.some(url => url.includes('2026-02.zip'))).toBe(true)
  const laterThan = (urls: string[], lastMonth: number) => urls.filter(url => {
    const match = /-(\d{4})-(\d{2})\.zip$/.exec(url)
    return match === null || Number(`${match[1]}${match[2]}`) > lastMonth
  })
  // Older months can be requested by chart pagination; no future month beyond February.
  expect(laterThan(createdRequests, 202602)).toEqual([])
  await expect.poll(async () => (await inspect()).last?.timestamp).toBe(start)

  const beforeStep = archiveRequests.length
  await controls.getByRole('button', { name: '下一根', exact: true }).click()
  await expect(controls).toContainText('2/274', { timeout: 120_000 })
  const stepRequests = archiveRequests.slice(beforeStep).filter(url => url.endsWith('.zip'))
  expect(stepRequests.some(url => url.includes('2026-03.zip'))).toBe(true)
  expect(laterThan(stepRequests, 202603)).toEqual([])
  await expect.poll(async () => (await inspect()).last?.timestamp).toBe(Date.UTC(2026, 1, 1))
  const beforeReload = archiveRequests.length
  await page.reload()
  await expect(controls).toContainText('2/274', { timeout: 120_000 })
  await expect(controls.getByRole('button', { name: '下一根', exact: true })).toBeEnabled()
  expect(archiveRequests.slice(beforeReload).filter(url => url.endsWith('.zip'))).toEqual([])
  await expect(controls.getByRole('alert')).toHaveCount(0)
})

test('observes replay across periods without future bars and locates its revealed latest minute', async ({ page }) => {
  test.setTimeout(120_000)
  const now = Date.UTC(2025, 10, 1, 0, 15)
  await page.clock.install({ time: now })
  await mockBinance(page, false, {}, { now })
  const inspect = await installViewportProbe(page)
  await page.goto('./')
  await expectCanvasContent(page)
  const controls = page.getByTestId('replay-controls')
  await jumpChart(page, '2025-09-15T12:15')
  const start = new Date('2025-09-15T12:15').getTime()
  await expect.poll(async () => (await inspect()).rightmost).toBe(start)
  await setReplayEnd(page, '2025-09-15T12:45')
  await controls.getByRole('button', { name: '创建回放', exact: true }).click()
  await expect(controls).toContainText('1/3')
  const boundary = start + 15 * 60_000
  for (const text of ['1h', '1d', '1w', '1M', '1m']) {
    await selectChartPeriod(page, text)
    await expect.poll(async () => (await inspect()).debug.restore).toBeNull().catch(async error => { const state = await inspect(); console.log(JSON.stringify({ ...state, timestamps: undefined })); throw error })
    await expect.poll(async () => (await inspect()).rightmost).toBe(alignOpenTime(start, text, 'floor')).catch(async error => { const state = await inspect(); console.log(JSON.stringify({ ...state, timestamps: undefined, footer: await page.locator('.status-footer').innerText() })); throw error })
    const state = await inspect()
    const last = alignOpenTime(boundary - 1, text, 'floor')
    expect(state.timestamps.every(time => time <= last)).toBe(true)
    expect(state.last?.timestamp).toBe(last)
    expect(state.last?.volume).toBeCloseTo((boundary - last) / 60_000 * 100.5, 5)
    await expect(controls).toContainText('1/3')
  }
  await controls.getByRole('button', { name: '定位最新', exact: true }).click()
  await expect.poll(async () => (await inspect()).rightmost).toBe(boundary - 60_000)
  await expect(controls).toContainText('1/3')
  await controls.getByRole('button', { name: '下一根', exact: true }).click()
  await expect(controls).toContainText('2/3')
  await controls.getByRole('button', { name: '定位最新', exact: true }).click()
  await expect.poll(async () => (await inspect()).rightmost).toBe(boundary + 14 * 60_000)
  await expectTradeCount(page, '0')
  await page.screenshot({ path: 'test-results/viewport-replay-no-future.png' })
})

test('keeps the latest trade price updating through rapid live period changes', async ({ page }) => {
  await page.setViewportSize({ width: 1146, height: 900 })
  const { liveSockets } = await mockBinance(page, true)
  await page.addInitScript(() => {
    const recorded = window as typeof window & { livePriceLabels: string[] }
    recorded.livePriceLabels = []
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      recorded.livePriceLabels.push(text.replace(/,/g, ''))
      if (recorded.livePriceLabels.length > 10_000) recorded.livePriceLabels.splice(0, 5_000)
      original.call(this, text, x, y, maxWidth)
    }
  })
  await page.goto('./')
  await expect(page.locator('.klinecharts-pro-content > .klinecharts-pro-loading')).toBeHidden()
  await page.getByRole('button', { name: '实时行情' }).click()
  const status = page.getByTestId('live-status')
  const lastPrice = status.getByText('最新价格', { exact: true }).locator('..').locator('dd')
  await expect(lastPrice).toHaveText('60005')
  liveSockets[0].sendPrice('60006.25')
  await expect(lastPrice).toHaveText('60006.25')
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { livePriceLabels: string[] }).livePriceLabels.includes('60006.25'),
  )).toBe(true)

  const period = page.getByLabel('图表周期')
  await selectChartPeriod(page, '1m')
  await selectChartPeriod(page, '5m')
  await selectChartPeriod(page, '1h')
  await expect(page.locator('.klinecharts-pro-content > .klinecharts-pro-loading')).toBeHidden()
  await page.clock.runFor(600)
  await expect.poll(() => [...liveSockets[0].streams].sort()).toEqual(['btcusdt@kline_1h'])
  liveSockets[0].sendPrice('60007.75')
  await expect(lastPrice).toHaveText('60007.75')
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { livePriceLabels: string[] }).livePriceLabels.includes('60007.75'),
  )).toBe(true)
  expect(liveSockets).toHaveLength(1)
  const reservations = await page.evaluate(() => JSON.parse(localStorage.getItem('marketData.binanceRequestGuard.v1')!).events as Array<{ kind: string }>)
  expect(reservations.filter((event) => event.kind === 'socket')).toHaveLength(1)
  await expect(status).toContainText('已连接')
  await expect(page.locator('.status-footer')).not.toContainText('切换过于频繁')
})

test('exercises Pro chart interactions and the production path', async ({ page }) => {
  test.setTimeout(360_000)
  const { archiveRequests } = await mockBinance(page, true)
  const github = await mockGitHub(page)
  const notFoundResponses: string[] = []
  const runtimeErrors: string[] = []
  const deprecatedApiWarnings: string[] = []
  page.on('console', (message) => {
    if (message.text().includes('deprecated')) deprecatedApiWarnings.push(message.text())
  })
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (
      response.status() === 404 &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    ) {
      notFoundResponses.push(response.url())
    }
  })
  page.on('pageerror', (error) => runtimeErrors.push(error.message))

  const initialResponse = await page.goto('./')
  expect(initialResponse?.status()).toBe(200)
  expect(notFoundResponses).toEqual([])
  expect(runtimeErrors).toEqual([])
  await expect(
    page.getByRole('heading', { name: '加密货币合约回放工作站' }),
  ).toBeVisible()
  const chartHost = page.getByTestId('chart-host')
  await expect(chartHost).toBeVisible()
  await expect(page.getByText('指标', { exact: true })).toBeVisible()
  await expect(page.getByText('设置', { exact: true })).toBeVisible()
  for (const label of ['时区', '截屏', '全屏']) {
    await expect(page.getByText(label, { exact: true })).toBeHidden()
  }
  await expect(
    page.locator('.klinecharts-pro-period-bar .period.selected'),
  ).toHaveText('15m')
  await expectCanvasContent(page)

  await page.setViewportSize({ width: 1146, height: 900 })
  const compactPeriod = page.getByLabel('图表周期')
  await expect(compactPeriod).toBeVisible()
  await compactPeriod.click()
  await expect(page.getByRole('dialog', { name: '选择图表周期' }).locator('.period-option')).toHaveCount(15)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('group', { name: '快捷周期' }).getByRole('button')).toHaveCount(4)
  await expect(page.locator('.klinecharts-pro-period-bar .period:visible')).toHaveCount(0)
  const compactChartBox = await chartHost.boundingBox()
  const settingsBox = await page
    .getByText('设置', { exact: true })
    .locator('..')
    .boundingBox()
  expect(compactChartBox).not.toBeNull()
  expect(settingsBox).not.toBeNull()
  expect(settingsBox!.x + settingsBox!.width).toBeLessThanOrEqual(
    compactChartBox!.x + compactChartBox!.width,
  )

  await page.setViewportSize({ width: 1024, height: 900 })
  await expect(compactPeriod).toBeVisible()
  await expect(page.locator('.klinecharts-pro-period-bar .period:visible')).toHaveCount(0)
  await page.setViewportSize({ width: 1146, height: 900 })

  await page.evaluate(() => {
    localStorage.setItem(
      'marketData.favoriteSymbols',
      JSON.stringify(['BTCUSDT']),
    )
  })
  await page.locator('.klinecharts-pro-period-bar .symbol').click()
  const symbolPicker = page.getByTestId('symbol-picker')
  await expect(symbolPicker).toBeVisible()
  await expect(
    symbolPicker.getByRole('tab', { name: '收藏' }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(
    symbolPicker.getByRole('button', { name: '选择 BTCUSDT' }),
  ).toBeVisible()
  await expect(
    symbolPicker.getByRole('button', { name: '选择 ETHUSDT' }),
  ).toHaveCount(0)
  await symbolPicker.getByRole('tab', { name: '全部' }).click()
  await expect(
    symbolPicker.getByRole('button', { name: '选择 ETHUSDT' }),
  ).toBeVisible()
  await expect(symbolPicker.getByText('全部交易对')).toBeVisible()
  await expect(symbolPicker.getByText('2 个')).toBeVisible()
  const symbolSearch = symbolPicker.getByLabel('搜索交易对')
  await symbolSearch.fill('ETHUSDT')
  const addEthFavorite = symbolPicker.getByRole('button', {
    name: '收藏 ETHUSDT',
  })
  await expect(addEthFavorite).toBeVisible()
  await addEthFavorite.click()
  await expect(
    symbolPicker.getByRole('button', { name: '取消收藏 ETHUSDT' }),
  ).toHaveAttribute('aria-pressed', 'true')
  expect(
    await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem('marketData.favoriteSymbols') ?? '[]',
      ),
    ),
  ).toEqual(['BTCUSDT', 'ETHUSDT'])
  await symbolPicker
    .getByRole('button', { name: '选择 ETHUSDT' })
    .click()
  await expect(page.locator('.klinecharts-pro-period-bar .symbol')).toHaveText(
    'ETHUSDT',
  )

  await selectChartPeriod(page, '1h')
  await expect(compactPeriod).toContainText('1h')
  await expect(
    page.locator('.klinecharts-pro-period-bar .period.selected'),
  ).toHaveText('1h')

  await page.getByText('指标', { exact: true }).click()
  const rsiRow = page
    .locator('.klinecharts-pro-indicator-modal-list li.row')
    .filter({ hasText: 'RSI' })
  await rsiRow.click({ position: { x: 5, y: 20 } })
  await expect(rsiRow.locator('.klinecharts-pro-checkbox')).toHaveClass(/checked/)
  await page
    .locator('.klinecharts-pro-modal .close-icon')
    .click({ position: { x: 1, y: 1 } })

  const widget = page.locator('.klinecharts-pro-widget')
  await page
    .locator('.klinecharts-pro-drawing-bar .item')
    .first()
    .locator('.icon-arrow')
    .click({ position: { x: 1, y: 16 } })
  const segmentTool = page
    .locator('.klinecharts-pro-drawing-bar .list li')
    .filter({ hasText: /^线段$/ })
  await segmentTool.click({ position: { x: 5, y: 20 } })
  const widgetBox = await widget.boundingBox()
  expect(widgetBox).not.toBeNull()
  if (!widgetBox) throw new Error('KLineChart Pro widget has no bounding box')
  await page.mouse.click(
    widgetBox.x + widgetBox.width * 0.4,
    widgetBox.y + widgetBox.height * 0.25,
  )
  await page.getByRole('heading', { level: 1 }).hover()
  const beforeCommit = await widget.screenshot()
  await page.mouse.click(
    widgetBox.x + widgetBox.width * 0.65,
    widgetBox.y + widgetBox.height * 0.35,
  )
  await page.getByRole('heading', { level: 1 }).hover()
  const afterCommit = await widget.screenshot()
  expect(afterCommit.equals(beforeCommit)).toBe(false)
  await expectCanvasContent(page)

  await page.getByTestId('open-data-manager').click()
  const dataManager = page.getByTestId('data-manager')
  await expect(dataManager).toBeVisible()
  const compactPeriodBox = await compactPeriod.boundingBox()
  const dataManagerBox = await dataManager.boundingBox()
  expect(compactPeriodBox).not.toBeNull()
  expect(dataManagerBox).not.toBeNull()
  if (compactPeriodBox === null || dataManagerBox === null) {
    throw new Error('Expected compact period selector and data drawer bounds')
  }
  const overlapLeft = Math.max(compactPeriodBox.x, dataManagerBox.x)
  const overlapRight = Math.min(
    compactPeriodBox.x + compactPeriodBox.width,
    dataManagerBox.x + dataManagerBox.width,
  )
  expect(overlapRight).toBeGreaterThan(overlapLeft)
  const drawerOwnsOverlap = await page.evaluate(
    ({ x, y }) =>
      document
        .elementFromPoint(x, y)
        ?.closest('[data-testid="data-manager"]') !== null,
    {
      x: overlapLeft + (overlapRight - overlapLeft) / 2,
      y: compactPeriodBox.y + compactPeriodBox.height / 2,
    },
  )
  expect(drawerOwnsOverlap).toBe(true)
  await dataManager
    .getByLabel('交易对', { exact: true })
    .selectOption('BTCUSDT')
  await dataManager.getByLabel('周期').selectOption('5m')
  await dataManager
    .getByLabel('开始时间')
    .fill('2026-07-22T00:00')
  await dataManager
    .getByLabel('结束时间')
    .fill('2026-07-22T01:00')
  // Isolate this full-month download from minutes fetched by earlier chart views.
  page.once('dialog', (dialog) => dialog.accept())
  await dataManager.getByRole('button', { name: '删除当前缓存', exact: true }).click()
  await expect(dataManager.getByText('当前交易对的 1m 本地缓存已删除。')).toBeVisible()
  await dataManager
    .getByRole('button', { name: '下载历史数据' })
    .click()
  await expect(dataManager.getByText(/下载完成/)).toBeVisible({ timeout: 60_000 })
  await expect(
    dataManager.locator('.cache-summary').filter({ hasText: '普通 K 线' }),
  ).toContainText('44,640 根')
  await expect(dataManager.getByText(/标记价格/)).toHaveCount(0)
  await dataManager.getByTestId('close-data-manager').click()

  const replayControls = page.getByTestId('replay-controls')
  await expect(
    replayControls.getByLabel('回放开始时间'),
  ).toHaveCount(0)
  await jumpChart(page, '2026-07-22T00:00')
  await expect(
    replayControls.getByRole('button', { name: '创建回放' }),
  ).toBeEnabled()
  // The chart remains ETH while the drawer downloaded BTC; this jump is cold.
  await expect(replayControls.getByText(/起点：/)).toContainText('2026/7/22', { timeout: 60_000 })
  await setReplayEnd(page, '2026-07-22T05:00')
  await replayControls.getByRole('button', { name: '创建回放' }).click()
  await expect(replayControls).toContainText('1/6', { timeout: 60_000 })
  const replayRequests: string[] = []
  const recordReplayRequest = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).hostname === 'fapi.binance.com') replayRequests.push(request.url())
  }

  const simulationPanel = page.getByTestId('simulation-panel')
  await simulationPanel.getByRole('button', { name: '账户详情', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '模拟账户详情' }).getByText('钱包余额', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭模拟账户详情' }).click()
  await simulationPanel
    .getByRole('button', { name: '计算预估' })
    .click()
  await expect(simulationPanel.getByText('预计成交价')).toBeVisible()
  await simulationPanel.getByRole('button', { name: '开多' }).click()
  await expect(
    simulationPanel.getByText('多仓', { exact: true }),
  ).toBeVisible()
  await expect(
    simulationPanel.getByTestId('position-summary'),
  ).toContainText('浮动盈亏')
  await expect(
    simulationPanel.getByTestId('position-summary'),
  ).toContainText('持仓收益率')
  await expect(
    simulationPanel
      .getByTestId('position-summary')
      .getByText('浮动盈亏')
      .locator('..')
      .locator('dd'),
  ).toContainText('USDT')
  await expect(
    simulationPanel
      .getByTestId('position-summary')
      .getByText('持仓收益率')
      .locator('..')
      .locator('dd'),
  ).toContainText('%')
  await expect(
    replayControls.getByRole('button', { name: '上一根' }),
  ).toBeDisabled()

  await simulationPanel
    .getByRole('button', { name: '同向加仓' })
    .click()
  const reduce = await openPositionEditor(page, 'long', 'reduce')
  await reduce.getByRole('button', { name: '减 25%' }).click()
  await reduce.getByRole('button', { name: '完成' }).click()
  await expectTradeCount(page, '3')

  const risk = await openPositionEditor(page, 'long', 'risk')
  await risk.getByLabel('止盈价格').fill('70000')
  await risk.getByRole('button', { name: '设置止盈' }).click()
  await risk.getByLabel('止损价格').fill('50000')
  await risk.getByRole('button', { name: '设置止损' }).click()
  await risk.getByRole('button', { name: '完成' }).click()
  await expect(simulationPanel).toContainText('70000 / 50000')

  await selectChartPeriod(page, '1d')
  await selectChartPeriod(page, '3m')
  await expect(compactPeriod).toContainText('3m')

  // Period changes keep the same replay clock, account and open position.
  for (const timeframe of ['1w', '1M', '1d', '5m', '15m', '1h']) {
    await selectChartPeriod(page, timeframe)
    await expect(compactPeriod).toContainText(timeframe)
    await expect(page.locator('.klinecharts-pro-period-bar .period.selected')).toHaveText(timeframe)
    await expect(page.locator('.status-footer')).toContainText(`ETHUSDT · ${timeframe}`)
    await expect(page.locator('.status-footer')).not.toContainText('不能切换')
    await expect(replayControls).toContainText('1/6')
    await expect(simulationPanel.getByText('多仓', { exact: true })).toBeVisible()
    await expect(simulationPanel).toContainText('70000 / 50000')
    await expectTradeCount(page, '3')
    try {
      await expect(page.locator('.klinecharts-pro-content > .klinecharts-pro-loading')).toBeHidden({ timeout: 60_000 })
    } catch (error) {
      const diagnosticsPath = test.info().outputPath(`replay-${timeframe}-archive-requests.json`)
      await writeFile(diagnosticsPath, JSON.stringify({
        footer: await page.locator('.status-footer').textContent(), requests: archiveRequests,
      }, null, 2))
      await test.info().attach(`replay-${timeframe}-archive-requests`, {
        path: diagnosticsPath,
        contentType: 'application/json',
      })
      throw error
    }
    await expectCanvasContent(page)
  }

  await selectChartPeriod(page, '5m')
  await expect(compactPeriod).toContainText('5m')
  await expect(page.locator('.klinecharts-pro-content > .klinecharts-pro-loading')).toBeHidden()
  page.on('request', recordReplayRequest)
  for (let index = 2; index <= 4; index += 1) {
    await replayControls.getByRole('button', { name: '下一根' }).click()
    await expect(replayControls).toContainText(`${index}/6`)
  }
  await expect(
    simulationPanel.getByText('多仓', { exact: true }),
  ).toBeVisible()

  await selectChartPeriod(page, '1h')
  await expect(compactPeriod).toContainText('1h')
  await replayControls.getByLabel('回放速度').selectOption('10')
  await replayControls.getByRole('button', { name: '播放', exact: true }).click()
  await page.clock.runFor(1_000)
  await expect(replayControls).toContainText('6/6')
  expect(replayRequests.length).toBeLessThanOrEqual(1)
  for (const requestUrl of replayRequests) {
    const url = new URL(requestUrl)
    expect(url.searchParams.get('interval')).toBe('5m')
    expect(Number(url.searchParams.get('endTime')) - Number(url.searchParams.get('startTime'))).toBeGreaterThan(5 * 60_000)
  }
  page.off('request', recordReplayRequest)

  const originalChartHost = await chartHost.elementHandle()
  expect(originalChartHost).not.toBeNull()

  await page.getByRole('button', { name: '实时行情' }).click()
  const liveTimeControls = page.locator('.live-time-controls')
  await expect(liveTimeControls.getByRole('button', { name: '时间定位', exact: true })).toBeVisible()
  await jumpChart(page, '2026-07-22T02:00')
  await expect(page.locator('.status-footer')).toContainText('图表已跳转到')
  await expect(page.getByTestId('live-status')).toContainText('只读模式')
  await expect(page.getByTestId('live-status')).toContainText('已连接')
  await expect(page.getByTestId('live-status')).toContainText('进行中')
  await expect(page.getByTestId('live-status')).toContainText('60005')
  await expect(page.getByTestId('live-status')).not.toContainText('标记价格')
  await expect(page.getByTestId('simulation-panel')).toHaveCount(0)
  await expect(page.getByTestId('replay-controls')).toHaveCount(0)
  expect(
    await originalChartHost?.evaluate(
      (node) => node === document.querySelector('[data-testid="chart-host"]'),
    ),
  ).toBe(true)
  expect(notFoundResponses).toEqual([])
  expect(runtimeErrors).toEqual([])

  await page.reload()
  await expect(
    page.getByRole('heading', { name: '加密货币合约回放工作站' }),
  ).toBeVisible()
  await expect(page.getByTestId('replay-controls')).toContainText('6/6')
  await expect(page.getByTestId('simulation-panel')).toContainText(
    '70000 / 50000',
  )
  await expectTradeCount(page, '3')
  await expectCanvasContent(page)
  await page.getByText('指标', { exact: true }).click()
  const restoredRsiRow = page
    .locator('.klinecharts-pro-indicator-modal-list li.row')
    .filter({ hasText: 'RSI' })
  await expect(
    restoredRsiRow.locator('.klinecharts-pro-checkbox'),
  ).toHaveClass(/checked/)
  await page
    .locator('.klinecharts-pro-modal .close-icon')
    .click({ position: { x: 1, y: 1 } })

  await page.getByTestId('replay-controls').getByRole('button', { name: '回放设置', exact: true }).click()
  await page.getByRole('dialog', { name: '回放会话操作' }).getByRole('button', { name: '结束会话' }).click()
  await expect(page.getByTestId('replay-controls')).toContainText('创建回放')
  await expect(page.locator('.status-footer')).not.toContainText(
    '回放会话进行中',
  )
  await expectCanvasContent(page)

  await page.getByTestId('open-data-manager').click()
  const backupManager = page.getByTestId('data-manager')
  const backupPanel = backupManager.getByTestId('backup-sync-panel')
  await expect(backupPanel).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await backupPanel.getByTestId('export-session-backup').click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  expect(downloadPath).not.toBeNull()
  page.once('dialog', (dialog) => dialog.accept())
  await backupPanel
    .getByTestId('import-backup-file')
    .setInputFiles(downloadPath!)
  await expect(backupPanel.getByTestId('backup-status')).toContainText('导入完成', { timeout: 90_000 })

  await backupPanel.getByTestId('github-owner').fill('alice')
  await backupPanel
    .getByTestId('github-repository')
    .fill('trading-backup')
  await backupPanel.getByTestId('github-token').fill('github_pat_e2e_secret')
  await backupPanel.getByTestId('github-test-connection').click()
  await expect(
    backupPanel.getByTestId('github-repository-info'),
  ).toContainText('alice/trading-backup')

  await backupPanel.getByTestId('github-upload').click()
  await expect
    .poll(() => github.files.has('manifest.json'))
    .toBe(true)
  expect(github.files.has('config/preferences.json')).toBe(true)
  expect(
    [...github.files.keys()].some((path) => path.startsWith('sessions/')),
  ).toBe(true)
  expect(
    [...github.files.keys()].some((path) =>
      path.startsWith('data/market-history/'),
    ),
  ).toBe(true)

  await backupPanel.getByTestId('github-compare').click()
  const compareStatus = await backupPanel
    .getByTestId('backup-status')
    .textContent()
  const cloudSnapshotPath = test.info().outputPath('github-before-full-pull.json')
  await writeFile(cloudSnapshotPath, JSON.stringify({
    files: [...github.files].map(([path, file]) => ({ path, sha: file.sha, contentBase64: file.bytes.toString('base64') })),
  }))
  await test.info().attach('github-before-full-pull', { path: cloudSnapshotPath, contentType: 'application/json' })
  await traceNativeRestoreWrites(page)
  page.once('dialog', (dialog) => dialog.accept())
  await backupPanel.getByTestId('github-pull').click()
  await expect
    .poll(() => backupPanel.getByTestId('backup-status').textContent())
    .not.toBe(compareStatus)
  expect(
    await page.evaluate(() =>
      Object.values(localStorage).some((value) =>
        value.includes('github_pat_e2e_secret'),
      ),
    ),
  ).toBe(false)
  try {
    await expect(backupPanel.getByTestId('backup-status')).toContainText('云端恢复完成', { timeout: 90_000 })
    await expect(backupPanel.getByTestId('github-disconnect')).toBeEnabled()
  } catch (error) {
    const restoreDiagnosticsPath = test.info().outputPath('full-pull-diagnostics.json')
    await writeFile(restoreDiagnosticsPath, JSON.stringify({
      backupStatus: await backupPanel.getByTestId('backup-status').textContent(),
      footer: await page.locator('.status-footer').textContent(), runtimeErrors,
      nativeRestore: await page.evaluate(() => (window as unknown as { nativeRestoreTrace?: unknown }).nativeRestoreTrace ?? null),
    }, null, 2))
    await test.info().attach('full-pull-diagnostics', { path: restoreDiagnosticsPath, contentType: 'application/json' })
    throw error
  }
  await backupPanel.getByTestId('github-disconnect').click()
  await expect(backupPanel.getByTestId('github-token')).toHaveValue('')
  await backupManager.getByTestId('close-data-manager').click()

  expect(notFoundResponses).toEqual([])
  expect(runtimeErrors).toEqual([])
  expect(deprecatedApiWarnings).toEqual([])
})

async function trackPriceAxis(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const labels = new Map<HTMLCanvasElement, { text: string; x: number; y: number }[]>()
    Object.assign(window, { chartAxisTestLabels: labels })
    const fillText = CanvasRenderingContext2D.prototype.fillText
    const clearRect = CanvasRenderingContext2D.prototype.clearRect
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      labels.set(this.canvas, [])
      return Reflect.apply(clearRect, this, args)
    }
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
      const entries = labels.get(this.canvas) ?? []
      entries.push({ text, x, y })
      labels.set(this.canvas, entries)
      return Reflect.apply(fillText, this, [text, x, y, ...args])
    }
  })
  // The first pane's last widget is its price axis; its base canvas contains ticks.
  const axis = page.locator('[k-line-chart-id] > div > div:first-child > div:last-child')
  const readTicks = () => axis.locator('canvas').first().evaluate((canvas) =>
    (window as unknown as {
      chartAxisTestLabels: Map<HTMLCanvasElement, { text: string; x: number; y: number }[]>
    }).chartAxisTestLabels.get(canvas)?.filter(({ text }) => /^-?[\d,]+\.\d+$/.test(text))
      .map(({ text, y }) => ({ value: Number(text.replaceAll(',', '')), y })) ?? [],
  )
  const timeAxis = page.locator('[k-line-chart-id] > div > div:last-child canvas').first()
  const readTimeTicks = () => timeAxis.evaluate((canvas) =>
    (window as unknown as {
      chartAxisTestLabels: Map<HTMLCanvasElement, { text: string; x: number; y: number }[]>
    }).chartAxisTestLabels.get(canvas) ?? [],
  )
  const pricePerPixel = async () => {
    const labels = (await readTicks()).filter((label) => label.value > 10_000).sort((left, right) => left.y - right.y)
    if (labels.length < 2) return 0
    // Axis text is snapped to integer pixels. Use the widest tick interval so
    // a one-pixel rounding difference in adjacent labels does not dominate.
    const first = labels[0], last = labels.at(-1)!
    return Math.abs((last.value - first.value) / (last.y - first.y))
  }
  return { axis, readTicks, pricePerPixel, readTimeTicks }
}

test('restores product favorites and the selected product after reload', async ({ page }) => {
  await mockBinance(page, true)
  await page.goto('./')
  await expectCanvasContent(page)
  const symbolLabel = page.locator('.klinecharts-pro-period-bar .symbol')
  await symbolLabel.click()
  const picker = page.getByTestId('symbol-picker')
  await picker.getByRole('tab', { name: '全部' }).click()
  await picker.getByRole('button', { name: '收藏 BTCUSDT', exact: true }).click()
  await picker.getByRole('button', { name: '收藏 ETHUSDT', exact: true }).click()
  await picker.getByRole('button', { name: '选择 ETHUSDT' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('marketData.selectedSymbol') ?? 'null')?.ticker)).toBe('ETHUSDT')
  await page.reload()
  await expectCanvasContent(page)
  await expect(symbolLabel).toHaveText('ETHUSDT')
  await symbolLabel.click()
  await expect(picker.getByRole('tab', { name: '收藏', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(picker.getByRole('button', { name: '选择 BTCUSDT' })).toBeVisible()
  await expect(picker.getByRole('button', { name: '选择 ETHUSDT' })).toBeVisible()
  await picker.getByRole('button', { name: '取消收藏 BTCUSDT', exact: true }).click()
  await page.reload()
  await expectCanvasContent(page)
  await expect(symbolLabel).toHaveText('ETHUSDT')
  await symbolLabel.click()
  await expect(picker.getByRole('button', { name: '选择 ETHUSDT' })).toBeVisible()
  await expect(picker.getByRole('button', { name: '选择 BTCUSDT' })).toHaveCount(0)
})

test('fits candles with balanced padding and toggles indicator information without hiding plots', async ({ page }) => {
  // Keep enough chart pixels for the tick-label estimate of the exact 8% padding.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await mockBinance(page)
  await installArchiveFixtures(page, {}, { flat: true })
  const { axis, pricePerPixel } = await trackPriceAxis(page)
  await page.addInitScript(() => {
    localStorage.setItem('chart.indicators.v1', JSON.stringify({
      schemaVersion: 1,
      main: [{ name: 'SUPERTREND', calcParams: [10, 50, 88], visible: true, styles: null }],
      sub: [{ indicators: [{ name: 'MACD', calcParams: [12, 26, 9], visible: true, styles: null }] }],
    }))
    const texts = new Map<HTMLCanvasElement, string[]>()
    Object.assign(window, { indicatorInfoTestTexts: texts })
    const clearRect = CanvasRenderingContext2D.prototype.clearRect
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      texts.set(this.canvas, [])
      return Reflect.apply(clearRect, this, args)
    }
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
      if (/^Supertrend|^MACD\(|^时间/.test(text)) {
        const entries = texts.get(this.canvas) ?? []
        entries.push(text)
        texts.set(this.canvas, entries)
      }
      return Reflect.apply(fillText, this, [text, x, y, ...args])
    }
  })
  // All candles share known extrema. Supertrend is deliberately far outside them.
  await page.route(/\/fapi\/v1\/klines\?/, async (route) => {
    const url = new URL(route.request().url())
    const rows = []
    const end = Number(url.searchParams.get('endTime'))
    for (let time = alignOpenTime(Number(url.searchParams.get('startTime')), '1m', 'ceil'); time <= end && rows.length < 500; time += 60_000) {
      rows.push([time, '60000', '60010', '59990', '60000', '100', time + 59_999, '6000000', 100, '0', '0', '0'])
    }
    await route.fulfill({ json: rows })
  })
  await page.goto('./')
  await expectCanvasContent(page)
  await expect.poll(pricePerPixel).toBeGreaterThan(0)
  const candleHeightRatio = async () => 20 / ((await pricePerPixel()) * (await axis.boundingBox())!.height)
  await expect.poll(candleHeightRatio).toBeCloseTo(1 / 1.16, 2)
  const titleTexts = () => page.evaluate(() => [...new Set(
    [...(window as unknown as { indicatorInfoTestTexts: Map<HTMLCanvasElement, string[]> }).indicatorInfoTestTexts.values()].flat(),
  )])
  await expect.poll(titleTexts).toEqual(expect.arrayContaining(['Supertrend', 'MACD(12,26,9)']))
  const mainCanvas = page.locator('[k-line-chart-id] > div > div:first-child > div:first-child canvas').first()
  await page.getByRole('heading', { level: 1 }).hover()
  const plotsBefore = await mainCanvas.evaluate((canvas) => canvas.toDataURL())
  await page.getByRole('button', { name: '隐藏主图指标信息', exact: true }).click()
  await expect.poll(titleTexts).toContain('MACD(12,26,9)')
  await expect.poll(titleTexts).not.toContain('Supertrend')
  await expect.poll(async () => (await titleTexts()).some(text => /^时间/.test(text))).toBe(true)
  await expect(page.getByRole('button', { name: '显示主图指标信息', exact: true })).toHaveAttribute('aria-expanded', 'false')
  expect(await mainCanvas.evaluate((canvas) => canvas.toDataURL()) === plotsBefore).toBe(true)
  await page.screenshot({ path: test.info().outputPath('main-indicator-hidden-desktop.png') })
  await expect.poll(candleHeightRatio).toBeCloseTo(1 / 1.16, 2)
  await page.getByRole('button', { name: '显示主图指标信息', exact: true }).click()
  await expect.poll(titleTexts).toEqual(expect.arrayContaining(['Supertrend', 'MACD(12,26,9)']))
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: '显示主图指标信息', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(titleTexts).toContain('MACD(12,26,9)')
  await expect.poll(titleTexts).not.toContain('Supertrend')
  await expect.poll(async () => (await titleTexts()).some(text => /^时间/.test(text))).toBe(true)
  await page.getByRole('button', { name: '显示主图指标信息', exact: true }).click()
  await expect.poll(titleTexts).toEqual(expect.arrayContaining(['Supertrend', 'MACD(12,26,9)']))
  await page.getByRole('button', { name: '隐藏主图指标信息', exact: true }).click()
  await expect.poll(titleTexts).not.toContain('Supertrend')
  await expect.poll(titleTexts).toContain('MACD(12,26,9)')
  await expect.poll(async () => (await titleTexts()).some(text => /^时间/.test(text))).toBe(true)
  await page.screenshot({ path: test.info().outputPath('main-indicator-hidden-mobile.png') })
})

test('zooms the price range with the wheel over the price axis while preserving the time scale', async ({ page }) => {
  await mockBinance(page)
  const { axis, pricePerPixel, readTimeTicks } = await trackPriceAxis(page)
  await page.goto('./')
  await expectCanvasContent(page)
  const mode = page.getByRole('group', { name: '价格范围模式' })
  const auto = mode.getByRole('button', { name: '自动', exact: true })
  const manual = mode.getByRole('button', { name: '手动', exact: true })
  await expect(auto).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(pricePerPixel).toBeGreaterThan(0)
  // Normalize the automatic range after initial data and pane setup, before
  // comparing wheel zoom and reset against the same interactive fit operation.
  await auto.click()
  await waitForChartRender(page)
  const initial = await pricePerPixel()
  await expect.poll(async () => (await readTimeTicks()).length).toBeGreaterThan(1)
  const initialTimeTicks = await readTimeTicks()
  await axis.hover()
  await page.mouse.wheel(0, -100)
  await expect.poll(pricePerPixel).toBeLessThan(initial * 0.95)
  await expect(manual).toHaveAttribute('aria-pressed', 'true')
  // Compare the rendered labels and coordinates, independent of PNG encoding/rasterization.
  await expect.poll(readTimeTicks).toEqual(initialTimeTicks)
  await page.mouse.wheel(0, 100)
  await expect.poll(pricePerPixel).toBeCloseTo(initial, 5)
  await page.mouse.wheel(0, 100)
  await expect.poll(pricePerPixel).toBeGreaterThan(initial * 1.05)
  await axis.dblclick()
  await expect.poll(pricePerPixel).toBeCloseTo(initial, 5)
  await expect(auto).toHaveAttribute('aria-pressed', 'true')
  await manual.click()
  await expect(manual).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(pricePerPixel).toBeCloseTo(initial, 5)
  await axis.hover()
  await page.mouse.wheel(0, 100)
  await expect.poll(pricePerPixel).toBeGreaterThan(initial * 1.05)
  await auto.click()
  await expect.poll(pricePerPixel).toBeCloseTo(initial, 5)
  await expect(auto).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(readTimeTicks).toEqual(initialTimeTicks)
  await page.screenshot({ path: 'test-results/price-range-mode.png' })
})

test('resets the manual price range when switching between differently priced instruments', async ({ page }) => {
  await mockBinance(page, true, { BTCUSDT: 74_000, ETHUSDT: 25 })
  const { axis, readTicks } = await trackPriceAxis(page)
  await page.goto('./')
  await expectCanvasContent(page)
  const meanPrice = async () => {
    const ticks = await readTicks()
    return ticks.reduce((sum, tick) => sum + tick.value, 0) / ticks.length
  }
  const mode = page.getByRole('group', { name: '价格范围模式' })
  const auto = mode.getByRole('button', { name: '自动', exact: true })
  const manual = mode.getByRole('button', { name: '手动', exact: true })
  await expect.poll(meanPrice).toBeGreaterThan(70_000)
  const axisBox = (await axis.boundingBox())!
  await page.mouse.move(axisBox.x + axisBox.width / 2, axisBox.y + axisBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(axisBox.x + axisBox.width / 2, axisBox.y + axisBox.height / 2 + 50, { steps: 5 })
  await page.mouse.up()
  await page.clock.runFor(150)
  await expect(manual).toHaveAttribute('aria-pressed', 'true')

  const selectSymbol = async (symbol: string) => {
    await page.locator('.klinecharts-pro-period-bar .symbol').click()
    const picker = page.getByTestId('symbol-picker')
    await picker.getByRole('tab', { name: '全部' }).click()
    await picker.getByRole('button', { name: `选择 ${symbol}` }).click()
    await page.clock.runFor(150)
    await expect(page.locator('.klinecharts-pro-content > .klinecharts-pro-loading')).toBeHidden()
    await expect(auto).toHaveAttribute('aria-pressed', 'true')
  }
  await selectSymbol('ETHUSDT')
  await expect.poll(meanPrice).toBeGreaterThan(20)
  await expect.poll(meanPrice).toBeLessThan(30)
  await manual.click()
  await selectSymbol('BTCUSDT')
  await expect.poll(meanPrice).toBeGreaterThan(70_000)
  await expect.poll(meanPrice).toBeLessThan(80_000)
})

test('toggles the order panel in both modes and resizes the existing chart without losing panel input', async ({ page }) => {
  test.setTimeout(60_000)
  await mockBinance(page, true)
  await page.goto('./')
  await expectCanvasContent(page)
  const chartHost = page.getByTestId('chart-host')
  const originalHost = await chartHost.elementHandle()
  const panel = page.getByRole('complementary', { name: '模拟下单面板' })
  const replayControls = page.getByTestId('replay-controls')
  await jumpChart(page, '2026-07-22T00:00')
  await expect(replayControls.getByText(/起点：/)).toContainText('2026/7/22')
  await setReplayEnd(page, '2026-07-22T05:00')
  await replayControls.getByRole('button', { name: '创建回放' }).click()
  const input = panel.getByLabel('保证金金额', { exact: true })
  await input.fill('1234')
  const initialWidth = (await chartHost.boundingBox())!.width
  const canvasWidth = async () => {
    // ResizeObserver schedules canvas drawing on the next animation frame.
    await page.clock.runFor(50)
    return chartHost.locator('canvas').first().evaluate((canvas) => canvas.width)
  }
  const initialCanvasWidth = await canvasWidth()
  await setWorkspacePanel(page, '下单面板', false)
  await page.clock.runFor(50)
  await expect(panel).toBeHidden()
  await expect(page.getByRole('button', { name: '工作区', exact: true })).toBeVisible()
  await expect.poll(async () => (await chartHost.boundingBox())!.width).toBeGreaterThan(initialWidth + 240)
  await expect.poll(canvasWidth).toBeGreaterThan(initialCanvasWidth)
  await setWorkspacePanel(page, '下单面板', true)
  await page.clock.runFor(50)
  await expect(panel).toBeVisible()
  await expect(input).toHaveValue('1234')
  await expect.poll(canvasWidth).toBe(initialCanvasWidth)

  await page.getByRole('button', { name: '实时行情' }).click()
  await expect(page.getByTestId('live-status')).toBeVisible()
  await setWorkspacePanel(page, '下单面板', false)
  await page.clock.runFor(50)
  await expect(page.getByTestId('live-status')).toBeHidden()
  await expect.poll(async () => (await chartHost.boundingBox())!.width).toBeGreaterThan(initialWidth + 240)
  await expect.poll(canvasWidth).toBeGreaterThan(initialCanvasWidth)
  await page.getByRole('button', { name: '历史模拟' }).click()
  await expect(page.getByRole('complementary', { name: '模拟下单面板' })).toBeHidden()
  await setWorkspacePanel(page, '下单面板', true)
  await page.clock.runFor(50)
  await expect(page.getByTestId('simulation-panel')).toBeVisible()
  expect(await originalHost!.evaluate((node) => node === document.querySelector('[data-testid="chart-host"]'))).toBe(true)
})

test('adds Supertrend to the main chart and restores its parameters after reload', async ({ page }) => {
  await mockBinance(page, false, {}, { trend: true })
  await page.addInitScript(() => {
    const fills: { color: string; alpha: number }[] = []
    const titles: string[] = []
    const settings: { x: number; y: number }[] = []
    let title = ''
    Object.assign(window, { supertrendTestFills: fills, supertrendTestTitles: titles, supertrendTestSettings: settings })
    const original = CanvasRenderingContext2D.prototype.fill
    CanvasRenderingContext2D.prototype.fill = function (...args: unknown[]) {
      if (this.globalCompositeOperation === 'destination-over') fills.push({ color: String(this.fillStyle), alpha: this.globalAlpha })
      return Reflect.apply(original, this, args)
    }
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
      if (/^Supertrend|^上涨:|^下跌:/.test(text)) titles.push(text)
      if (/^Supertrend|^(MA|VOL|MACD)\(/.test(text)) title = text
      if (text === '\ue902' && title === 'Supertrend') {
        const transform = this.getTransform()
        const point = new DOMPoint(x, y).matrixTransform(transform)
        const rect = this.canvas.getBoundingClientRect()
        settings.push({ x: rect.left + point.x / devicePixelRatio, y: rect.top + point.y / devicePixelRatio })
      }
      return Reflect.apply(fillText, this, [text, x, y, ...args])
    }
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('./')
  await expectCanvasContent(page)

  const readSupertrend = () => page.evaluate(() => {
    const preferences = JSON.parse(localStorage.getItem('chart.indicators.v1') ?? 'null')
    return preferences?.main.find((indicator: { name: string }) => indicator.name === 'SUPERTREND') ?? null
  })
  const openIndicators = () => page.getByText('指标', { exact: true }).click()
  const closeModal = () => page.locator('.klinecharts-pro-modal .close-icon')
    .click({ position: { x: 1, y: 1 } })
  const row = page.locator('.klinecharts-pro-indicator-modal-list li.row')
    .filter({ hasText: 'Supertrend(超级趋势)' })

  await openIndicators()
  await expect(row).toHaveCount(1)
  await row.click({ position: { x: 5, y: 20 } })
  await expect(row.locator('.klinecharts-pro-checkbox')).toHaveClass(/checked/)
  await closeModal()
  await expect.poll(readSupertrend).toMatchObject({ calcParams: [10, 3, 88], visible: true })
  const fillColors = () => page.evaluate(() =>
    [...new Set((window as unknown as { supertrendTestFills: { color: string }[] }).supertrendTestFills.map((fill) => fill.color))],
  )
  const latestFillAlpha = () => page.evaluate(() =>
    (window as unknown as { supertrendTestFills: { alpha: number }[] }).supertrendTestFills.at(-1)?.alpha,
  )
  await expect.poll(fillColors).toEqual(expect.arrayContaining(['#26a69a', '#ef5350']))
  expect(await page.evaluate(() => [...new Set(
    (window as unknown as { supertrendTestTitles: string[] }).supertrendTestTitles,
  )])).toEqual(['Supertrend'])
  const widget = page.locator('.klinecharts-pro-widget')
  // The indicator toolbar is drawn on canvas; click its second-row gear.
  const gear = await page.evaluate(() =>
    (window as unknown as { supertrendTestSettings: { x: number; y: number }[] }).supertrendTestSettings.at(-1),
  )
  expect(gear).toBeDefined()
  await page.mouse.click(gear!.x + 3, gear!.y + 3)
  const settings = page.locator('.klinecharts-pro-indicator-setting-modal-content')
  await expect(settings.getByText('ATR 周期', { exact: true })).toBeVisible()
  await expect(settings.getByText('ATR 倍数', { exact: true })).toBeVisible()
  await expect(settings.getByText('填充透明度（%）', { exact: true })).toBeVisible()
  const inputs = settings.locator('input')
  await expect(inputs.nth(0)).toHaveValue('10')
  await expect(inputs.nth(1)).toHaveValue('3')
  await expect(inputs.nth(2)).toHaveValue('88')
  await inputs.nth(0).fill('7')
  await inputs.nth(0).blur()
  await inputs.nth(1).fill('2.5')
  await inputs.nth(1).blur()
  await inputs.nth(2).fill('40')
  await inputs.nth(2).blur()
  await page.getByText('确定', { exact: true }).click()
  await expect.poll(readSupertrend).toMatchObject({ calcParams: [7, 2.5, 40], visible: true })
  await expect.poll(latestFillAlpha).toBe(0.6)
  await expect.poll(fillColors).toEqual(expect.arrayContaining(['#26a69a', '#ef5350']))
  await page.reload()
  await expectCanvasContent(page)
  await openIndicators()
  await expect(row.locator('.klinecharts-pro-checkbox')).toHaveClass(/checked/)
  await closeModal()
  await expect.poll(readSupertrend).toMatchObject({ calcParams: [7, 2.5, 40], visible: true })
  await expect.poll(latestFillAlpha).toBe(0.6)

  await expect.poll(fillColors).toEqual(expect.arrayContaining(['#26a69a', '#ef5350']))
  await page.getByRole('heading', { level: 1 }).hover()
  await page.screenshot({ path: 'test-results/supertrend-fill.png' })
  const enabled = await widget.screenshot()
  await openIndicators()
  await row.click({ position: { x: 5, y: 20 } })
  await closeModal()
  await expect.poll(readSupertrend).toBeNull()
  await page.getByRole('heading', { level: 1 }).hover()
  expect((await widget.screenshot()).equals(enabled)).toBe(false)
  await page.reload()
  await openIndicators()
  await expect(row.locator('.klinecharts-pro-checkbox')).not.toHaveClass(/checked/)
  expect(errors).toEqual([])
})

test('renders KC and TTM Squeeze, edits parameters, and restores archived configuration', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await mockBinance(page, true)
  const github = await mockGitHub(page)
  await page.addInitScript(() => {
    const gears: Record<string, { x: number; y: number }> = {}
    const colors: string[] = []
    Object.assign(window, { volatilityGears: gears, volatilityColors: colors })
    let title = ''
    const originalText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
      if (/^(KC|TTM Squeeze)/.test(text)) title = text.startsWith('KC') ? 'KC' : 'TTM_SQUEEZE'
      else if (/^(MA|VOL|MACD)\(/.test(text)) title = ''
      if (text === '\ue902' && title) {
        const point = new DOMPoint(x, y).matrixTransform(this.getTransform())
        const rect = this.canvas.getBoundingClientRect()
        gears[title] = { x: rect.left + point.x / devicePixelRatio, y: rect.top + point.y / devicePixelRatio }
      }
      return Reflect.apply(originalText, this, [text, x, y, ...args])
    }
    const originalFill = CanvasRenderingContext2D.prototype.fill
    CanvasRenderingContext2D.prototype.fill = function (...args: unknown[]) {
      if (['#00bcd4', '#2962ff', '#ef5350', '#ffca28', '#26a69a', '#00cc88'].includes(String(this.fillStyle))) {
        if (!colors.includes(String(this.fillStyle))) colors.push(String(this.fillStyle))
      }
      return Reflect.apply(originalFill, this, args)
    }
  })
  await installViewportProbe(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('./')
  await expectCanvasContent(page)
  const row = (label: string) => page.locator('.klinecharts-pro-indicator-modal-list li.row').filter({ hasText: label })
  const closeModal = () => page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  await page.getByText('指标', { exact: true }).click()
  await expect(row('KC(肯特纳通道)')).toHaveCount(1)
  await row('KC(肯特纳通道)').click({ position: { x: 5, y: 20 } })
  await row('TTM Squeeze(挤压指标)').click({ position: { x: 5, y: 20 } })
  await closeModal()
  const readPreferences = () => page.evaluate(() => JSON.parse(localStorage.getItem('chart.indicators.v1') ?? 'null'))
  await expect.poll(readPreferences).toMatchObject({
    main: expect.arrayContaining([expect.objectContaining({ name: 'KC', calcParams: [20, 1.5, 20] })]),
    sub: expect.arrayContaining([expect.objectContaining({ indicators: [expect.objectContaining({ name: 'TTM_SQUEEZE', calcParams: [20, 2, 1.5] })] })]),
  })
  // Inspect actual chart results and figure styles, not just saved selection names.
  const inspect = () => page.evaluate(() => {
    type Value = { middle?: number; momentum?: number; dot?: number; squeeze?: boolean }
    type Plot = { result: Value[]; styles?: { lines?: { color?: string }[] }; figures: { key: string; styles?: (data: unknown, indicator: unknown) => { color?: string } }[] }
    const core = (window as unknown as { __viewportTestAdapter: { coreChart: { getIndicatorByPaneId(): Map<string, Map<string, Plot>> } } }).__viewportTestAdapter.coreChart
    const plots = [...core.getIndicatorByPaneId().values()].flatMap(pane => [...pane.entries()])
    const kc = plots.find(([name]) => name === 'KC')?.[1]
    const ttm = plots.find(([name]) => name === 'TTM_SQUEEZE')?.[1]
    const colors = new Set<string>()
    ttm?.result.forEach((value, index) => {
      for (const figure of ttm.figures) {
        if (Number.isFinite(value[figure.key as keyof Value])) {
          colors.add(figure.styles!({ prev: { indicatorData: ttm.result[index - 1] }, current: { indicatorData: value } }, ttm).color!)
        }
      }
    })
    const legacy = plots.filter(([name]) => name === 'VOL' || name === 'MACD')
    return { kc: kc?.result.some(value => Number.isFinite(value.middle)), kcColor: kc?.styles?.lines?.[0]?.color, ttm: ttm?.result.some(value => Number.isFinite(value.momentum)), legacyReady: legacy.length === 2 && legacy.every(([, plot]) => plot.result.some(value => Object.values(value).some(Number.isFinite))), colors: [...colors] }
  })
  await expect.poll(inspect).toMatchObject({ kc: true, ttm: true, colors: expect.arrayContaining(['#00bcd4', '#ef5350']) })
  const settings = page.locator('.klinecharts-pro-indicator-setting-modal-content')
  for (const [name, params, labels] of [
    ['KC', ['10', '2.25', '7'], ['EMA 周期', 'ATR 倍数', 'ATR 周期']],
    ['TTM_SQUEEZE', ['12', '2.5', '1.25'], ['周期', '布林带标准差倍数', 'KC ATR 倍数']],
  ] as const) {
    // The chart suppresses a second click until its 500 ms double-click timer expires.
    // Advance the mocked clock between chart interactions rather than sleeping.
    await page.clock.runFor(600)
    await expect.poll(() => page.evaluate(name => (window as unknown as { volatilityGears: Record<string, unknown> }).volatilityGears[name] !== undefined, name)).toBe(true)
    await waitForChartRender(page)
    const gear = await page.evaluate(name => (window as unknown as { volatilityGears: Record<string, { x: number; y: number }> }).volatilityGears[name], name)
    await page.mouse.click(gear.x + 7, gear.y + 7)
    for (const label of labels) await expect(settings.getByText(label, { exact: true })).toBeVisible()
    for (let i = 0; i < params.length; i++) {
      await settings.locator('input').nth(i).fill(params[i])
      await settings.locator('input').nth(i).blur()
    }
    const color = name === 'KC' ? '#aa00ff' : '#00cc88'
    await settings.locator('input[type="color"]').first().fill(color)
    await page.getByText('确定', { exact: true }).click()
  }
  await expect.poll(readPreferences).toMatchObject({
    main: expect.arrayContaining([expect.objectContaining({ name: 'KC', calcParams: [10, 2.25, 7], styles: expect.objectContaining({ lines: expect.arrayContaining([expect.objectContaining({ color: '#aa00ff' })]) }) })]),
    sub: expect.arrayContaining([expect.objectContaining({ indicators: [expect.objectContaining({ name: 'TTM_SQUEEZE', calcParams: [12, 2.5, 1.25], styles: expect.objectContaining({ bars: expect.arrayContaining([expect.objectContaining({ noChangeColor: '#00cc88' })]) }) })] })]),
  })
  const saved = await readPreferences()
  await expect.poll(inspect).toMatchObject({ kcColor: '#aa00ff', colors: expect.arrayContaining(['#00cc88']) })
  await expect.poll(() => page.evaluate(() => (window as unknown as { volatilityColors: string[] }).volatilityColors))
    .toEqual(expect.arrayContaining(['#00cc88', '#ef5350']))
  await page.reload()
  await expectCanvasContent(page)
  await expect.poll(readPreferences).toEqual(saved)
  await expect.poll(inspect).toMatchObject({ kc: true, ttm: true })
  await page.getByTestId('open-data-manager').click()
  const panel = page.getByTestId('backup-sync-panel')
  const downloadEvent = page.waitForEvent('download')
  await panel.getByRole('button', { name: '导出应用配置', exact: true }).click()
  const download = await downloadEvent
  const stream = await download.createReadStream()
  let json = ''
  for await (const chunk of stream) json += chunk.toString()
  const archive = JSON.parse(json)
  expect(archive.data.preferences.chartIndicators).toEqual(saved)
  // Import an edited archive, then refresh so stale chart state cannot overwrite it.
  archive.data.preferences.chartIndicators.main.find((value: { name: string }) => value.name === 'KC').calcParams = [8, 1.75, 5]
  page.once('dialog', dialog => dialog.accept())
  await panel.getByTestId('import-backup-file').setInputFiles({ name: 'indicators.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) })
  await expect(panel.getByTestId('backup-status')).toContainText('导入完成')
  await expect(panel.getByTestId('backup-status')).toContainText('刷新')
  await page.reload()
  await expectCanvasContent(page)
  await expect.poll(readPreferences).toEqual(archive.data.preferences.chartIndicators)
  await expect.poll(inspect).toMatchObject({ kc: true, kcColor: '#aa00ff', ttm: true, colors: expect.arrayContaining(['#00cc88']) })
  await page.getByText('指标', { exact: true }).click()
  await expect(row('KC(肯特纳通道)').locator('.klinecharts-pro-checkbox')).toHaveClass(/checked/)
  await expect(row('TTM Squeeze(挤压指标)').locator('.klinecharts-pro-checkbox')).toHaveClass(/checked/)
  await closeModal()
  await page.getByTestId('open-data-manager').click()
  const configureCloud = async () => {
    await panel.getByTestId('github-owner').fill('alice')
    await panel.getByTestId('github-repository').fill('trading-backup')
    await panel.getByTestId('github-token').fill('github_pat_e2e_secret')
    await panel.getByRole('checkbox', { name: '会话与交易', exact: true }).uncheck()
    await panel.getByRole('checkbox', { name: '历史行情', exact: true }).uncheck()
  }
  await configureCloud()
  await panel.getByTestId('github-upload').click()
  await expect(panel.getByTestId('backup-status')).toContainText('上传完成')
  expect(JSON.parse(github.files.get('config/preferences.json')!.bytes.toString()).chartIndicators).toEqual(archive.data.preferences.chartIndicators)
  const empty = structuredClone(archive)
  empty.data.preferences.chartIndicators = { schemaVersion: 1, main: [], sub: [] }
  page.once('dialog', dialog => dialog.accept())
  await panel.getByTestId('import-backup-file').setInputFiles({ name: 'empty.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(empty)) })
  await expect(panel.getByTestId('backup-status')).toContainText('导入完成')
  await page.reload()
  await expectCanvasContent(page)
  await expect.poll(readPreferences).toEqual(empty.data.preferences.chartIndicators)
  await page.getByTestId('open-data-manager').click()
  await configureCloud()
  page.once('dialog', dialog => dialog.accept())
  await panel.getByTestId('github-pull').click()
  await expect(panel.getByTestId('backup-status')).toContainText('云端恢复完成')
  await page.reload()
  await expectCanvasContent(page)
  await expect.poll(readPreferences).toEqual(archive.data.preferences.chartIndicators)
  await expect.poll(inspect).toMatchObject({ kc: true, ttm: true, legacyReady: true })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  // A late icon font load does not invalidate an already-painted canvas bitmap.
  await page.evaluate(() => (window as unknown as { __viewportTestAdapter: { resize(): void } }).__viewportTestAdapter.resize())
  await waitForChartRender(page)
  await page.screenshot({ path: 'test-results/ttm-squeeze-keltner.png' })
  expect(errors).toEqual([])
})

test('adds independent TTM Wave ABC panes and round-trips parameters and colors through JSON and cloud', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 1080 })
  await mockBinance(page, true)
  const github = await mockGitHub(page)
  await installViewportProbe(page)
  await page.addInitScript(() => {
    if (localStorage.getItem('chart.indicators.v1') === null) localStorage.setItem('chart.indicators.v1', JSON.stringify({
      schemaVersion: 1, main: [{ name: 'KC', calcParams: [20, 1.5, 20], visible: true, styles: null }],
      sub: [{ indicators: [{ name: 'TTM_SQUEEZE', calcParams: [20, 2, 1.5], visible: true, styles: null }] }],
    }))
    const gears: Record<string, { x: number; y: number }> = {}
    const titles = new WeakMap<HTMLCanvasElement, string>()
    Object.assign(window, { waveGears: gears })
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
      const match = /^TTM Wave ([ABC])/.exec(text)
      if (match) titles.set(this.canvas, match[1])
      const wave = titles.get(this.canvas)
      if (text === '\ue902' && wave) {
        const point = new DOMPoint(x, y).matrixTransform(this.getTransform())
        const rect = this.canvas.getBoundingClientRect()
        gears[wave] = { x: rect.left + point.x / devicePixelRatio, y: rect.top + point.y / devicePixelRatio }
      }
      return Reflect.apply(original, this, [text, x, y, ...args])
    }
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('./')
  await expectCanvasContent(page)
  const rows = page.locator('.klinecharts-pro-indicator-modal-list li.row')
  const closeModal = () => page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  await page.getByText('指标', { exact: true }).click()
  for (const label of ['TTM Wave A(短期波)', 'TTM Wave B(中期波)', 'TTM Wave C(长期波)']) {
    await rows.filter({ hasText: label }).click({ position: { x: 5, y: 20 } })
  }
  await closeModal()
  const preferences = () => page.evaluate(() => JSON.parse(localStorage.getItem('chart.indicators.v1')!))
  const plots = () => page.evaluate(() => {
    type Value = { wave1?: number; wave2?: number }
    type Plot = { name: string; calcParams: number[]; result: Value[]; styles?: { bars?: { positiveColor?: string; negativeColor?: string }[] }; figures: { styles?: (data: unknown, indicator: unknown) => { color: string } }[] }
    const core = (window as unknown as { __viewportTestAdapter: { coreChart: { getIndicatorByPaneId(): Map<string, Map<string, Plot>> } } }).__viewportTestAdapter.coreChart
    return [...core.getIndicatorByPaneId()].flatMap(([pane, indicators]) => [...indicators.values()]
      .filter(i => i.name.startsWith('TTM_WAVE_')).map(i => {
        const positive = new Set<string>(), negative = new Set<string>()
        for (const value of i.result) for (const [index, key] of (['wave1', 'wave2'] as const).entries()) {
          if (Number.isFinite(value[key])) (value[key]! >= 0 ? positive : negative).add(i.figures[index].styles!({ current: { indicatorData: value } }, i).color)
        }
        return { pane, name: i.name, params: i.calcParams,
        color: i.styles?.bars?.[0]?.positiveColor, negativeColor: i.styles?.bars?.[0]?.negativeColor,
        positive: [...positive], negative: [...negative],
        ready: i.result.some(v => Number.isFinite(v.wave1) && Number.isFinite(v.wave2) && v.wave1 !== 0),
      }}))
  })
  await expect.poll(plots).toEqual([
    expect.objectContaining({ name: 'TTM_WAVE_A', params: [8, 34, 55], ready: true }),
    expect.objectContaining({ name: 'TTM_WAVE_B', params: [8, 89, 144], ready: true }),
    expect.objectContaining({ name: 'TTM_WAVE_C', params: [8, 233, 377], ready: true }),
  ])
  expect(new Set((await plots()).map(p => p.pane)).size).toBe(3)
  for (const plot of await plots()) {
    const palettes: Record<string, { positive: string[]; negative: string[] }> = {
      TTM_WAVE_A: { positive: ['#168c72', '#9aefca'], negative: ['#d93654', '#ffadba'] },
      TTM_WAVE_B: { positive: ['#168a80', '#9ae9db'], negative: ['#dc4940', '#ffc0aa'] },
      TTM_WAVE_C: { positive: ['#1b966e', '#a7f2c8'], negative: ['#d33e62', '#ffb3ce'] },
    }
    expect(plot.positive).toEqual(expect.arrayContaining(palettes[plot.name].positive))
    expect(plot.negative).toEqual(expect.arrayContaining(palettes[plot.name].negative))
  }
  for (const [wave, params, color, negative] of [
    ['A', ['3', '13', '21'], '#12ab34', '#ed1234'], ['B', ['5', '34', '55'], '#34ab56', '#ed3456'], ['C', ['5', '89', '144'], '#56ab78', '#ed5678'],
  ] as const) {
    await page.clock.runFor(600)
    await expect.poll(() => page.evaluate(wave => (window as unknown as { waveGears: Record<string, unknown> }).waveGears[wave] !== undefined, wave)).toBe(true)
    const gear = await page.evaluate(wave => (window as unknown as { waveGears: Record<string, { x: number; y: number }> }).waveGears[wave], wave)
    await page.mouse.click(gear.x + 7, gear.y + 7)
    const settings = page.locator('.klinecharts-pro-indicator-setting-modal-content')
    for (const label of ['快线周期', '慢线一周期', '慢线二周期']) await expect(settings.getByText(label, { exact: true })).toBeVisible()
    for (let index = 0; index < 3; index++) {
      await settings.locator('input').nth(index).fill(params[index])
      await settings.locator('input').nth(index).blur()
    }
    await expect(settings.locator('input[type="color"]')).toHaveCount(4)
    await settings.getByLabel('波形一零线上方颜色', { exact: true }).fill(color)
    await settings.getByLabel('波形一零线下方颜色', { exact: true }).fill(negative)
    await page.getByText('确定', { exact: true }).click()
  }
  await expect.poll(plots).toEqual([
    expect.objectContaining({ name: 'TTM_WAVE_A', params: [3, 13, 21], color: '#12ab34', negativeColor: '#ed1234', negative: expect.arrayContaining(['#ed1234']), ready: true }),
    expect.objectContaining({ name: 'TTM_WAVE_B', params: [5, 34, 55], color: '#34ab56', negativeColor: '#ed3456', negative: expect.arrayContaining(['#ed3456']), ready: true }),
    expect.objectContaining({ name: 'TTM_WAVE_C', params: [5, 89, 144], color: '#56ab78', negativeColor: '#ed5678', negative: expect.arrayContaining(['#ed5678']), ready: true }),
  ])
  await expect.poll(preferences).toMatchObject({ sub: expect.arrayContaining([
    expect.objectContaining({ indicators: [expect.objectContaining({ name: 'TTM_WAVE_A', calcParams: [3, 13, 21], styles: expect.objectContaining({ bars: expect.arrayContaining([expect.objectContaining({ positiveColor: '#12ab34', negativeColor: '#ed1234' })]) }) })] }),
    expect.objectContaining({ indicators: [expect.objectContaining({ name: 'TTM_WAVE_B', calcParams: [5, 34, 55], styles: expect.objectContaining({ bars: expect.arrayContaining([expect.objectContaining({ positiveColor: '#34ab56', negativeColor: '#ed3456' })]) }) })] }),
    expect.objectContaining({ indicators: [expect.objectContaining({ name: 'TTM_WAVE_C', calcParams: [5, 89, 144], styles: expect.objectContaining({ bars: expect.arrayContaining([expect.objectContaining({ positiveColor: '#56ab78', negativeColor: '#ed5678' })]) }) })] }),
  ]) })
  const saved = await preferences()
  await page.reload()
  await expectCanvasContent(page)
  await expect.poll(preferences).toEqual(saved)
  // Removing B must leave A/C and their parameters untouched.
  await page.getByText('指标', { exact: true }).click()
  await rows.filter({ hasText: 'TTM Wave B(中期波)' }).click({ position: { x: 5, y: 20 } })
  await closeModal()
  await expect.poll(async () => (await plots()).map(i => i.name)).toEqual(['TTM_WAVE_A', 'TTM_WAVE_C'])
  await page.getByTestId('open-data-manager').click()
  const panel = page.getByTestId('backup-sync-panel')
  // Restore an exported archive from before B was removed.
  const downloadEvent = page.waitForEvent('download')
  await panel.getByRole('button', { name: '导出应用配置', exact: true }).click()
  const stream = await (await downloadEvent).createReadStream()
  let json = ''
  for await (const chunk of stream) json += chunk.toString()
  const archive = JSON.parse(json)
  archive.data.preferences.chartIndicators = saved
  page.once('dialog', dialog => dialog.accept())
  await panel.getByTestId('import-backup-file').setInputFiles({ name: 'waves.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) })
  await expect(panel.getByTestId('backup-status')).toContainText('导入完成')
  await page.reload()
  await expectCanvasContent(page)
  await expect.poll(preferences).toEqual(saved)
  await expect.poll(async () => (await plots()).filter(i => i.ready).length).toBe(3)
  const configureCloud = async () => {
    await panel.getByTestId('github-owner').fill('alice')
    await panel.getByTestId('github-repository').fill('trading-backup')
    await panel.getByTestId('github-token').fill('github_pat_e2e_secret')
    await panel.getByRole('checkbox', { name: '会话与交易', exact: true }).uncheck()
    await panel.getByRole('checkbox', { name: '历史行情', exact: true }).uncheck()
  }
  await page.getByTestId('open-data-manager').click()
  await configureCloud()
  await panel.getByTestId('github-upload').click()
  await expect(panel.getByTestId('backup-status')).toContainText('上传完成')
  expect(JSON.parse(github.files.get('config/preferences.json')!.bytes.toString()).chartIndicators).toEqual(saved)
  archive.data.preferences.chartIndicators = { schemaVersion: 1, main: [], sub: [] }
  page.once('dialog', dialog => dialog.accept())
  await panel.getByTestId('import-backup-file').setInputFiles({ name: 'empty.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) })
  await expect(panel.getByTestId('backup-status')).toContainText('导入完成')
  await page.reload()
  await expectCanvasContent(page)
  await page.getByTestId('open-data-manager').click()
  await configureCloud()
  page.once('dialog', dialog => dialog.accept())
  await panel.getByTestId('github-pull').click()
  await expect(panel.getByTestId('backup-status')).toContainText('云端恢复完成')
  await page.reload()
  await expectCanvasContent(page)
  await expect.poll(preferences).toEqual(saved)
  await expect.poll(async () => (await plots()).filter(i => i.ready).length).toBe(3)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.evaluate(() => (window as unknown as { __viewportTestAdapter: { resize(): void } }).__viewportTestAdapter.resize())
  await waitForChartRender(page)
  await page.screenshot({ path: 'test-results/ttm-wave-abc.png' })
  expect(errors).toEqual([])
})

test.describe('indicator settings dialog layout', () => {
  test.use({ hasTouch: true, isMobile: true })
  test('keeps indicator actions fixed while only parameters scroll across desktop and phone viewports', async ({ page }) => {
    test.setTimeout(90_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1138, height: 676 })
    await mockBinance(page)
    await mockGitHub(page)
    await page.addInitScript(defaults => {
      localStorage.setItem('chart.indicators.v1', JSON.stringify({ schemaVersion: 1, main: [{ name: 'PIVOTS', calcParams: defaults, visible: true, styles: null }], sub: [] }))
      const points: { x: number; y: number }[] = []
      Object.assign(window, { dialogGearPoints: points })
      const original = CanvasRenderingContext2D.prototype.fillText
      CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
        if (text === '\ue902') {
          const point = new DOMPoint(x, y).matrixTransform(this.getTransform())
          const rect = this.canvas.getBoundingClientRect()
          points.push({ x: rect.left + point.x / devicePixelRatio, y: rect.top + point.y / devicePixelRatio })
        }
        return Reflect.apply(original, this, [text, x, y, ...args])
      }
    }, [...PIVOTS_DEFAULT_PARAMS])
    await page.goto('./')
    await expectCanvasContent(page)
    await expect.poll(() => page.evaluate(() => (window as unknown as { dialogGearPoints: unknown[] }).dialogGearPoints.length)).toBeGreaterThan(0)
    const gear = (await page.evaluate(() => (window as unknown as { dialogGearPoints: { x: number; y: number }[] }).dialogGearPoints.at(-1)))!
    await page.mouse.click(gear.x + 3, gear.y + 3)
    const modal = page.locator('.klinecharts-pro-modal .inner')
    const settings = modal.locator('.klinecharts-pro-indicator-setting-modal-content')
    const confirm = modal.getByRole('button', { name: '确定', exact: true })
    await expect(confirm).toBeInViewport({ ratio: 1, timeout: 1500 })
    const draft = settings.locator('.klinecharts-pro-input input').first()
    await draft.fill('17')
    const cdp = await page.context().newCDPSession(page)
    for (const viewport of [{ width: 1138, height: 676 }, { width: 390, height: 844 }, { width: 320, height: 740 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport)
      await expect(confirm).toBeInViewport({ ratio: 1 })
      await expect(modal.locator('.close-icon')).toBeInViewport({ ratio: 1 })
      await expect(draft).toHaveValue('17')
      const box = (await modal.boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
      const body = modal.locator(':scope > .content-container')
      const bodyBox = (await body.boundingBox())!
      const buttonBefore = (await confirm.boundingBox())!
      const headerBefore = (await modal.locator('.title-container').boundingBox())!
      const x = bodyBox.x + 8
      const touch = viewport.width < 768 || viewport.height < 520
      const swipe = async (up: boolean) => {
        const low = bodyBox.y + bodyBox.height - 24, high = bodyBox.y + 24
        const start = up ? low : high, end = up ? high : low
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] })
        for (let step = 1; step <= 8; step++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + (end - start) * step / 8 }] })
          await page.waitForTimeout(16)
        }
        // Hold the finger still before lifting to end the drag without a fling.
        await page.waitForTimeout(120)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: end }] })
        await page.waitForTimeout(16)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      }
      if (touch) {
        for (let attempt = 0; attempt < 6 && await body.evaluate(el => el.scrollTop) > 0; attempt++) await swipe(false)
      } else {
        await page.mouse.move(x, bodyBox.y + bodyBox.height / 2)
        await page.mouse.wheel(0, -10000)
      }
      await expect.poll(() => body.evaluate(el => el.scrollTop), { message: `parameter scroll reset at ${viewport.width}x${viewport.height}` }).toBe(0)
      if (touch) {
        await swipe(true)
        await expect.poll(() => body.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
        for (let attempt = 0; attempt < 8 && await body.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop) > 1; attempt++) await swipe(true)
      } else {
        await page.mouse.wheel(0, 10000)
      }
      await expect(settings.getByLabel('上期 S 颜色', { exact: true })).toBeInViewport({ ratio: 1 })
      await expect(confirm).toBeInViewport({ ratio: 1 })
      expect((await confirm.boundingBox())!.y).toBeCloseTo(buttonBefore.y, 0)
      expect((await modal.locator('.title-container').boundingBox())!.y).toBeCloseTo(headerBefore.y, 0)
      if (viewport.width === 1138 || viewport.width === 390) await page.screenshot({ path: test.info().outputPath(`indicator-settings-${viewport.width}.png`) })
    }
    // A software keyboard reduces the visual viewport without resizing layout.
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'height', { configurable: true, get: () => 220 })
      window.visualViewport!.dispatchEvent(new Event('resize'))
    })
    await expect.poll(async () => {
      const box = (await modal.boundingBox())!
      return box.y >= 0 && box.y + box.height <= 220
    }).toBe(true)
    await expect(confirm).toBeInViewport({ ratio: 1 })
    await expect(modal.locator('.close-icon')).toBeInViewport({ ratio: 1 })
    await confirm.tap()
    await expect(modal).toBeHidden({ timeout: 2000 })
    await page.evaluate(() => {
      Reflect.deleteProperty(window.visualViewport!, 'height')
      window.visualViewport!.dispatchEvent(new Event('resize'))
    })
    expect(errors).toEqual([])
    await cdp.detach()
  })
})

test('renders standard pivot levels and persists type, timeframe, labels and level settings', async ({ page }) => {
  test.setTimeout(120_000)
  await mockBinance(page, true)
  const github = await mockGitHub(page)
  await installViewportProbe(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript((defaults) => {
    if (!localStorage.getItem('pivots-test-seeded')) {
      localStorage.setItem('pivots-test-seeded', 'true')
      defaults[1] = 'Daily'
      defaults[2] = 3
      localStorage.setItem('chart.indicators.v1', JSON.stringify({
        schemaVersion: 1, main: [{ name: 'PIVOTS', calcParams: defaults, visible: true, styles: null }], sub: [],
      }))
    }
    const drawn: string[] = []
    const titles: string[] = []
    const settings: { x: number; y: number }[] = []
    const strokes = new Set<string>()
    Object.assign(window, { pivotTestLabels: drawn, pivotTestTitles: titles, pivotTestSettings: settings, pivotStrokes: strokes })
    const stroke = CanvasRenderingContext2D.prototype.stroke
    CanvasRenderingContext2D.prototype.stroke = function (...args: unknown[]) {
      strokes.add(`${this.strokeStyle}:${this.getLineDash().length ? 'dashed' : 'solid'}`)
      return Reflect.apply(stroke, this, args)
    }
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (/^(P|[RS][1-5]) \(/.test(text)) drawn.push(text)
      if (/^Pivots|^(P|[RS][1-5]):/.test(text)) titles.push(text)
      if (text === '\ue902') {
        const point = new DOMPoint(x, y).matrixTransform(this.getTransform())
        const rect = this.canvas.getBoundingClientRect()
        settings.push({ x: rect.left + point.x / devicePixelRatio, y: rect.top + point.y / devicePixelRatio })
      }
      if (maxWidth === undefined) original.call(this, text, x, y)
      else original.call(this, text, x, y, maxWidth)
    }
  }, [...PIVOTS_DEFAULT_PARAMS])
  await page.goto('./')
  await expectCanvasContent(page)
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { pivotTestLabels: string[] }).pivotTestLabels.some((label) => label.startsWith('P (')),
  )).toBe(true)
  await expect.poll(() => page.evaluate(() => [...new Set(
    (window as unknown as { pivotTestTitles: string[] }).pivotTestTitles,
  )])).toEqual(['Pivots'])
  await expect(page.locator('.klinecharts-pro-period-bar .period.selected')).toHaveText('15m')
  const readPivots = () => page.evaluate(() => JSON.parse(localStorage.getItem('chart.indicators.v1')!).main.find((item: { name: string }) => item.name === 'PIVOTS'))
  const gear = await page.evaluate(() =>
    (window as unknown as { pivotTestSettings: { x: number; y: number }[] }).pivotTestSettings.at(-1),
  )
  expect(gear).toBeDefined()
  await page.mouse.click(gear!.x + 3, gear!.y + 3)
  const settings = page.locator('.klinecharts-pro-indicator-setting-modal-content')
  await expect(settings.getByLabel('枢轴类型')).toHaveValue('Traditional')
  await expect(settings.locator('input[type="color"]')).toHaveCount(6)
  await expect(settings.getByLabel('R1 颜色', { exact: true })).toHaveCount(0)
  await expect(settings.getByLabel('上期 R 颜色', { exact: true })).toBeDisabled()
  await settings.getByLabel('当前周期显示上期线', { exact: true }).check()
  await expect(settings.getByLabel('上期 R 颜色', { exact: true })).toBeEnabled()
  await settings.getByLabel('上期 R 颜色', { exact: true }).fill('#ab12cd')
  await settings.getByLabel('枢轴类型').selectOption('DM')
  await expect(settings.getByLabel('R2 显示', { exact: true })).toBeDisabled()
  await settings.getByLabel('枢轴类型').selectOption('Camarilla')
  await expect(settings.getByLabel('R5 显示', { exact: true })).toBeEnabled()
  await settings.getByLabel('枢轴周期').selectOption('Weekly')
  await settings.locator('.klinecharts-pro-input input').nth(0).fill('2')
  await settings.locator('.klinecharts-pro-input input').nth(0).blur()
  await settings.getByLabel('显示标签', { exact: true }).uncheck()
  await settings.getByLabel('标签位置').selectOption('Right')
  await settings.locator('.klinecharts-pro-input input').nth(1).fill('2')
  await settings.locator('.klinecharts-pro-input input').nth(1).blur()
  await settings.getByLabel('P 显示', { exact: true }).uncheck()
  await settings.getByLabel('R 颜色', { exact: true }).fill('#12abcd')
  await page.getByText('确定', { exact: true }).click()
  await expect.poll(async () => (await readPivots()).calcParams.slice(0, 10))
    .toEqual(['Camarilla', 'Weekly', 2, true, false, true, 'Right', 2, false, '#fb8c00'])
  await page.reload()
  await expectCanvasContent(page)
  await expect.poll(async () => (await readPivots()).calcParams.slice(30)).toEqual(['#fb8c00', '#12abcd', '#26a69a', true, '#a78bfa', '#ab12cd', '#38bdf8'])
  const hasPrevious = () => page.evaluate(() => {
    type Value = { segment?: { previous?: unknown }; projection?: { previous?: unknown } }
    const core = (window as unknown as { __viewportTestAdapter: { coreChart: { getIndicatorByPaneId(pane: string, name: string): { result: Value[] } } } }).__viewportTestAdapter.coreChart
    return core.getIndicatorByPaneId('candle_pane', 'PIVOTS').result.some(value => value.segment?.previous || value.projection?.previous)
  })
  await expect.poll(hasPrevious).toBe(true)
  await expect.poll(() => page.evaluate(() => [...(window as unknown as { pivotStrokes: Set<string> }).pivotStrokes]))
    .toEqual(expect.arrayContaining(['#12abcd:solid', '#ab12cd:dashed']))
  await expect(page.locator('.klinecharts-pro-period-bar .period.selected')).toHaveText('15m')
  await page.getByText('指标', { exact: true }).click()
  const row = page.locator('.klinecharts-pro-indicator-modal-list li.row').filter({ hasText: 'Pivots(标准枢轴点)' })
  await expect(row.locator('.klinecharts-pro-checkbox')).toHaveClass(/checked/)
  await page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  expect((await readPivots()).calcParams.slice(0, 3)).toEqual(['Camarilla', 'Weekly', 2])
  const saved = await readPivots()
  await page.getByTestId('open-data-manager').click()
  const panel = page.getByTestId('backup-sync-panel')
  const configureCloud = async () => {
    await panel.getByTestId('github-owner').fill('alice')
    await panel.getByTestId('github-repository').fill('trading-backup')
    await panel.getByTestId('github-token').fill('github_pat_e2e_secret')
    await panel.getByRole('checkbox', { name: '会话与交易', exact: true }).uncheck()
    await panel.getByRole('checkbox', { name: '历史行情', exact: true }).uncheck()
  }
  await configureCloud()
  await panel.getByTestId('github-upload').click()
  await expect(panel.getByTestId('backup-status')).toContainText('上传完成')
  expect(JSON.parse(github.files.get('config/preferences.json')!.bytes.toString()).chartIndicators.main[0]).toEqual(saved)
  const downloadEvent = page.waitForEvent('download')
  await panel.getByRole('button', { name: '导出应用配置', exact: true }).click()
  const stream = await (await downloadEvent).createReadStream()
  let json = ''
  for await (const chunk of stream) json += chunk.toString()
  const archive = JSON.parse(json)
  archive.data.preferences.chartIndicators.main[0].calcParams[33] = false
  page.once('dialog', dialog => dialog.accept())
  await panel.getByTestId('import-backup-file').setInputFiles({ name: 'pivots.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) })
  await expect(panel.getByTestId('backup-status')).toContainText('导入完成')
  await page.reload()
  await expectCanvasContent(page)
  await expect.poll(async () => (await readPivots()).calcParams[33]).toBe(false)
  await expect.poll(hasPrevious).toBe(false)
  await page.getByTestId('open-data-manager').click()
  await configureCloud()
  page.once('dialog', dialog => dialog.accept())
  await panel.getByTestId('github-pull').click()
  await expect(panel.getByTestId('backup-status')).toContainText('云端恢复完成')
  await page.reload()
  await expectCanvasContent(page)
  await expect.poll(readPivots).toEqual(saved)
  await expect.poll(hasPrevious).toBe(true)
  await page.screenshot({ path: 'test-results/pivots-groups-previous.png' })
  expect(errors).toEqual([])
})

test('stops remote requests after HTTP 418 and keeps cached chart data usable', async ({ page }) => {
  await page.clock.install()
  await page.setViewportSize({ width: 1146, height: 900 })
  await mockBinance(page)
  const runtimeErrors: string[] = []
  page.on('pageerror', (error) => runtimeErrors.push(error.message))
  await page.goto('./')
  await expectCanvasContent(page)
  let banRequests = 0
  await page.route('https://fapi.binance.com/**', async (route) => {
    banRequests += 1
    await route.fulfill({
      status: 418,
      headers: { 'Retry-After': '120' },
      json: { code: -1003, msg: 'IP banned' },
    })
  })
  // Other chart periods reuse the same minutes; reveal a new closed minute
  // so this switch exercises a real recent REST gap and the injected ban.
  await page.clock.fastForward(60_000)
  const selector = page.getByLabel('图表周期')
  await selectChartPeriod(page, '1m')
  await expect(page.locator('.status-footer')).toContainText('HTTP 418')
  await expect(page.locator('.status-footer')).toContainText('已暂停新增远程请求')
  for (const timeframe of ['1w', '1M', '15m']) {
    await selectChartPeriod(page, timeframe)
    await expect(page.locator('.status-footer')).toContainText(`BTCUSDT · ${timeframe}`)
  }
  await expectCanvasContent(page)
  await page.getByTestId('open-data-manager').click()
  await expect(page.getByTestId('data-manager').getByRole('alert')).toContainText('HTTP 418')
  expect(banRequests).toBe(1)
  await page.reload()
  await expect(page.locator('.status-footer')).toContainText('HTTP 418')
  expect(banRequests).toBe(1)

  const otherPage = await page.context().newPage()
  await installArchiveFixtures(otherPage)
  await otherPage.route('https://fapi.binance.com/**', async (route) => {
    banRequests += 1
    await route.fulfill({ status: 418, json: {} })
  })
  await otherPage.goto('./')
  await expect(otherPage.locator('.status-footer')).toContainText('HTTP 418')
  expect(banRequests).toBe(1)
  await otherPage.close()

  await page.getByTestId('open-data-manager').click()
  const protection = page.getByRole('region', { name: '行情请求保护' })
  const resume = protection.getByRole('button', { name: '手动恢复远程请求' })
  await expect(resume).toBeDisabled()
  await page.clock.fastForward(31 * 60_000)
  await expect(resume).toBeEnabled()
  await expect(protection).toContainText('不会自动恢复')
  expect(banRequests).toBe(1)
  await resume.click()
  await expect(protection).toContainText('保守限速已启用')
  expect(banRequests).toBe(1)
  expect(runtimeErrors).toEqual([])
})

test('prevents parallel requests from another page while one page holds the request lock', async ({ page }) => {
  await mockBinance(page)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const ready = new Promise<void>((resolve) => { started = resolve })
  await page.route('https://fapi.binance.com/**', async (route) => {
    started()
    await gate
    await route.fallback()
  })
  await page.goto('./')
  await ready
  const otherPage = await page.context().newPage()
  await installArchiveFixtures(otherPage)
  let otherRequests = 0
  await otherPage.route('https://fapi.binance.com/**', async (route) => {
    otherRequests += 1
    await route.fulfill({ json: [] })
  })
  await otherPage.goto('./')
  await expect(otherPage.locator('.status-footer')).toContainText('其他页面正在请求')
  expect(otherRequests).toBe(0)
  release()
  await expectCanvasContent(page)
  await otherPage.close()
})
