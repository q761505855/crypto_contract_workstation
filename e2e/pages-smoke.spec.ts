import { expect, test } from '@playwright/test'
import { PUBLISHED_CLOUD_CONNECTION_URL } from '../src/github-sync/default-storage'
import { mockCloudConnection } from './cloud-connection-fixture'

test.beforeEach(async ({ page }) => {
  await page.route('**/ctrader-connection.json', route => route.fulfill({ status: 404 }))
})

test('publishes the isolated connection and authenticates cloud requests without manual input', { tag: '@release' }, async ({ page, request, baseURL }) => {
  const connection = await request.get(new URL('cloud-connection.json', baseURL!).href)
  expect(connection.ok()).toBe(true)
  const published = await connection.json()
  expect(published).toEqual(mockCloudConnection)
  const marketConfiguration = await request.get(new URL('ctrader-connection.json', baseURL!).href)
  expect(marketConfiguration.ok()).toBe(true)
  const market = await marketConfiguration.json()
  const testConnection = {
    clientId: 'e2e-published-app', clientSecret: 'e2e-published-secret', accessToken: 'e2e-published-view', accountId: null,
  }
  expect(Object.keys(market).sort()).toEqual(Object.keys(testConnection).sort())
  expect(Object.entries(testConnection).every(([key, value]) => market[key] === value)).toBe(true)
  const authorization: (string | undefined)[] = []
  await page.route(/^https:\/\//, route => {
    if (route.request().url().startsWith('https://api.github.com/')) authorization.push(route.request().headers().authorization)
    return route.fulfill({ status: 404, json: { message: 'Not Found' } })
  })
  await page.route(PUBLISHED_CLOUD_CONNECTION_URL, route => route.fulfill({
    headers: { 'access-control-allow-origin': '*' },
    json: published,
  }))
  await page.goto('./')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('工作站')
  expect(authorization.length).toBeGreaterThan(0)
  expect(authorization.every(value => value === `Bearer ${mockCloudConnection.token}`)).toBe(true)
})

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`boots the published site and opens its controls at ${viewport.width}px`, { tag: '@release' }, async ({ page, baseURL }) => {
    await page.setViewportSize(viewport)
    const errors: string[] = []
    const failedAssets: string[] = []
    const loadedAssets: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (response.url().startsWith(baseURL!) && /\.(js|css)(?:\?|$)/.test(response.url())) {
        if (response.ok()) loadedAssets.push(response.url())
        else failedAssets.push(`${response.status()} ${response.url()}`)
      }
    })
    await page.route(/^https:\/\//, route => route.fulfill({ status: 404, json: { message: 'Not Found' } }))
    const response = await page.goto('./')
    expect(response?.ok()).toBe(true)
    await expect(page.getByRole('button', { name: '历史模拟', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.klinecharts-pro-period-bar .symbol')).toContainText('EURUSD')
    await expect(page.getByRole('contentinfo')).toContainText('cTrader 账户连接配置')
    await expect(page.locator('canvas').first()).toBeVisible()
    await page.getByRole('button', { name: '回放设置', exact: true }).click()
    const replaySettings = page.getByRole('dialog', { name: '回放会话设置', exact: true })
    await expect(replaySettings).toBeVisible()
    await replaySettings.getByRole('button', { name: '关闭回放会话设置' }).click()
    const tools = page.getByRole('button', { name: '工具', exact: true })
    const toolsMenu = page.getByRole('navigation', { name: '工作站工具' })
    await expect(toolsMenu).toBeHidden()
    await tools.click()
    await expect(toolsMenu).toBeInViewport()
    await expect(toolsMenu.getByRole('button', { name: '打开副图' })).toHaveCount(viewport.width >= 768 ? 1 : 0)
    await toolsMenu.getByRole('button', { name: '图表尺寸' }).press('Escape')
    await expect(toolsMenu).toBeHidden()
    await expect(tools).toBeFocused()
    await tools.click()
    await page.getByRole('button', { name: '实时行情', exact: true }).click()
    await expect(toolsMenu).toBeHidden()
    await tools.click()
    await page.getByTestId('open-data-manager').click()
    await expect(toolsMenu).toBeHidden()
    await expect(page.getByRole('dialog', { name: '数据管理', exact: true })).toBeVisible()
    await page.getByTestId('close-data-manager').click()
    await expect(page.getByRole('dialog', { name: '数据管理', exact: true })).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width)
    expect(loadedAssets.some(url => url.includes('.js'))).toBe(true)
    expect(loadedAssets.some(url => url.includes('.css'))).toBe(true)
    expect(failedAssets).toEqual([])
    expect(errors).toEqual([])
  })
}
