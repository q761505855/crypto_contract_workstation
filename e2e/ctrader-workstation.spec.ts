import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { installViewportProbe } from './viewport-probe'

const config = { clientId: 'test-app', clientSecret: 'test-secret', accessToken: 'test-access', accountId: 17 }
const minute = 60_000

async function connectFixture(page: Page, multipleAccounts = false, {
  initialQuote = true,
  rejectedAccount = 0,
  historyAvailable,
  ticks = [],
}: {
  initialQuote?: boolean
  rejectedAccount?: number
  historyAvailable?: (timestamp: number) => boolean
  ticks?: { timestamp: number; price: number }[]
} = {}) {
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
          if (payload.ctidTraderAccountId === rejectedAccount) response(2142, { errorCode: 'CANT_ROUTE_REQUEST' })
          else {
            currentAccount = activeAccount = payload.ctidTraderAccountId
            response(2103, { ctidTraderAccountId: activeAccount })
          }
          break
        case 2112: response(2113, { ...accountPayload, asset: assets }); break
        case 2114: response(2115, { ...accountPayload, symbol: symbols }); break
        case 2116: response(2117, { ...accountPayload, symbol: (payload.symbolId as number[]).map(symbolId => ({
          symbolId, digits: symbolId === 10 ? 5 : 2, scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 604800 }],
          lotSize: 10000000, minVolume: 100000, stepVolume: 100000, maxVolume: 1000000000,
          leverageId: 123, commissionType: 1, preciseTradingCommissionRate: 3000000000,
        })) }); break
        case 2121: response(2122, { trader: { ...accountPayload, depositAssetId: 2, leverageInCents: 50000,
          totalMarginCalculationType: 0, accountType: 0 } }); break
        case 2177: response(2178, { ...accountPayload, leverage: { leverageId: 123, tiers: [{ volume: 100000000, leverage: 20000 }] } }); break
        case 2137: {
          const width = [0, 1, 2, 3, 4, 5, 10, 15, 30, 60][Number(payload.period)] ?? 1
          const start = Math.ceil(Number(payload.fromTimestamp) / (minute * width)) * width
          const end = Math.floor(Number(payload.toTimestamp) / (minute * width)) * width
          const trendbar = []
          const first = historyAvailable ? start : Math.max(start, end - 10 * width)
          for (let stamp = first; stamp <= end; stamp += width) {
            if (historyAvailable && !historyAvailable(stamp * minute)) continue
            trendbar.push({ utcTimestampInMinutes: stamp, period: payload.period, low: 110000, deltaOpen: 20, deltaHigh: 70, deltaClose: 50, volume: 42 })
          }
          response(2138, { ...accountPayload, symbolId: payload.symbolId, period: payload.period, trendbar, hasMore: false })
          break
        }
        case 2145: {
          const quotes = ticks.filter(quote =>
            quote.timestamp >= Number(payload.fromTimestamp) && quote.timestamp < Number(payload.toTimestamp)).reverse()
          const tickData = quotes.map((quote, i) => ({
            timestamp: quote.timestamp - (quotes[i - 1]?.timestamp ?? 0),
            tick: quote.price - (quotes[i - 1]?.price ?? 0),
          }))
          response(2146, { ...accountPayload, tickData, hasMore: false })
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
  const drawer = page.getByTestId('data-manager')
  await expect(drawer.getByRole('heading', { name: '交易对与周期' })).toHaveCount(0)
  await expect(drawer.getByRole('heading', { name: '图表绘图存档' })).toBeVisible()
  await expect(drawer.getByRole('button', { name: '下载历史数据' })).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: '历史行情' })).toHaveCount(0)
  await expect(page.getByTestId('backup-sync-panel')).toContainText('projects/crypto-contract-workstation/experiments/ctrader')
  const catalogRequests = () => messages.filter(message => message.type === 2114).length
  const initialCatalogRequests = catalogRequests()
  const refresh = drawer.getByRole('button', { name: '刷新品种列表', exact: true })
  await refresh.click()
  await expect.poll(catalogRequests).toBe(initialCatalogRequests + 1)
  await expect(refresh).toBeEnabled()
  await drawer.getByTestId('close-data-manager').click()

  const symbolButton = page.locator('.klinecharts-pro-period-bar .symbol')
  const picker = page.getByTestId('symbol-picker')
  await symbolButton.click()
  await picker.getByRole('tab', { name: '全部' }).click()
  await picker.getByRole('textbox', { name: '搜索交易对' }).fill('XAUUSD')
  await picker.getByRole('button', { name: '收藏 XAUUSD', exact: true }).click()
  await picker.getByRole('button', { name: '选择 XAUUSD', exact: true }).click()
  await expect.poll(() => messages.some(message => message.type === 2137 && message.period === 2 && message.symbolId === 11)).toBe(true)
  await expect(page.getByRole('contentinfo')).toContainText('XAUUSD')
  await page.reload()
  await expect(page.getByRole('contentinfo')).toContainText('XAUUSD')
  await symbolButton.click()
  await expect(picker.getByRole('button', { name: '取消收藏 XAUUSD', exact: true })).toBeVisible()
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

test('switches from an unroutable demo account to live from the market status panel', async ({ page }) => {
  const { messages } = await connectFixture(page, true, { rejectedAccount: 18 })
  await page.addInitScript(() => {
    const key = 'crypto-contract-workstation:ctrader:marketData.ctraderAccount.v1'
    if (localStorage.getItem(key) === null) localStorage.setItem(key, '"demo:18"')
  })
  await page.goto('./')
  const liveStatus = page.getByTestId('live-status')
  await expect(liveStatus).toContainText('无法连接所选模拟账户（CANT_ROUTE_REQUEST）')
  expect(messages.filter(message => message.type === 2102).map(message => message.live)).toEqual([false])
  await liveStatus.getByRole('button', { name: '切换 cTrader 账户', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '切换 cTrader 账户' })
  const accounts = picker.getByRole('combobox')
  await expect(accounts).toHaveValue('demo:18')
  await accounts.selectOption('live:19')
  await picker.getByRole('button', { name: '连接账户' }).click()
  await expect.poll(() => messages.find(message => message.type === 2137)).toMatchObject({ live: true, accountId: 19 })
  await expect(liveStatus).toContainText('已连接')
  await expect(liveStatus.getByRole('button', { name: '切换 cTrader 账户', exact: true })).toHaveCount(0)
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

test('pans to older live candles after an empty history page and keeps streaming', async ({ page }) => {
  const latest = Date.UTC(2026, 10, 20, 15)
  const recentStart = latest - 159 * minute
  const earlier = recentStart - 30 * 24 * 60 * minute
  await page.clock.setFixedTime(new Date(latest + 30_000))
  const { messages, pushSpot } = await connectFixture(page, false, {
    historyAvailable: stamp => stamp >= recentStart || stamp >= earlier - 20 * minute && stamp <= earlier,
  })
  const readChart = await installViewportProbe(page)
  await page.goto('./')
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 1m', exact: true }).click()
  await expect.poll(() => messages.some(message => message.type === 2135 && message.period === 1)).toBe(true)
  await expect.poll(async () => (await readChart()).timestamps[0]).toBe(recentStart)

  const box = (await page.locator('.candle-summary').boundingBox())!
  const panEarlier = async () => {
    await page.mouse.move(box.x + 100, box.y + 85)
    await page.mouse.down()
    await page.mouse.move(box.x + 700, box.y + 85, { steps: 6 })
    await page.mouse.up()
  }
  await panEarlier()
  const footer = page.getByRole('contentinfo')
  await expect(footer).toContainText('此区间无报价，继续向左查看')

  await panEarlier()
  await expect.poll(async () => (await readChart()).timestamps[0]).toBe(earlier - 20 * minute)
  const { timestamps, last } = await readChart()
  expect(timestamps[timestamps.indexOf(earlier) + 1]).toBe(recentStart)
  expect(new Set(timestamps).size).toBe(timestamps.length)
  expect(last?.timestamp).toBe(latest)
  expect((await readChart()).rightmost).toBeLessThan(latest)

  pushSpot({ timestamp: latest + 30_000, bid: 110120 })
  await expect.poll(async () => (await readChart()).last?.close).toBe(1.1012)
})

test('steps the live chart one candle at a time and resumes streaming after replay', async ({ page }) => {
  const latest = Date.UTC(2026, 10, 20, 15, 4)
  await page.clock.setFixedTime(new Date(latest + 30_000))
  const { messages, pushSpot } = await connectFixture(page)
  const readChart = await installViewportProbe(page)
  await page.goto('./')
  const controls = page.getByTestId('replay-controls')
  const footer = page.getByRole('contentinfo')
  const dock = page.getByRole('region', { name: '持仓与复盘面板' })
  const previous = controls.getByRole('button', { name: '上一根', exact: true })
  const next = controls.getByRole('button', { name: '下一根', exact: true })

  await expect(footer).toContainText('实时行情')
  await expect(dock).toBeHidden()
  await expect(controls.getByLabel('步进周期')).toHaveCount(0)
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 1m', exact: true }).click()
  await expect.poll(() => messages.some(message => message.type === 2135 && message.period === 1)).toBe(true)
  const rightmost = () => readChart().then(chart => chart.rightmost)
  await expect.poll(rightmost).toBe(latest)
  await previous.click()
  await expect.poll(rightmost).toBe(latest - minute)
  await next.click()
  await expect.poll(rightmost).toBe(latest)
  await previous.click()
  await previous.click()
  await expect.poll(rightmost).toBe(latest - 2 * minute)
  pushSpot({ timestamp: latest + 31_000, bid: 110180 })
  await expect.poll(async () => (await readChart()).last?.close).toBe(1.1018)
  expect(await rightmost()).toBe(latest - 2 * minute)

  await controls.getByRole('button', { name: '创建回放', exact: true }).click()
  await expect(footer).toContainText('历史回放')
  await expect(dock).toBeVisible()
  await expect.poll(() => messages.some(message => message.type === 2136 && message.period === 1)).toBe(true)
  await expect.poll(async () => (await readChart()).last?.timestamp).toBe(latest - 2 * minute)
  pushSpot({ timestamp: latest + 32_000, bid: 110190 })
  await next.click()
  await expect.poll(async () => (await readChart()).last?.timestamp).toBe(latest - minute)

  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 2m', exact: true }).click()
  await expect(footer).toContainText('EURUSD · 2m')
  await controls.getByRole('button', { name: '播放', exact: true }).click()
  await expect(footer).toContainText('实时行情')
  await expect(footer).toContainText('EURUSD · 1m')
  await expect(dock).toBeHidden()
  await expect(controls.getByRole('button', { name: '创建回放', exact: true })).toBeVisible()
  await expect.poll(() => messages.filter(message => message.type === 2135 && message.period === 1).length).toBeGreaterThan(1)
  await expect.poll(rightmost).toBe(latest)
  pushSpot({ timestamp: latest + 33_000, bid: 110200 })
  await expect.poll(async () => (await readChart()).last?.close).toBe(1.102)

  await page.reload()
  await expect(footer).toContainText('实时行情')
  await controls.getByRole('button', { name: '回放设置', exact: true }).click()
  await expect(page.getByLabel('已有回放会话')).toContainText('EURUSD 1m')
  await page.getByRole('button', { name: '加载会话', exact: true }).click()
  await expect(dock).toBeVisible()
  await expect(controls.getByRole('button', { name: '播放', exact: true })).toBeDisabled()
  await controls.getByRole('button', { name: '回放设置', exact: true }).click()
  await page.getByRole('button', { name: '结束会话', exact: true }).click()
  await expect(footer).toContainText('实时行情')
  await expect(footer).toContainText('EURUSD · 15m')
})

test('plays and pauses the live chart with the button or a hold on the next candle', async ({ page }) => {
  const latest = Date.UTC(2026, 10, 20, 15, 4)
  await page.clock.install({ time: new Date(latest + 15_000) })
  const { pushSpot } = await connectFixture(page)
  const readChart = await installViewportProbe(page)
  await page.goto('./')
  const controls = page.getByTestId('replay-controls')
  const previous = controls.getByRole('button', { name: '上一根', exact: true })
  const next = controls.getByRole('button', { name: '下一根', exact: true })
  const play = controls.getByRole('button', { name: '播放', exact: true })
  const pause = controls.getByRole('button', { name: '暂停', exact: true })
  const rightmost = () => readChart().then(chart => chart.rightmost)
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 1m', exact: true }).click()
  await expect.poll(rightmost).toBe(latest)
  await expect(next).toBeEnabled()
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 200)
  for (let i = 0; i < 6; i++) await previous.click()
  await expect.poll(rightmost).toBe(latest - 6 * minute)

  await next.hover()
  await page.mouse.down()
  await page.clock.runFor(450)
  await expect(pause).toBeVisible()
  await page.clock.runFor(1_000)
  await expect.poll(rightmost).toBe(latest - 5 * minute)
  await page.mouse.move(10, 10)
  await page.mouse.up()
  await expect(play).toBeVisible()
  await page.clock.runFor(1_500)
  expect(await rightmost()).toBe(latest - 5 * minute)
  await next.press('Enter')
  await expect.poll(rightmost).toBe(latest - 4 * minute)

  await controls.getByLabel('播放速度', { exact: true }).selectOption('10')
  await play.click()
  await expect(pause).toBeVisible()
  await page.clock.runFor(200)
  await expect.poll(rightmost).toBe(latest - 2 * minute)
  await pause.click()
  await page.clock.runFor(500)
  expect(await rightmost()).toBe(latest - 2 * minute)

  await next.click()
  await expect.poll(rightmost).toBe(latest - minute)
  await play.click()
  await expect(pause).toBeVisible()
  await page.clock.runFor(100)
  await expect.poll(rightmost).toBe(latest)
  await expect(pause).toBeVisible({ timeout: 1500 })
  await page.clock.fastForward(latest + minute - await page.evaluate(() => Date.now()))
  pushSpot({ timestamp: latest + minute, bid: 110090 })
  await expect.poll(rightmost).toBe(latest + minute)
  await expect(pause).toBeVisible()
  await pause.click()
  await expect(play).toBeVisible()
  await expect(page.getByRole('contentinfo')).toContainText('实时行情')
  await expect(controls.getByLabel('步进周期')).toHaveCount(0)
})

test('saves individual market session toggles and restores them from an application archive', async ({ page }) => {
  await connectFixture(page)
  await page.addInitScript(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (text === '\ue902' && this.canvas.closest('[data-pane-id="candle_pane"]')) {
        const point = new DOMPoint(x, y).matrixTransform(this.getTransform())
        const rect = this.canvas.getBoundingClientRect()
        Object.assign(window, { marketSessionGear: { x: rect.left + point.x / devicePixelRatio, y: rect.top + point.y / devicePixelRatio } })
      }
      if (maxWidth === undefined) fillText.call(this, text, x, y)
      else fillText.call(this, text, x, y, maxWidth)
    }
  })
  const settings = page.locator('.klinecharts-pro-indicator-setting-modal-content')
  const openSettings = async () => {
    const showInfo = page.getByRole('button', { name: '显示主图指标信息', exact: true })
    if (await showInfo.isVisible()) await showInfo.click()
    await expect(async () => {
      const gear = await page.evaluate(() => (window as unknown as { marketSessionGear?: { x: number; y: number } }).marketSessionGear)
      expect(gear).toBeDefined()
      await page.mouse.click(gear!.x + 3, gear!.y + 3)
      await expect(settings).toBeVisible({ timeout: 400 })
    }).toPass({ timeout: 5000 })
  }
  const tokyo = settings.getByRole('checkbox', { name: '显示东京' })
  const london = settings.getByRole('checkbox', { name: '显示伦敦' })
  const newYork = settings.getByRole('checkbox', { name: '显示纽约' })
  const confirm = page.getByText('确定', { exact: true })
  const readVisibility = () => page.evaluate(() => {
    const key = 'crypto-contract-workstation:ctrader:chart.indicators.v1'
    return JSON.parse(localStorage.getItem(key) ?? 'null')?.main.find((indicator: { name: string }) =>
      indicator.name === 'MARKET_SESSIONS')?.styles?.sessionVisibility
  })

  await page.goto('./')
  await expect(page.getByRole('contentinfo')).toContainText('EURUSD')
  await page.getByText('指标', { exact: true }).click()
  const indicatorList = page.locator('.klinecharts-pro-indicator-modal-list')
  await indicatorList.getByText('市场开收盘', { exact: true }).click()
  await page.locator('.klinecharts-pro-modal .close-icon').click({ position: { x: 1, y: 1 } })
  await openSettings()
  for (const checkbox of [tokyo, london, newYork]) await expect(checkbox).toBeChecked()
  await london.uncheck()
  await confirm.click()
  await expect.poll(readVisibility).toEqual([true, false, true])

  await page.reload()
  await openSettings()
  await expect(tokyo).toBeChecked()
  await expect(london).not.toBeChecked()
  await expect(newYork).toBeChecked()
  await confirm.click()
  await page.getByRole('button', { name: '工具', exact: true }).click()
  await page.getByTestId('open-data-manager').click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出应用配置' }).click(),
  ])
  const archive = JSON.parse(await readFile((await download.path())!, 'utf8'))
  const indicator = archive.data.preferences.chartIndicators.main.find((setting: { name: string }) => setting.name === 'MARKET_SESSIONS')
  expect(indicator.styles.sessionVisibility).toEqual([true, false, true])
  indicator.styles.sessionVisibility = [false, false, false]
  page.once('dialog', dialog => dialog.accept())
  await page.getByTestId('import-backup-file').setInputFiles({
    name: 'market-session-preferences.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)),
  })
  await expect(page.getByTestId('backup-status')).toContainText('刷新页面')
  await page.reload()
  await openSettings()
  for (const checkbox of [tokyo, london, newYork]) await expect(checkbox).not.toBeChecked()
  expect(await readVisibility()).toEqual([false, false, false])
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

test('loads later candles across a weekend when panning before replay starts', async ({ page }) => {
  const jumpAt = Date.UTC(2026, 10, 20, 21)
  const lastBeforeClose = jumpAt + 10 * minute
  const reopen = Date.UTC(2026, 10, 22, 22)
  await page.clock.setFixedTime(new Date(reopen + 12 * 60 * minute))
  await connectFixture(page, false, { historyAvailable: timestamp => timestamp <= lastBeforeClose || timestamp >= reopen })
  const readChart = await installViewportProbe(page)
  await page.goto('./')
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 1m', exact: true }).click()
  await page.getByRole('button', { name: '时间定位', exact: true }).click()
  const locate = page.getByRole('dialog', { name: '图表时间定位' })
  const inputTime = await page.evaluate(timestamp => {
    const offset = new Date(timestamp).getTimezoneOffset()
    return new Date(timestamp - offset * 60_000).toISOString().slice(0, 16)
  }, jumpAt)
  await locate.getByLabel('图表跳转时间').fill(inputTime)
  await locate.getByRole('button', { name: '跳转', exact: true }).click()
  await expect.poll(async () => (await readChart()).events).toContainEqual(expect.objectContaining({ type: 'scroll', time: jumpAt }))
  await expect.poll(async () => (await readChart()).rightmost).toBe(jumpAt)
  expect((await readChart()).last?.timestamp).toBe(lastBeforeClose)

  const box = (await page.locator('.candle-summary').boundingBox())!
  const panLater = async () => {
    await page.mouse.move(box.x + 540, box.y + 85)
    await page.mouse.down()
    await page.mouse.move(box.x + 110, box.y + 85, { steps: 12 })
    await page.mouse.up()
  }
  await panLater()
  await expect.poll(async () => (await readChart()).last?.timestamp).toBeGreaterThanOrEqual(reopen)
  await expect.poll(async () => (await readChart()).rightmost).toBeGreaterThanOrEqual(reopen)
  const firstPageEnd = (await readChart()).last!.timestamp
  await panLater()
  await expect.poll(async () => (await readChart()).last?.timestamp).toBeGreaterThan(firstPageEnd)
  const timestamps = (await readChart()).timestamps
  expect(timestamps[timestamps.indexOf(lastBeforeClose) + 1]).toBe(reopen)
  expect(new Set(timestamps).size).toBe(timestamps.length)
})

test('replays ticks and seconds on a native 5m chart and restores a same-time quote cursor', async ({ page }) => {
  const start = Date.UTC(2026, 10, 20, 14, 20)
  const at = start + 5 * minute
  await page.clock.setFixedTime(new Date(at + 15 * minute))
  const { messages } = await connectFixture(page, false, { ticks: [
    { timestamp: at + 456, price: 110050 }, { timestamp: at + 456, price: 110060 },
    { timestamp: at + 5100, price: 110080 }, { timestamp: at + 5400, price: 110070 },
    { timestamp: at + 10200, price: 110090 }, { timestamp: at + 10900, price: 110040 },
    { timestamp: at + 15100, price: 110100 }, { timestamp: at + 29800, price: 110030 },
  ] })
  const readChart = await installViewportProbe(page)
  await page.goto('./')
  const controls = page.getByTestId('replay-controls')
  await page.getByRole('button', { name: '图表周期', exact: true }).click()
  await page.getByRole('button', { name: '选择周期 5m', exact: true }).click()
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
  const mode = controls.getByLabel('步进周期')
  const last = () => readChart().then(chart => chart.last)
  await mode.selectOption('tick')
  await controls.getByRole('button', { name: '下一笔', exact: true }).click()
  await expect(controls).toContainText(':00.456')
  await expect(controls).toContainText('第 2 步')
  await expect.poll(last).toMatchObject({ timestamp: at, close: 1.1005, volume: 1, ctraderClosed: false })
  await controls.getByRole('button', { name: '下一笔', exact: true }).click()
  await expect(controls).toContainText('第 3 步')
  await expect(controls).toContainText(':00.456')
  await expect.poll(last).toMatchObject({ timestamp: at, close: 1.1006, volume: 2, ctraderClosed: false })
  const tickRequests = () => messages.filter(message => message.type === 2145).length
  expect(tickRequests()).toBe(1)

  await page.reload()
  await expect(mode).toHaveValue('tick')
  await expect(controls).toContainText('第 3 步')
  await expect.poll(last).toMatchObject({ timestamp: at, close: 1.1006, volume: 2 })
  await controls.getByRole('button', { name: '上一笔', exact: true }).click()
  await expect(controls).toContainText('第 2 步')
  await expect.poll(last).toMatchObject({ timestamp: at, close: 1.1005, volume: 1 })
  await mode.selectOption('5s')
  await controls.getByRole('button', { name: '下一根', exact: true }).click()
  await expect(controls).toContainText(':10 ')
  await expect(controls).toContainText('第 3 步')
  await expect.poll(last).toMatchObject({ timestamp: at, high: 1.1008, close: 1.1007, volume: 4 })
  await mode.selectOption('1s')
  await controls.getByRole('button', { name: '下一根', exact: true }).click()
  await expect.poll(last).toMatchObject({ timestamp: at, high: 1.1009, close: 1.1004, volume: 6 })
  await mode.selectOption('15s')
  await controls.getByRole('button', { name: '下一根', exact: true }).click()
  await expect.poll(last).toMatchObject({ timestamp: at, high: 1.101, low: 1.1003, close: 1.1003, volume: 8 })
  expect(tickRequests()).toBe(2)
})

test('updates a 15m chart at 1m steps and reveals every 1m bar at a 15m step', async ({ page }) => {
  const start = Date.UTC(2026, 10, 20, 14, 30)
  const forming = start + 15 * minute
  await page.clock.setFixedTime(new Date(start + 60 * minute))
  await connectFixture(page, false, { historyAvailable: time => time >= start - 15 * minute })
  const readChart = await installViewportProbe(page)
  await page.goto('./')

  const controls = page.getByTestId('replay-controls')
  const selectPeriod = async (timeframe: string) => {
    await page.getByRole('button', { name: '图表周期', exact: true }).click()
    await page.getByRole('button', { name: `选择周期 ${timeframe}`, exact: true }).click()
  }
  await selectPeriod('15m')
  await controls.getByRole('button', { name: '时间定位', exact: true }).click()
  const inputTime = await page.evaluate(timestamp =>
    new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000).toISOString().slice(0, 16), start)
  const locate = page.getByRole('dialog', { name: '图表时间定位' })
  await locate.getByLabel('图表跳转时间').fill(inputTime)
  await locate.getByRole('button', { name: '跳转', exact: true }).click()
  await expect.poll(async () => (await readChart()).rightmost).toBe(start)
  await expect(controls.locator('.replay-start-time')).toContainText(inputTime.replace('T', ' '))
  await controls.getByRole('button', { name: '创建回放', exact: true }).click()
  const last = () => readChart().then(chart => chart.last)
  const next = controls.getByRole('button', { name: '下一根', exact: true })
  await expect.poll(last).toMatchObject({ timestamp: start, volume: 42, ctraderClosed: true })
  await next.click()
  await expect.poll(last).toMatchObject({ timestamp: forming, volume: 42, ctraderClosed: false })
  await next.click()
  await expect.poll(last).toMatchObject({ timestamp: forming, volume: 84, ctraderClosed: false })

  await selectPeriod('1m')
  await expect.poll(last).toMatchObject({ timestamp: forming + minute, ctraderClosed: true })
  await controls.getByLabel('步进周期').selectOption('15m')
  await next.click()
  const revealed = Array.from({ length: 29 }, (_, index) => forming + (1 + index) * minute)
  await expect.poll(async () => (await readChart()).timestamps.slice(-revealed.length)).toEqual(revealed)
  await expect.poll(last).toMatchObject({ timestamp: revealed.at(-1), ctraderClosed: true })
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
  await expect.poll(async () => (await readChart()).events).toContainEqual(expect.objectContaining({ type: 'scroll', time: jumpAt }))
  await expect.poll(async () => (await readChart()).rightmost).toBe(jumpAt)
  await expect(controls.locator('.replay-start-time')).toContainText((await localInput(jumpAt)).replace('T', ' '))
  await controls.getByRole('button', { name: '回放设置', exact: true }).click()
  const setup = page.getByRole('dialog', { name: '回放会话设置' })
  await setup.getByText('IC Markets 交易规格', { exact: true }).click()
  await expect(setup.getByText('30 USD / 百万美元成交额', { exact: true })).toBeVisible()
  await expect(setup.getByText('200×（按名义金额分档）', { exact: true })).toBeVisible()
  await expect(setup.getByLabel('手续费率', { exact: true })).toHaveCount(0)
  const multiplier = setup.getByRole('spinbutton', { name: '杠杆倍率（×）' })
  const slippage = setup.getByRole('spinbutton', { name: '额外模拟滑点率' })
  const replayEnd = setup.getByLabel('回放结束时间')
  await expect(multiplier).toHaveValue('200')
  await multiplier.fill('150')
  await expect(replayEnd).toHaveCount(0)
  await setup.getByRole('button', { name: '开始历史回放', exact: true }).click()

  const next = controls.getByRole('button', { name: '下一根', exact: true })
  const lastCandle = () => readChart().then(chart => chart.last?.timestamp)
  await expect(controls).toContainText('第 1 步')
  await expect.poll(lastCandle).toBe(jumpAt)
  await controls.getByRole('button', { name: '时间定位', exact: true }).click()
  await locate.getByLabel('图表跳转时间').fill(await localInput(jumpAt + 8 * minute))
  await locate.getByRole('button', { name: '跳转', exact: true }).click()
  await expect(page.getByRole('contentinfo')).toContainText('图表已跳转到')
  expect(await lastCandle()).toBe(jumpAt)
  await expect(controls.getByLabel('步进周期')).toHaveValue('1m')
  await next.click()
  await expect(controls).toContainText('第 2 步')
  await expect.poll(() => messages.some(message => message.type === 2137 && message.period === 1)).toBe(true)
  await expect.poll(async () => (await readChart()).last).toMatchObject({ timestamp: jumpAt + 2 * minute, ctraderClosed: false })

  const trade = page.getByRole('complementary', { name: '模拟下单面板' })
  await expect(trade.getByRole('spinbutton', { name: '手数', exact: true })).toHaveValue('0.01')
  const settingsButton = controls.getByRole('button', { name: '回放设置', exact: true })
  const applyOrderSettings = setup.getByRole('button', { name: '应用交易参数' })
  const walletBalance = setup.getByRole('spinbutton', { name: '钱包余额' })
  const setBalance = setup.getByRole('button', { name: '设置余额' })
  const done = setup.getByRole('button', { name: '完成', exact: true })
  await settingsButton.click()
  await expect(setup.getByText('10000 USD', { exact: true })).toBeVisible()
  await expect(multiplier).toHaveValue('150')
  await expect(replayEnd).toHaveCount(0)
  await expect(setup.getByLabel('回放速度')).toHaveCount(0)
  await expect(setup.getByLabel('步进周期')).toHaveCount(0)
  await expect(setup.getByLabel('显示主图交易标记')).toHaveCount(0)
  await multiplier.fill('201')
  await expect(applyOrderSettings).toBeDisabled()
  await multiplier.fill('100')
  await slippage.fill('1')
  await expect(applyOrderSettings).toBeDisabled()
  await slippage.fill('0.001')
  await applyOrderSettings.click()
  await expect(applyOrderSettings).toBeDisabled()
  await done.click()
  await expect(trade.getByText('模拟杠杆 · 100×')).toBeVisible()
  await trade.getByRole('button', { name: '计算预估', exact: true }).click()
  await expect(trade.getByText('1.1016', { exact: true })).toBeVisible()
  await expect(trade.getByText('11.016', { exact: true })).toBeVisible()
  await expect(trade.getByText('0.033048', { exact: true })).toBeVisible()
  await trade.getByRole('button', { name: '开多', exact: true }).click()
  const position = page.getByTestId('position-long')
  await expect(position).toBeVisible()
  await settingsButton.click()
  await expect(walletBalance).toHaveValue('9999.966952')
  await walletBalance.fill('-1')
  await expect(setBalance).toBeDisabled()
  await walletBalance.fill('12500')
  await setBalance.click()
  await expect(setBalance).toBeDisabled()
  await done.click()
  await expect(position).toBeVisible()
  expect(messages.filter(message => message.type === 2121)).toHaveLength(1)
  expect(messages.filter(message => message.type === 2177)).toHaveLength(1)
  await next.click()
  await expect(controls).toContainText('第 3 步')
  await expect.poll(lastCandle).toBe(jumpAt + 2 * minute)

  await page.reload()
  await expect(controls).toContainText('第 3 步')
  await expect(position).toBeVisible()
  await settingsButton.click()
  await expect(multiplier).toHaveValue('100')
  await expect(slippage).toHaveValue('0.001')
  await expect(walletBalance).toHaveValue('12500')
  await setup.getByRole('button', { name: '使用默认杠杆' }).click()
  await expect(multiplier).toHaveValue('200')
  await applyOrderSettings.click()
  await expect(applyOrderSettings).toBeDisabled()
  await done.click()
  await expect(trade.getByText('模拟杠杆 · 200×')).toBeVisible()
  await expect.poll(lastCandle).toBe(jumpAt + 2 * minute)

  async function verifyTradingRecords() {
    await page.getByRole('tab', { name: '成交记录', exact: true }).click()
    const trades = page.getByRole('tabpanel', { name: '成交记录' })
    const fill = trades.getByRole('listitem')
    await expect(fill).toContainText('多仓')
    await expect(fill).toContainText('0.01 手')
    await expect(fill).toContainText('佣金')
    await expect(fill).toBeInViewport({ ratio: 1 })
    expect(await trades.evaluate(panel => panel.scrollWidth)).toBeLessThanOrEqual(await trades.evaluate(panel => panel.clientWidth))

    await page.getByRole('tab', { name: '账户流水', exact: true }).click()
    const ledger = page.getByRole('tabpanel', { name: '账户流水' })
    const entries = ledger.getByRole('listitem')
    await expect(entries.first()).toContainText('余额调整')
    await expect(entries.first()).toContainText('+2,500.0330 USD')
    await expect(entries.nth(1)).toContainText('交易佣金')
    await expect(entries.nth(1)).toContainText('-0.0330 USD')
    await expect(entries.nth(2)).toContainText('初始资金')
    await expect(ledger.getByText('变动后余额').first()).toBeInViewport()
    expect(await ledger.evaluate(panel => panel.scrollWidth)).toBeLessThanOrEqual(await ledger.evaluate(panel => panel.clientWidth))
  }

  await verifyTradingRecords()
  const reviewTab = page.getByRole('tab', { name: '复盘统计', exact: true })
  await reviewTab.click()
  const review = page.getByRole('tabpanel', { name: '复盘统计' })
  const balance = review.getByRole('slider', { name: '钱包余额曲线' })
  await expect(balance).toBeInViewport({ ratio: 1 })
  await expect(balance).toHaveAttribute('aria-valuenow', '2')
  await expect(balance).toHaveAttribute('aria-valuetext', /USD/)
  await balance.press('Home')
  await expect(balance).toHaveAttribute('aria-valuenow', '0')
  await review.getByRole('button', { name: '回撤', exact: true }).click()
  await expect(review.getByRole('slider', { name: '回撤曲线' })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('navigation', { name: '工作台快捷操作' }).getByRole('button', { name: /持仓/ }).click()
  await reviewTab.click()
  await expect(balance).toBeVisible()
  await review.getByRole('button', { name: '回撤', exact: true }).press('Tab')
  await expect(balance).toBeFocused()
  await review.getByRole('region', { name: '交易表现' }).scrollIntoViewIfNeeded()
  await expect(review.getByText('强平次数')).toBeInViewport()
  expect(await review.evaluate(panel => panel.scrollWidth)).toBeLessThanOrEqual(await review.evaluate(panel => panel.clientWidth))
  await verifyTradingRecords()
})
