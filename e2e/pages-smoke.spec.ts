import { expect, test } from '@playwright/test'

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`boots the published site and opens its controls at ${viewport.width}px`, async ({ page, baseURL }) => {
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
    // Publishing must not depend on live exchange/cloud availability or import
    // whole months of candles. Those workflows remain in the full CI suite.
    await page.route('https://**', route => route.fulfill({ status: 404, json: { message: 'Not Found' } }))
    const response = await page.goto('./')
    expect(response?.ok()).toBe(true)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('工作站')
    await expect(page.locator('.klinecharts-pro-period-bar .symbol')).toContainText('BTCUSDT')
    await expect(page.locator('canvas').first()).toBeVisible()
    await page.getByRole('button', { name: '回放设置', exact: true }).click()
    const replaySettings = page.getByRole('dialog', { name: '回放会话设置', exact: true })
    await expect(replaySettings).toBeVisible()
    await replaySettings.getByRole('button', { name: '关闭回放会话设置' }).click()
    await page.getByTestId('open-data-manager').click()
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
