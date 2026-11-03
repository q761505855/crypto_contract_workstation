import { expect, test } from '@playwright/test'
import { alignOpenTime, nextOpenTime } from '../src/market-data/intervals'
import { PIVOTS_DEFAULT_PARAMS } from '../src/chart/pivots'

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

async function mockBinance(page: import('@playwright/test').Page, pacedClock = false) {
  if (pacedClock) await page.clock.install()
  await page.routeWebSocket('wss://fstream.binance.com/**', (socket) => {
    const streams = new URL(socket.url()).searchParams.get('streams') ?? ''
    const streamMatch = /^([^@/]+)@kline_([^/]+)/.exec(streams)
    if (streamMatch === null) {
      throw new Error(`Unexpected Binance WebSocket URL: ${socket.url()}`)
    }
    const symbol = streamMatch[1].toUpperCase()
    const timeframe = streamMatch[2]
    const interval = intervalMilliseconds[timeframe]
    const eventTime = Date.now()
    const openTime = Math.floor(eventTime / interval) * interval
    const kline = {
      t: openTime,
      T: openTime + interval - 1,
      s: symbol,
      i: timeframe,
      o: '60000',
      h: '60020',
      l: '59980',
      c: '60005',
      v: '12',
      q: '720060',
      n: 18,
      x: false,
    }
    setTimeout(() => {
      socket.send(
        JSON.stringify({
          stream: 'ethusdt@markPriceKline_1h',
          data: {
            e: 'markPrice_kline',
            E: eventTime,
            s: symbol,
            k: { ...kline, c: '60004' },
          },
        }),
      )
      socket.send(
        JSON.stringify({
          stream: 'ethusdt@kline_1h',
          data: {
            e: 'kline',
            E: eventTime,
            s: symbol,
            k: kline,
          },
        }),
      )
    }, 100)
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
    if (
      url.pathname === '/fapi/v1/klines' ||
      url.pathname === '/fapi/v1/markPriceKlines'
    ) {
      const timeframe = url.searchParams.get('interval') ?? '15m'
      const interval = intervalMilliseconds[timeframe] ?? 15 * 60_000
      const start = Number(url.searchParams.get('startTime'))
      const end = Number(url.searchParams.get('endTime'))
      const limit = Number(url.searchParams.get('limit') ?? 500)
      const rows: unknown[][] = []
      for (
        let openTime = alignOpenTime(start, timeframe, 'ceil');
        openTime <= end && rows.length < limit;
        openTime = nextOpenTime(openTime, timeframe)
      ) {
        const offset = (openTime / interval) % 200
        const open = 60_000 + offset
        const close = open + Math.sin(offset) * 20
        rows.push([
          openTime,
          open.toFixed(2),
          (Math.max(open, close) + 12).toFixed(2),
          (Math.min(open, close) - 12).toFixed(2),
          close.toFixed(2),
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
}

interface MockGitHubFile {
  bytes: Buffer
  sha: string
}

async function mockGitHub(page: import('@playwright/test').Page) {
  const files = new Map<string, MockGitHubFile>()
  let sequence = 0
  await page.route('https://api.github.com/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (
      request.method() === 'GET' &&
      url.pathname === '/repos/alice/trading-backup'
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
    const match =
      /^\/repos\/alice\/trading-backup\/contents\/(.+)$/.exec(
        url.pathname,
      )
    if (match === null) {
      await route.fulfill({ status: 404, json: { message: 'Not Found' } })
      return
    }
    const path = match[1]
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
    if (request.method() === 'GET') {
      const file = files.get(path)
      if (file === undefined) {
        await route.fulfill({
          status: 404,
          json: { message: 'Not Found' },
        })
        return
      }
      await route.fulfill({
        json: {
          type: 'file',
          path,
          sha: file.sha,
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

test('exercises Pro chart interactions and the production path', async ({ page }) => {
  test.setTimeout(90_000)
  await mockBinance(page, true)
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
  await expect(
    page
      .locator('.klinecharts-pro-period-bar .period')
      .filter({ hasText: /^15m$/ }),
  ).toBeVisible()
  await expect(
    page
      .locator('.klinecharts-pro-period-bar .period')
      .filter({ hasText: /^12h$/ }),
  ).toBeHidden()
  await expect(
    page
      .locator('.klinecharts-pro-period-bar .period')
      .filter({ hasText: /^1w$/ }),
  ).toBeHidden()
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
  await expect(
    page
      .locator('.klinecharts-pro-period-bar .period')
      .filter({ hasText: /^1m$/ }),
  ).toBeVisible()
  await expect(
    page
      .locator('.klinecharts-pro-period-bar .period')
      .filter({ hasText: /^5m$/ }),
  ).toBeVisible()
  await expect(
    page
      .locator('.klinecharts-pro-period-bar .period')
      .filter({ hasText: /^3m$/ }),
  ).toBeHidden()
  await expect(
    page
      .locator('.klinecharts-pro-period-bar .period')
      .filter({ hasText: /^30m$/ }),
  ).toBeHidden()
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

  await compactPeriod.selectOption('1h')
  await expect(compactPeriod).toHaveValue('1h')
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
  await dataManager
    .getByRole('button', { name: '下载两类数据' })
    .click()
  await expect(dataManager.getByText(/下载完成/)).toBeVisible()
  await expect(
    dataManager.locator('.cache-summary').filter({ hasText: '普通 K 线' }),
  ).toContainText('13 根')
  await expect(
    dataManager
      .locator('.cache-summary')
      .filter({ hasText: '标记价格 K 线' }),
  ).toContainText('13 根')
  await dataManager.getByTestId('close-data-manager').click()

  const replayControls = page.getByTestId('replay-controls')
  await expect(
    replayControls.getByLabel('回放开始时间'),
  ).toHaveCount(0)
  await replayControls
    .getByLabel('图表跳转时间')
    .fill('2026-07-22T00:00')
  await replayControls.getByRole('button', { name: '跳转' }).click()
  await expect(
    replayControls.getByRole('button', { name: '创建回放' }),
  ).toBeEnabled()
  await expect(replayControls.getByText(/起点：/)).toContainText(
    '2026/7/22',
  )
  await expect(
    replayControls.getByLabel('回放结束时间'),
  ).toHaveValue('')
  await replayControls
    .getByLabel('回放结束时间')
    .fill('2026-07-22T05:00')
  await replayControls.getByRole('button', { name: '创建回放' }).click()
  await expect(replayControls).toContainText('1/6')
  const replayRequests: string[] = []
  const recordReplayRequest = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).hostname === 'fapi.binance.com') replayRequests.push(request.url())
  }

  const simulationPanel = page.getByTestId('simulation-panel')
  await expect(simulationPanel.getByText('钱包余额')).toBeVisible()
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
  await simulationPanel
    .getByRole('button', { name: '减 25%' })
    .click()
  await expect(
    simulationPanel
      .getByText('成交次数', { exact: true })
      .locator('..')
      .locator('dd'),
  ).toHaveText('3')

  await simulationPanel.getByLabel('止盈价格').fill('70000')
  await simulationPanel.getByRole('button', { name: '设置止盈' }).click()
  await simulationPanel.getByLabel('止损价格').fill('50000')
  await simulationPanel.getByRole('button', { name: '设置止损' }).click()
  await expect(simulationPanel).toContainText('70000 / 50000')

  await compactPeriod.selectOption('1d')
  await compactPeriod.selectOption('3m')
  await expect(compactPeriod).toHaveValue('3m')

  // Period changes keep the same replay clock, account and open position.
  for (const timeframe of ['1w', '1M', '1d', '5m', '15m', '1h']) {
    await compactPeriod.selectOption(timeframe)
    await expect(compactPeriod).toHaveValue(timeframe)
    await expect(page.locator('.klinecharts-pro-period-bar .period.selected')).toHaveText(timeframe)
    await expect(page.locator('.status-footer')).toContainText(`ETHUSDT · ${timeframe}`)
    await expect(page.locator('.status-footer')).not.toContainText('不能切换')
    await expect(replayControls).toContainText('1/6')
    await expect(simulationPanel.getByText('多仓', { exact: true })).toBeVisible()
    await expect(simulationPanel).toContainText('70000 / 50000')
    await expect(
      simulationPanel.getByText('成交次数', { exact: true }).locator('..').locator('dd'),
    ).toHaveText('3')
    await expect(page.locator('.klinecharts-pro-content > .klinecharts-pro-loading')).toBeHidden()
    await expectCanvasContent(page)
  }

  await compactPeriod.selectOption('5m')
  await expect(compactPeriod).toHaveValue('5m')
  await expect(page.locator('.klinecharts-pro-content > .klinecharts-pro-loading')).toBeHidden()
  page.on('request', recordReplayRequest)
  for (let index = 2; index <= 4; index += 1) {
    await replayControls.getByRole('button', { name: '下一根' }).click()
    await expect(replayControls).toContainText(`${index}/6`)
  }
  await expect(
    simulationPanel.getByText('多仓', { exact: true }),
  ).toBeVisible()

  await compactPeriod.selectOption('1h')
  await expect(compactPeriod).toHaveValue('1h')
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
  await expect(liveTimeControls.getByLabel('图表跳转时间')).toBeVisible()
  await liveTimeControls
    .getByLabel('图表跳转时间')
    .fill('2026-07-22T02:00')
  await liveTimeControls.getByRole('button', { name: '跳转' }).click()
  await expect(page.locator('.status-footer')).toContainText('图表已跳转到')
  await expect(page.getByTestId('live-status')).toContainText('只读模式')
  await expect(page.getByTestId('live-status')).toContainText('已连接')
  await expect(page.getByTestId('live-status')).toContainText('进行中')
  await expect(page.getByTestId('live-status')).toContainText('60004')
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
  await expect(
    page
      .getByTestId('simulation-panel')
      .getByText('成交次数', { exact: true })
      .locator('..')
      .locator('dd'),
  ).toHaveText('3')
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

  await page
    .getByTestId('replay-controls')
    .getByRole('button', { name: '结束会话' })
    .click()
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
  const exportStatus = await backupPanel
    .getByTestId('backup-status')
    .textContent()
  page.once('dialog', (dialog) => dialog.accept())
  await backupPanel
    .getByTestId('import-backup-file')
    .setInputFiles(downloadPath!)
  await expect
    .poll(() => backupPanel.getByTestId('backup-status').textContent())
    .not.toBe(exportStatus)

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
      path.startsWith('market-data/'),
    ),
  ).toBe(true)

  await backupPanel.getByTestId('github-compare').click()
  const compareStatus = await backupPanel
    .getByTestId('backup-status')
    .textContent()
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
  await backupPanel.getByTestId('github-disconnect').click()
  await expect(backupPanel.getByTestId('github-token')).toHaveValue('')
  await backupManager.getByTestId('close-data-manager').click()

  expect(notFoundResponses).toEqual([])
  expect(runtimeErrors).toEqual([])
  expect(deprecatedApiWarnings).toEqual([])
})

test('adds Supertrend to the main chart and restores its parameters after reload', async ({ page }) => {
  await mockBinance(page)
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
  await expect.poll(readSupertrend).toMatchObject({ calcParams: [10, 3], visible: true })
  const widget = page.locator('.klinecharts-pro-widget')
  // The indicator toolbar is drawn on canvas; click its second-row gear.
  await widget.click({ position: { x: 152, y: 59 } })
  const settings = page.locator('.klinecharts-pro-indicator-setting-modal-content')
  await expect(settings.getByText('ATR 周期', { exact: true })).toBeVisible()
  await expect(settings.getByText('ATR 倍数', { exact: true })).toBeVisible()
  const inputs = settings.locator('input')
  await expect(inputs.nth(0)).toHaveValue('10')
  await expect(inputs.nth(1)).toHaveValue('3')
  await inputs.nth(0).fill('7')
  await inputs.nth(0).blur()
  await inputs.nth(1).fill('2.5')
  await inputs.nth(1).blur()
  await page.getByText('确定', { exact: true }).click()
  await expect.poll(readSupertrend).toMatchObject({ calcParams: [7, 2.5], visible: true })
  await page.reload()
  await expectCanvasContent(page)
  await openIndicators()
  await expect(row.locator('.klinecharts-pro-checkbox')).toHaveClass(/checked/)
  await closeModal()
  await expect.poll(readSupertrend).toMatchObject({ calcParams: [7, 2.5], visible: true })

  await page.getByRole('heading', { level: 1 }).hover()
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

test('renders standard pivot levels and persists type, timeframe, labels and level settings', async ({ page }) => {
  await mockBinance(page, true)
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
    Object.assign(window, { pivotTestLabels: drawn })
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (/^(P|[RS][1-5]) \(/.test(text)) drawn.push(text)
      if (maxWidth === undefined) original.call(this, text, x, y)
      else original.call(this, text, x, y, maxWidth)
    }
  }, [...PIVOTS_DEFAULT_PARAMS])
  await page.goto('./')
  await expectCanvasContent(page)
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { pivotTestLabels: string[] }).pivotTestLabels.some((label) => label.startsWith('P (')),
  )).toBe(true)
  await expect(page.locator('.klinecharts-pro-period-bar .period.selected')).toHaveText('15m')
  const readPivots = () => page.evaluate(() => JSON.parse(localStorage.getItem('chart.indicators.v1')!).main.find((item: { name: string }) => item.name === 'PIVOTS'))
  const widget = page.locator('.klinecharts-pro-widget')
  await widget.click({ position: { x: 188, y: 37 } })
  const settings = page.locator('.klinecharts-pro-indicator-setting-modal-content')
  await expect(settings.getByLabel('枢轴类型')).toHaveValue('Traditional')
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
  await settings.getByLabel('R1 颜色', { exact: true }).fill('#12abcd')
  await page.getByText('确定', { exact: true }).click()
  await expect.poll(async () => (await readPivots()).calcParams.slice(0, 10))
    .toEqual(['Camarilla', 'Weekly', 2, true, false, true, 'Right', 2, false, '#fb8c00'])
  await page.reload()
  await expectCanvasContent(page)
  await expect.poll(async () => (await readPivots()).calcParams[11]).toBe('#12abcd')
  await expect(page.locator('.klinecharts-pro-period-bar .period.selected')).toHaveText('15m')
  await page.getByText('指标', { exact: true }).click()
  const row = page.locator('.klinecharts-pro-indicator-modal-list li.row').filter({ hasText: 'Pivots(标准枢轴点)' })
  await expect(row.locator('.klinecharts-pro-checkbox')).toHaveClass(/checked/)
  await page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  expect((await readPivots()).calcParams.slice(0, 3)).toEqual(['Camarilla', 'Weekly', 2])
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
  const selector = page.getByLabel('图表周期')
  await selector.selectOption('1m')
  await expect(page.locator('.status-footer')).toContainText('HTTP 418')
  await expect(page.locator('.status-footer')).toContainText('已暂停新增远程请求')
  for (const timeframe of ['1w', '1M', '15m']) {
    await selector.selectOption(timeframe)
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
