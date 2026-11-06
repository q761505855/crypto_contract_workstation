import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true })

test('keeps landscape forms and drawers within the visible viewport when a keyboard opens', async ({ page }) => {
  // Chromium desktop does not open a handset keyboard; emulate its viewport
  // resize event while retaining the full layout viewport, as mobile browsers do.
  await page.addInitScript(() => {
    const viewport = window.visualViewport!
    let height = 390
    Object.defineProperty(viewport, 'height', { get: () => height, configurable: true })
    Object.defineProperty(viewport, 'offsetTop', { get: () => 0, configurable: true })
    ;(window as unknown as { shrinkVisibleViewport(value: number): void }).shrinkVisibleViewport = value => {
      height = value
      viewport.dispatchEvent(new Event('resize'))
    }
  })
  await page.route('**/*', route => route.request().url().startsWith('https:') ? route.abort() : route.continue())
  await page.goto('./')
  await page.getByRole('button', { name: '回放设置', exact: true }).tap()
  await page.evaluate(() => (window as unknown as { shrinkVisibleViewport(value: number): void }).shrinkVisibleViewport(150))
  const dialog = page.getByRole('dialog', { name: '回放会话设置', exact: true })
  await expect.poll(async () => {
    const box = (await dialog.boundingBox())!
    return box.y >= 0 && box.y + box.height <= 150
  }).toBe(true)
  await expect(dialog.getByRole('button', { name: '关闭回放会话设置' })).toBeInViewport()
  await dialog.getByRole('button', { name: '关闭回放会话设置' }).tap()
  await page.getByRole('button', { name: '下单', exact: true }).tap()
  const drawer = page.getByRole('complementary', { name: '模拟下单面板' })
  const box = (await drawer.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(150)
  await expect(drawer.getByRole('button', { name: '收起下单面板' })).toBeInViewport()
  await page.evaluate(() => (window as unknown as { shrinkVisibleViewport(value: number): void }).shrinkVisibleViewport(390))
  await page.getByRole('button', { name: '看图', exact: true }).tap()
})
