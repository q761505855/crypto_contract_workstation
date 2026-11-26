import { expect, test, type Page } from '@playwright/test'
import { zstdCompressSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { connectFixture } from './ctrader-fixture'
import { installViewportProbe } from './viewport-probe'
import { tradeDbn } from '../src/market-data/databento/dbn-test-fixture'

const filename = (day: string) => `glbx-mdp3-${day.replaceAll('-', '')}.trades.dbn.zst`

async function connectDirectory(page: Page, files: Record<string, Buffer>) {
  await connectFixture(page)
  const chart = await installViewportProbe(page)
  await page.clock.setFixedTime(new Date('2026-11-25T16:00:00Z'))
  await page.route('**/fixture/archives/*', route => route.fulfill({
    contentType: 'application/octet-stream',
    body: files[new URL(route.request().url()).pathname.split('/').at(-1)!],
  }))
  await page.addInitScript(names => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async (options: { mode: string }) => {
      if (options.mode !== 'read') throw new Error('Expected read-only access')
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('databento', { create: true })
      const product = await root.getDirectoryHandle('NQ.FUT', { create: true })
      await root.getDirectoryHandle('ES.FUT', { create: true })
      for (const name of names) {
        const handle = await product.getFileHandle(name, { create: true })
        const file = await handle.getFile()
        if (file.size) continue
        const writer = await handle.createWritable()
        await (await fetch(`/fixture/archives/${name}`)).body!.pipeTo(writer)
      }
      return root
    } })
  }, Object.keys(files))
  await page.goto('/')
  await page.getByLabel('行情来源').selectOption('databento-cme')
  await page.getByRole('button', { name: '本地数据管理', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Databento-CME 本地数据' })
  await dialog.getByRole('button', { name: '选择文件夹' }).click()
  return { chart, dialog }
}

test('Databento uses the preceding Chicago session, only loads selected dates, and replays without downloads', async ({ page }) => {
  const day = '2026-11-23'
  const time = Date.parse(`${day}T15:00:00Z`)
  const startAfterEvening = Date.parse('2026-11-19T23:01:00Z')
  const friday = Date.parse('2026-11-20T15:00:00Z')
  const files = {
    [filename('2026-11-17')]: Buffer.from('invalid archive'),
    [filename('2026-11-19')]: zstdCompressSync(tradeDbn([['NQH7', startAfterEvening, 26300, 2_000, 'B']])),
    [filename('2026-11-20')]: zstdCompressSync(tradeDbn([['NQZ6', friday, 26000, 1_000, 'B'], ['NQH7', friday, 26300, 10, 'B']])),
    [filename(day)]: zstdCompressSync(tradeDbn([
      ['NQZ6', time, 26000, 10_000, 'B'],
      ['NQZ6-NQH7', time, 300, 100_000, 'A'],
      ...Array.from({ length: 45 }, (_, index): [string, number, number, number, string] =>
        ['NQH7', time + index * 60_000, 26300 + index, 1, 'A']),
    ])),
  }
  const { dialog, chart } = await connectDirectory(page, files)
  await expect(dialog.getByRole('heading', { name: 'ES.FUT 日档' })).toBeVisible()
  await dialog.getByRole('button', { name: '关闭Databento-CME 本地数据' }).click()
  const chartHost = page.getByTestId('chart-host')
  await chartHost.getByText('ES.FUT', { exact: true }).first().click()
  const picker = page.getByRole('dialog', { name: '选择交易对' })
  await expect(picker.getByText('NQ.FUT', { exact: true }).first()).toBeVisible()
  await picker.getByText('NQ.FUT', { exact: true }).first().click()
  const anchorButton = chartHost.getByRole('button', { name: '按锚点加载', exact: true })
  await anchorButton.click()
  const anchor = page.getByRole('dialog', { name: '按锚点加载本地成交' })
  await expect(page.getByLabel('行情来源')).toHaveCSS('color-scheme', 'dark')
  for (const field of ['锚点日期', '往前天数', '往后天数']) {
    await expect(anchor.getByLabel(field)).toHaveCSS('color-scheme', 'dark')
  }
  await expect(anchor.getByLabel('锚点日期')).toHaveValue(day)
  await anchor.getByLabel('往前天数').fill('1')
  await expect(anchor.getByRole('status')).toContainText('已有 1 个日档')
  await anchor.getByRole('button', { name: '加载本地日档', exact: true }).click()
  await expect(anchor).toBeHidden()
  await expect.poll(async () => (await chart()).last?.close).toBe(26344)
  await expect(page.locator('.candle-summary strong')).toHaveText('26,344.00')
  const candleDisplay = await page.evaluate(() => {
    const adapter = (window as unknown as { __viewportTestAdapter: {
      coreChart: import('klinecharts').Chart
      getSymbol(): import('@klinecharts/pro').SymbolInfo
    } }).__viewportTestAdapter
    const chart = adapter.coreChart
    const latest = chart.getDataList().at(-1)!
    const { x } = chart.convertToPixel({ timestamp: latest.timestamp }, { paneId: 'candle_pane' }) as { x: number }
    return { display: chart.getPriceVolumePrecision().price, data: adapter.getSymbol().pricePrecision, x }
  })
  expect(candleDisplay).toMatchObject({ display: 2, data: 9 })
  const plot = (await page.getByLabel('最新 K 线').locator('..').boundingBox())!
  await page.mouse.move(plot.x + candleDisplay.x, plot.y + plot.height / 2)
  const details = page.getByLabel('选中 K 线')
  await expect(details).toBeVisible()
  await expect(details.locator('dd').nth(3)).toHaveText('26,344.00')
  const rightmost = (await chart()).rightmost
  expect(rightmost).not.toBeNull()
  await anchorButton.click()
  await expect(anchor.getByLabel('锚点日期')).toHaveValue(day)
  await expect(anchor.getByRole('status')).toContainText('已全部加载')
  await expect(anchor.getByRole('button', { name: '加载本地日档', exact: true })).toBeDisabled()
  await anchor.getByLabel('锚点日期').fill('2026-11-20')
  await anchor.getByRole('button', { name: '加载本地日档', exact: true }).click()
  await expect(anchor).toBeHidden()
  await expect.poll(async () => (await chart()).rightmost).toBe(rightmost)
  await anchorButton.click()
  await anchor.getByLabel('锚点日期').fill('2026-11-17')
  await anchor.getByRole('button', { name: '加载本地日档', exact: true }).click()
  await expect(anchor.getByRole('alert')).toContainText(filename('2026-11-17'))
  await anchor.getByRole('button', { name: '关闭按锚点加载本地成交' }).click()
  await expect.poll(async () => (await chart()).rightmost).toBe(rightmost)
  await page.getByRole('button', { name: '本地数据管理', exact: true }).click()
  await expect(dialog.getByRole('list', { name: '本地 DBN 文件' })).toContainText(filename(day))
  await expect(page.getByRole('button', { name: '下载成交数据' })).toHaveCount(0)
  await expect(dialog.getByRole('checkbox', { name: day })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: '2026-11-17' })).not.toBeChecked()
  await dialog.getByRole('checkbox', { name: '2026-11-20' }).uncheck()
  await dialog.getByRole('button', { name: '加载所选日期' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await chart()).last).toMatchObject({ open: 26330, close: 26344, low: 26330, volume: 15 })
  expect((await chart()).timestamps).toEqual([time, time + 15 * 60_000, time + 30 * 60_000])
  await expect(page.locator('#workspace-status-content')).toContainText('实际合约 NQH7')

  const controls = page.getByTestId('replay-controls')
  await controls.getByRole('button', { name: '时间定位', exact: true }).click()
  const jump = page.getByRole('dialog', { name: '图表时间定位' })
  const displayTime = await page.evaluate(time => new Date(time - new Date(time).getTimezoneOffset() * 60_000).toISOString().slice(0, 16), time)
  await jump.getByLabel('图表跳转时间').fill(displayTime)
  await jump.getByRole('button', { name: '跳转', exact: true }).click()
  await expect(controls.locator('.replay-start-time')).toContainText(displayTime.replace('T', ' '))
  await controls.getByRole('button', { name: '创建回放', exact: true }).click()
  await expect(controls).toContainText('第 1 步')
  await controls.getByRole('button', { name: '下一根', exact: true }).click()
  await expect(controls).toContainText('第 2 步')
  await expect.poll(async () => (await chart()).last?.close).toBe(26315)
  await expect(page.locator('.candle-summary strong')).toHaveText('26,315.00')
  const orderFlow = await page.evaluate(async time => {
    const { source } = (window as unknown as { __viewportTestAdapter: {
      source: import('../src/market-data/bybit/combined-source').CombinedBybitSource
    } }).__viewportTestAdapter
    const trades: { venue?: string; price: number }[] = []
    const complete = await source.visitTrades({ fromUs: time * 1000, untilUs: (time + 45 * 60_000) * 1000 },
      trade => trades.push({ venue: trade.venue, price: trade.price }), new AbortController().signal)
    return { complete, count: trades.length, first: trades[0], last: trades.at(-1) }
  }, time)
  expect(orderFlow).toEqual({ complete: true, count: 16, first: { venue: 'CME', price: 26300 }, last: { venue: 'CME', price: 26315 } })
  await anchorButton.click()
  await anchor.getByLabel('锚点日期').fill('2026-11-20')
  await anchor.getByRole('button', { name: '加载本地日档', exact: true }).click()
  await expect(anchor).toBeHidden()
  await expect(page.locator('#workspace-status-content')).toContainText('已追加 1 个日档（UTC 2026-11-20）')
  await expect(controls).toContainText('第 2 步')
  await expect.poll(async () => (await chart()).last?.close).toBe(26315)
  await page.reload()
  await expect(page.getByLabel('行情来源')).toHaveValue('databento-cme')
  await expect(page.locator('#workspace-status-content')).toContainText('NQ.FUT')
  await expect.poll(async () => (await chart()).timestamps).toEqual([])
  await page.setViewportSize({ width: 320, height: 740 })
  const source = await page.getByLabel('行情来源').boundingBox()
  const tools = await page.getByRole('button', { name: '工具', exact: true }).boundingBox()
  expect(Math.abs((source!.y + source!.height / 2) - (tools!.y + tools!.height / 2))).toBeLessThan(3)
})

test('loads the supplied CME sample in Chromium', async ({ page }) => {
  const supplied = process.env.DATABENTO_E2E_DIRECTORY
  test.skip(!supplied, 'Set DATABENTO_E2E_DIRECTORY to an NQ.FUT folder to verify the real archive')
  test.setTimeout(90_000)
  const day = '2026-11-23'
  const files = Object.fromEntries(await Promise.all(['2026-11-19', '2026-11-20', '2026-11-22', day].map(async date => {
    const name = filename(date)
    return [name, await readFile(join(supplied!, name))]
  })))
  const { dialog, chart } = await connectDirectory(page, files)
  await expect(dialog.getByRole('heading', { name: 'ES.FUT 日档' })).toBeVisible()
  await dialog.getByRole('button', { name: '关闭Databento-CME 本地数据' }).click()
  await page.getByTestId('chart-host').getByText('ES.FUT', { exact: true }).first().click()
  await page.getByRole('dialog', { name: '选择交易对' }).getByText('NQ.FUT', { exact: true }).first().click()
  await page.getByRole('button', { name: '本地数据管理', exact: true }).click()
  await dialog.getByRole('checkbox', { name: day }).check()
  await dialog.getByRole('button', { name: '加载所选日期' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await chart()).timestamps.length).toBeGreaterThan(60)
  await expect.poll(async () => (await chart()).last?.close).toBeGreaterThan(25_000)
  await expect(page.locator('#workspace-status-content')).toContainText('实际合约 NQZ6')

  const before = await chart()
  const sunday = Date.parse('2026-11-22T00:00:00Z')
  expect(before.timestamps[0]).toBeGreaterThan(sunday)
  await page.getByRole('button', { name: '按锚点加载', exact: true }).click()
  const anchor = page.getByRole('dialog', { name: '按锚点加载本地成交' })
  await expect(anchor.getByLabel('锚点日期')).toHaveValue(day)
  await anchor.getByLabel('往前天数').fill('2')
  await expect(anchor.getByRole('status')).toContainText('已有 2 个日档')
  await expect(anchor.getByRole('status')).toContainText('1 个待加载')
  await anchor.getByRole('button', { name: '加载本地日档', exact: true }).click()
  const firstAppendedBar = Date.parse('2026-11-22T23:00:00Z')
  await expect.poll(async () => (await chart()).first).toMatchObject({ timestamp: firstAppendedBar, low: 25_426.75 })
  expect((await chart()).timestamps.filter(timestamp => timestamp < before.timestamps[0])).toHaveLength(4)
  await expect.poll(async () => (await chart()).rightmost).toBe(before.rightmost)
  await expect(anchor).toBeHidden({ timeout: 4000 })
  await expect(page.locator('#workspace-status-content')).toContainText('已追加 1 个日档')
  await expect(page.locator('#workspace-status-content')).toContainText('北京时间 2026-11-23 07:00 至 07:45')
  await expect(page.getByRole('button', { name: '定位新增', exact: true })).toHaveCount(0)

  const controls = page.getByTestId('replay-controls')
  await controls.getByRole('button', { name: '时间定位', exact: true }).click()
  const jump = page.getByRole('dialog', { name: '图表时间定位' })
  const start = await page.evaluate(() => {
    const time = new Date('2026-11-23T15:00:00Z')
    return new Date(time.getTime() - time.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  })
  await jump.getByLabel('图表跳转时间').fill(start)
  await jump.getByRole('button', { name: '跳转', exact: true }).click()
  await expect(controls.locator('.replay-start-time')).toContainText(start.replace('T', ' '))
  await controls.getByLabel('回放模式').selectOption('tick')
  await controls.getByRole('button', { name: '创建回放', exact: true }).click()
  await expect(controls).toContainText('第 1 步')
  await controls.getByLabel('逐笔速度滑块').press('End')
  await controls.getByRole('button', { name: '播放', exact: true }).click()
  await expect.poll(async () => Number((await controls.locator('.replay-position > span').textContent())?.match(/\d+/)?.[0]))
    .toBeGreaterThan(500)
  await controls.getByRole('button', { name: '暂停', exact: true }).click()
  await expect.poll(async () => (await chart()).last!.timestamp).toBeGreaterThan(Date.parse('2026-11-23T15:00:00Z'))
})

test('Databento plays each trade with snapped and typed speeds and restores the paused session', async ({ page }) => {
  const day = '2026-11-23'
  const start = Date.parse(`${day}T15:00:00Z`)
  const at = start + 15 * 60_000
  const { dialog, chart } = await connectDirectory(page, {
    [filename(day)]: zstdCompressSync(tradeDbn([
      ['NQZ6', start, 26000, 1, 'B'],
      ['NQZ6', at + 200, 26001, 2, 'A'],
      ['NQZ6', at + 200, 26002, 3, 'N'],
      ['NQZ6', at + 90_000, 26003, 4, 'B'],
    ])),
  })
  const localData = page.getByRole('button', { name: '本地数据管理', exact: true })
  async function loadDay() {
    await localData.click()
    await dialog.getByRole('checkbox', { name: day }).check()
    await dialog.getByRole('button', { name: '加载所选日期' }).click()
    await expect(dialog).toBeHidden()
  }
  await dialog.getByRole('button', { name: '关闭Databento-CME 本地数据' }).click()
  await page.getByTestId('chart-host').getByText('ES.FUT', { exact: true }).first().click()
  await page.getByRole('dialog', { name: '选择交易对' }).getByText('NQ.FUT', { exact: true }).first().click()
  await loadDay()
  await expect.poll(async () => (await chart()).last?.close).toBe(26003)

  const controls = page.getByTestId('replay-controls')
  await controls.getByRole('button', { name: '时间定位', exact: true }).click()
  const jump = page.getByRole('dialog', { name: '图表时间定位' })
  const time = await page.evaluate(value => new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16), start)
  await jump.getByLabel('图表跳转时间').fill(time)
  await jump.getByRole('button', { name: '跳转', exact: true }).click()
  await expect(controls.locator('.replay-start-time')).toContainText(time.replace('T', ' '))
  const mode = controls.getByLabel('回放模式')
  await mode.selectOption('tick')
  await controls.getByRole('button', { name: '创建回放', exact: true }).click()
  const speed = controls.getByRole('spinbutton', { name: '逐笔回放速度' })
  const slider = controls.getByRole('slider', { name: '逐笔速度滑块' })
  await expect(speed).toHaveValue('1')
  await expect(controls.getByRole('button', { name: '下一根', exact: true })).toHaveCount(0)
  await expect(controls.getByRole('button', { name: '上一根', exact: true })).toHaveCount(0)
  await controls.getByRole('button', { name: '播放', exact: true }).click()
  await expect(controls).toContainText('第 3 步')
  await controls.getByRole('button', { name: '暂停', exact: true }).click()
  await expect.poll(async () => (await chart()).last).toMatchObject({ timestamp: at, high: 26002, close: 26002, volume: 5 })
  await expect.poll(() => page.evaluate(() => {
    const { source } = (window as unknown as { __viewportTestAdapter: {
      source: import('../src/market-data/bybit/combined-source').CombinedBybitSource
    } }).__viewportTestAdapter
    return source.tradeCursorUs
  })).toBe((at + 200) * 1000 + 1)
  await slider.press('Home')
  await expect(speed).toHaveValue('0.1')
  await speed.fill('0.05')
  await expect(speed).toHaveAttribute('aria-invalid', 'true')
  await speed.press('Enter')
  await expect(speed).toHaveValue('0.1')
  await slider.press('End')
  await expect(speed).toHaveValue('1000')
  await controls.getByRole('button', { name: '播放', exact: true }).click()
  await expect(controls).toContainText('第 4 步')
  await controls.getByRole('button', { name: '暂停', exact: true }).click()
  await expect.poll(async () => (await chart()).last).toMatchObject({ timestamp: at, high: 26003, close: 26003, volume: 9 })
  await speed.fill('1.25')
  await speed.press('Enter')
  await expect(slider).toHaveAttribute('aria-valuetext', '1.25×')
  await mode.selectOption('kline')
  const steps = controls.getByLabel('步进周期')
  await expect(steps.getByRole('option', { name: '1s', exact: true })).toHaveCount(1)
  await expect(steps.getByRole('option', { name: '1d', exact: true })).toHaveCount(1)
  await expect(controls.getByLabel('回放速度')).toHaveValue('1')
  await mode.selectOption('tick')
  await expect(speed).toHaveValue('1.25')

  await page.reload()
  await loadDay()
  await controls.getByRole('button', { name: '回放设置', exact: true }).click()
  await page.getByRole('button', { name: '加载会话', exact: true }).click()
  await expect(mode).toHaveValue('tick')
  await expect(speed).toHaveValue('1.25')
  await expect(controls).toContainText('第 4 步')
  await expect(controls.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await expect.poll(async () => (await chart()).last?.close).toBe(26003)
})
