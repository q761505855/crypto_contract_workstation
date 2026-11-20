import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { installViewportProbe } from './viewport-probe'

const config = { clientId: 'test-app', clientSecret: 'test-secret', accessToken: 'test-access', accountId: 17 }
const minute = 60_000

async function connectFixture(page: Page, multipleAccounts = false, { initialQuote = true, rejectedAccount = 0 } = {}) {
  const messages: { type: number; accountId?: number; period?: number; symbolId?: number; live: boolean }[] = []
  const legacyRequests: string[] = []
  let currentSocket: WebSocketRoute | undefined
  let currentAccount = config.accountId
  const pushSpot = (payload: object) => currentSocket?.send(JSON.stringify({ payloadType: 2131,
    payload: { ctidTraderAccountId: currentAccount, symbolId: 10, ...payload },
  }))
  await page.route('**/ctrader-connection.json', route => route.fulfill({ json: config }))
  const cors = { 'access-control-allow-origin': '*' }
  await page.route('**/cloud-connection.json', route => route.fulfill({ status: 404, headers: cors, body: '' }))
  await page.route('https://api.github.com/**', route => route.fulfill({ status: 404, headers: cors, json: { message: 'Not Found' } }))
  await page.route(/binance\.com|binance\.vision/, route => {
    legacyRequests.push(route.request().url())
    return route.abort()
  })
  await page.routeWebSocket(/^wss:\/\/(demo|live)\.ctraderapi\.com:5036\/$/, socket => {
    currentSocket = socket
    const live = new URL(socket.url()).hostname === 'live.ctraderapi.com'
    let activeAccount = config.accountId
    socket.onMessage(message => {
      const { clientMsgId, payloadType, payload } = JSON.parse(message.toString())
      messages.push({ type: payloadType, accountId: payload.ctidTraderAccountId, period: payload.period, symbolId: payload.symbolId, live })
      const response = (type: number, body: object = {}) => socket.send(JSON.stringify({ clientMsgId, payloadType: type, payload: body }))
      const account = { ctidTraderAccountId: config.accountId, traderLogin: 2017, isLive: false, brokerTitleShort: 'IC Markets' }
      const accountPayload = { ctidTraderAccountId: activeAccount }
      const assets = [{ assetId: 1, name: 'EUR', digits: 2 }, { assetId: 2, name: 'USD', digits: 2 }]
      const symbols = ['EURUSD', 'XAUUSD', 'US500', 'BTCUSD', 'ETHUSD'].map((symbolName, index) => ({
        symbolId: 10 + index, symbolName, enabled: true, baseAssetId: 1, quoteAssetId: 2,
      }))
      switch (payloadType) {
        case 2100: response(2101); break
        case 2149: response(2150, { permissionScope: 0, ctidTraderAccount: multipleAccounts ? [account,
          { ...account, ctidTraderAccountId: 18, traderLogin: 2018 },
          { ...account, ctidTraderAccountId: 19, traderLogin: 2019, isLive: true },
        ] : [account] }); break
        case 2102:
          if (payload.ctidTraderAccountId === rejectedAccount) response(2142, { errorCode: 'ACCOUNT_ACCESS_DENIED' })
          else {
            currentAccount = activeAccount = payload.ctidTraderAccountId
            response(2103, { ctidTraderAccountId: activeAccount })
          }
          break
        case 2112: response(2113, { ...accountPayload, asset: assets }); break
        case 2114: response(2115, { ...accountPayload, symbol: symbols }); break
        case 2116: response(2117, { ...accountPayload, symbol: (payload.symbolId as number[]).map(symbolId => ({
          symbolId, digits: symbolId === 10 ? 5 : 2, scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 604800 }],
        })) }); break
        case 2137: {
          const width = [0, 1, 2, 3, 4, 5, 10, 15, 30, 60][Number(payload.period)] ?? 1
          const start = Math.ceil(Number(payload.fromTimestamp) / (minute * width)) * width
          const end = Math.floor(Number(payload.toTimestamp) / (minute * width)) * width
          const trendbar = []
          for (let stamp = Math.max(start, end - 10 * width); stamp <= end; stamp += width) {
            trendbar.push({ utcTimestampInMinutes: stamp, period: payload.period, low: 110000, deltaOpen: 20, deltaHigh: 70, deltaClose: 50, volume: 42 })
          }
          response(2138, { ...accountPayload, symbolId: payload.symbolId, period: payload.period, trendbar, hasMore: false })
          break
        }
        case 2127: response(2128, accountPayload); break
        case 2129: response(2130, accountPayload); break
        case 2135: {
          response(2165, accountPayload)
          if (initialQuote) pushSpot({ symbolId: payload.symbolId, bid: 110050, ask: 110060 })
          break
        }
        case 2136: response(2166, accountPayload); break
      }
    })
  })
  return { messages, legacyRequests, pushSpot, disconnect: () => currentSocket?.close({ code: 1011, reason: 'test outage' }) }
}

test('loads cTrader native intervals and keeps cloud sync limited to application archives', async ({ page }) => {
  const { messages, legacyRequests } = await connectFixture(page)
  await page.goto('./')
  await expect(page.getByRole('contentinfo')).toContainText('EURUSD')
  await expect.poll(() => messages.some(message => message.type === 2137)).toBe(true)
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await expect(page.getByRole('button', { name: '选择周期 2h', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '选择周期 2m', exact: true }).click()
  await expect.poll(() => messages.some(message => message.type === 2137 && message.period === 2)).toBe(true)
  await page.getByRole('button', { name: '工具', exact: true }).click()
  await page.getByTestId('open-data-manager').click()
  await expect(page.getByTestId('data-manager')).toContainText('cTrader')
  await expect(page.getByTestId('data-manager').getByRole('button', { name: '下载历史数据' })).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: '历史行情' })).toHaveCount(0)
  await expect(page.getByTestId('backup-sync-panel')).toContainText('projects/crypto-contract-workstation/experiments/ctrader')
  await page.getByRole('combobox', { name: '交易对', exact: true }).selectOption('XAUUSD')
  await page.getByRole('button', { name: '应用到图表', exact: true }).click()
  await expect.poll(() => messages.some(message => message.type === 2137 && message.period === 2 && message.symbolId === 11)).toBe(true)
  await expect(page.getByRole('contentinfo')).toContainText('XAUUSD')
  await page.reload()
  await expect(page.getByRole('contentinfo')).toContainText('XAUUSD')
  expect(legacyRequests).toEqual([])
})

test('remembers the account on reload and switches accounts from the tools menu', async ({ page }) => {
  const { messages, disconnect } = await connectFixture(page, true)
  await page.goto('./')
  const picker = page.getByRole('dialog', { name: '选择 cTrader 账户' })
  const tools = page.getByRole('button', { name: '工具', exact: true })
  await expect(picker).toBeVisible()
  const accounts = picker.getByRole('combobox', { name: 'cTrader 账户', exact: true })
  await expect(accounts.getByRole('option', { name: /真实账户.*2019/ })).toHaveCount(1)
  expect(messages.some(message => message.type === 2102 || message.type === 2137)).toBe(false)
  await accounts.press('Escape')
  await expect(picker).toBeHidden()
  await tools.click()
  await page.getByRole('button', { name: '选择 cTrader 账户', exact: true }).click()
  await accounts.selectOption('demo:18')
  await picker.getByRole('button', { name: '连接账户' }).click()
  await expect(picker).toBeHidden()
  await expect.poll(() => messages.find(message => message.type === 2137)?.accountId).toBe(18)

  await page.getByRole('button', { name: '实时行情', exact: true }).click()
  await expect.poll(() => messages.some(message => message.type === 2135 && message.accountId === 18)).toBe(true)
  disconnect()
  await expect.poll(() => messages.filter(message => message.type === 2102).map(message => message.accountId)).toEqual([18, 18])
  await expect(picker).toBeHidden()

  await page.reload()
  await expect.poll(() => messages.filter(message => message.type === 2102).map(message => message.accountId)).toEqual([18, 18, 18])
  await expect(picker).toBeHidden()
  const switchAccount = page.getByRole('button', { name: '切换账户', exact: true })
  await expect(switchAccount).toBeHidden()
  await tools.click()
  await switchAccount.click()
  const switchDialog = page.getByRole('dialog', { name: '切换 cTrader 账户' })
  const alternatives = switchDialog.getByRole('combobox', { name: 'cTrader 账户', exact: true })
  await expect(alternatives).toHaveValue('demo:18')
  await alternatives.selectOption('live:19')
  await switchDialog.getByRole('button', { name: '连接账户' }).click()
  await expect.poll(() => messages.filter(message => message.type === 2137).at(-1)).toMatchObject({ live: true, accountId: 19 })
  await expect(switchDialog).toBeHidden()
})

test('asks for an account when the remembered preference is no longer authorized', async ({ page }) => {
  const { messages } = await connectFixture(page, true)
  await page.addInitScript(() => localStorage.setItem('crypto-contract-workstation:ctrader:marketData.ctraderAccount.v1', '"live:90"'))
  await page.goto('./')
  await expect(page.getByRole('dialog', { name: '选择 cTrader 账户' })).toBeVisible()
  expect(messages.some(message => message.type === 2102)).toBe(false)
})

test('keeps the switch entry available if the remembered account cannot connect', async ({ page }) => {
  const { messages } = await connectFixture(page, true, { rejectedAccount: 18 })
  await page.addInitScript(() => {
    const key = 'crypto-contract-workstation:ctrader:marketData.ctraderAccount.v1'
    if (localStorage.getItem(key) === null) localStorage.setItem(key, '"demo:18"')
  })
  await page.goto('./')
  await expect(page.getByRole('contentinfo')).toContainText('cTrader 认证失败')
  await page.getByRole('button', { name: '工具', exact: true }).click()
  await page.getByRole('button', { name: '切换账户', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '切换 cTrader 账户' })
  await picker.getByRole('combobox').selectOption('live:19')
  await picker.getByRole('button', { name: '连接账户' }).click()
  await expect.poll(() => messages.find(message => message.type === 2137)).toMatchObject({ live: true, accountId: 19 })
})

test('authenticates a selected real account through the live endpoint', async ({ page }) => {
  const { messages } = await connectFixture(page, true)
  await page.goto('./')
  const picker = page.getByRole('dialog', { name: '选择 cTrader 账户' })
  await picker.getByRole('combobox', { name: 'cTrader 账户', exact: true }).selectOption('live:19')
  await picker.getByRole('button', { name: '连接账户' }).click()
  await expect.poll(() => messages.find(message => message.type === 2137)).toMatchObject({ live: true, accountId: 19 })
  expect(messages.filter(message => message.type === 2102)).toMatchObject([{ live: true, accountId: 19 }])
})

test('reloads native history after a live connection is restored', async ({ page }) => {
  const start = Date.UTC(2026, 10, 20, 15, 0, 30)
  await page.clock.setFixedTime(new Date(start))
  const { messages, disconnect } = await connectFixture(page)
  const readChart = await installViewportProbe(page)
  await page.goto('./')
  await page.getByRole('button', { name: '实时行情', exact: true }).click()
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 1m', exact: true }).click()
  await expect.poll(() => messages.some(message => message.type === 2135 && message.period === 1)).toBe(true)
  await expect.poll(async () => (await readChart()).last?.timestamp).toBe(start - 30_000)
  await page.clock.setFixedTime(new Date(start + 4 * minute))
  disconnect()
  await expect.poll(() => messages.filter(message => message.type === 2100).length).toBe(2)
  await expect.poll(async () => (await readChart()).last?.timestamp).toBe(start + 4 * minute - 30_000)
})

test('updates the open 15m candle on quotes and replaces it with a late official close', async ({ page }) => {
  const start = Date.UTC(2026, 10, 20, 14)
  await page.clock.setFixedTime(new Date(start + 5 * minute))
  const { messages, pushSpot } = await connectFixture(page, false, { initialQuote: false })
  const readChart = await installViewportProbe(page)
  await page.goto('./')
  await expect(page.locator('.candle-summary')).toBeVisible()
  await expect.poll(async () => (await readChart()).last?.timestamp).toBe(start)
  await page.getByRole('button', { name: '实时行情', exact: true }).click()
  await expect.poll(() => messages.some(message => message.type === 2135 && message.period === 7)).toBe(true)

  pushSpot({ timestamp: start + 5 * minute, bid: 110120, trendbar: [
    { utcTimestampInMinutes: start / minute, period: 7, low: 110000, deltaOpen: 20, deltaHigh: 70, deltaClose: 50, volume: 42 },
  ] })
  await expect.poll(async () => (await readChart()).last).toMatchObject({
    timestamp: start, open: 1.1002, low: 1.1, high: 1.1012, close: 1.1012,
  })
  await expect(page.getByTestId('live-status')).toContainText('进行中')
  await expect(page.locator('.candle-summary')).toContainText('1.10120')

  await page.clock.setFixedTime(new Date(start + 15 * minute + 1000))
  pushSpot({ timestamp: start + 15 * minute, bid: 110110 })
  await expect.poll(async () => (await readChart()).last).toMatchObject({ timestamp: start + 15 * minute, close: 1.1011 })
  pushSpot({ timestamp: start + 15 * minute + 1000, trendbar: [
    { utcTimestampInMinutes: start / minute, period: 7, low: 110000, deltaOpen: 20, deltaHigh: 150, deltaClose: 130, volume: 51 },
  ] })
  await expect.poll(async () => (await readChart()).previous).toMatchObject({ timestamp: start, close: 1.1013, volume: 51 })
  expect((await readChart()).last?.close).toBe(1.1011)
})

test('restores explicit empty and legacy settings in the experiment without overwriting production preferences', async ({ page }) => {
  await connectFixture(page)
  await page.addInitScript(() => localStorage.setItem('marketData.favoriteSymbols', '["ETHUSDT"]'))
  await page.goto('./')
  await page.getByRole('button', { name: '工具', exact: true }).click()
  await page.getByTestId('open-data-manager').click()
  const preferences = {
    binanceRestBaseUrl: 'https://fapi.binance.com', favoriteSymbols: [], pinnedPeriods: ['2m', '6h'],
    replayStepPeriod: '2h', showTradeOverlays: false, selectedSymbol: { ticker: '币安人生USDT' },
  }
  page.once('dialog', dialog => dialog.accept())
  await page.getByTestId('import-backup-file').setInputFiles({
    name: 'legacy-preferences.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ fileType: 'crypto-contract-workstation-backup', schemaVersion: 1,
      kind: 'preferences', exportedAt: Date.now(), data: { preferences } })),
  })
  await expect(page.getByTestId('backup-status')).toContainText('刷新页面')
  await page.reload()
  await expect(page.getByRole('contentinfo')).toContainText('EURUSD')
  await expect(page.getByRole('button', { name: '快捷周期 2m' })).toBeVisible()
  await expect(page.getByRole('button', { name: '快捷周期 6h' })).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('marketData.favoriteSymbols'))).toBe('["ETHUSDT"]')

  await page.getByRole('button', { name: '工具', exact: true }).click()
  await page.getByTestId('open-data-manager').click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出应用配置' }).click(),
  ])
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8'))
  expect(exported.data.preferences).toMatchObject(preferences)
  expect(exported.data).not.toHaveProperty('tradeCandles')
  expect(JSON.stringify(exported)).not.toContain(config.accessToken)
})

test('shows when an imported account preference needs a refresh and uses it after reload', async ({ page }) => {
  const { messages } = await connectFixture(page, true)
  const authAccounts = () => messages.filter(message => message.type === 2102).map(message => message.accountId)
  const tools = page.getByRole('button', { name: '工具', exact: true })
  await page.addInitScript(() => {
    const key = 'crypto-contract-workstation:ctrader:marketData.ctraderAccount.v1'
    if (localStorage.getItem(key) === null) localStorage.setItem(key, '"demo:18"')
  })
  await page.goto('./')
  await expect.poll(authAccounts).toEqual([18])
  await tools.click()
  await page.getByTestId('open-data-manager').click()
  page.once('dialog', dialog => dialog.accept())
  await page.getByTestId('import-backup-file').setInputFiles({
    name: 'account-preferences.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ fileType: 'crypto-contract-workstation-backup', schemaVersion: 1,
      kind: 'preferences', exportedAt: Date.now(), data: {
        preferences: { binanceRestBaseUrl: 'https://fapi.binance.com', favoriteSymbols: [], ctraderAccount: 'live:19' },
      } })),
  })
  const manager = page.getByTestId('data-manager')
  await expect(page.getByTestId('backup-status')).toContainText('刷新页面')
  await manager.getByTestId('close-data-manager').click()
  await tools.click()
  await expect(page.getByRole('navigation', { name: '工作站工具' }).getByRole('status')).toContainText('刷新页面后生效')
  expect(authAccounts()).toEqual([18])
  await page.reload()
  await expect.poll(authAccounts).toEqual([18, 19])
  await expect(page.getByRole('dialog', { name: '选择 cTrader 账户' })).toBeHidden()
})

test('replays native minute steps, reveals completed chart bars, and restores a simulated trade', async ({ page }) => {
  const jumpAt = Date.UTC(2026, 10, 20, 14, 50)
  await page.clock.setFixedTime(new Date(Date.UTC(2026, 10, 20, 15, 0, 45)))
  await page.addInitScript(() => localStorage.setItem('crypto-contract-workstation:ctrader:replay.stepPeriod.v1', '"2h"'))
  const { messages } = await connectFixture(page)
  const readChart = await installViewportProbe(page)
  const localInput = (timestamp: number) => page.evaluate(value => {
    const offset = new Date(value).getTimezoneOffset()
    return new Date(value - offset * 60_000).toISOString().slice(0, 16)
  }, timestamp)

  await page.goto('./')
  const controls = page.getByTestId('replay-controls')
  const period = page.getByRole('button', { name: '图表周期', exact: true })
  await period.click()
  await page.getByRole('button', { name: '选择周期 2m', exact: true }).click()
  await expect(controls.getByRole('button', { name: '创建回放', exact: true })).toBeEnabled()
  await controls.getByRole('button', { name: '时间定位', exact: true }).click()
  const locate = page.getByRole('dialog', { name: '图表时间定位' })
  await locate.getByLabel('图表跳转时间').fill(await localInput(jumpAt))
  await locate.getByRole('button', { name: '跳转', exact: true }).click()
  await expect.poll(async () => (await readChart()).rightmost).toBe(jumpAt)
  await expect(controls.locator('.replay-start-time')).toContainText((await localInput(jumpAt)).replace('T', ' '))
  await controls.getByRole('button', { name: '回放设置', exact: true }).click()
  const setup = page.getByRole('dialog', { name: '回放会话设置' })
  await setup.getByLabel('回放结束时间').fill(await localInput(jumpAt + 8 * minute))
  await setup.getByRole('button', { name: '开始历史回放', exact: true }).click()

  const next = controls.getByRole('button', { name: '下一根', exact: true })
  const lastCandle = () => readChart().then(chart => chart.last?.timestamp)
  await expect(controls).toContainText('第 1 步')
  await expect.poll(lastCandle).toBe(jumpAt)
  await expect(controls.getByLabel('步进周期')).toHaveValue('1m')
  await next.click()
  await expect(controls).toContainText('第 2 步')
  await expect.poll(() => messages.some(message => message.type === 2137 && message.period === 1)).toBe(true)
  expect(await lastCandle()).toBe(jumpAt)

  const trade = page.getByRole('complementary', { name: '模拟下单面板' })
  await trade.getByRole('button', { name: '开多', exact: true }).click()
  const position = page.getByTestId('position-long')
  await expect(position).toBeVisible()
  await next.click()
  await expect(controls).toContainText('第 3 步')
  await expect.poll(lastCandle).toBe(jumpAt + 2 * minute)

  await page.reload()
  await expect(controls).toContainText('第 3 步')
  await expect(position).toBeVisible()
  await expect.poll(lastCandle).toBe(jumpAt + 2 * minute)
})
