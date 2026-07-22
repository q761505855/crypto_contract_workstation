import { expect, test } from '@playwright/test'

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
  const notFoundResponses: string[] = []
  const runtimeErrors: string[] = []
  page.on('response', (response) => {
    if (response.status() === 404) notFoundResponses.push(response.url())
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
  await expect(
    page.locator('.klinecharts-pro-period-bar .period.selected'),
  ).toHaveText('15m')
  await expectCanvasContent(page)

  await page.locator('.klinecharts-pro-period-bar .symbol').click()
  const symbolSearch = page.getByPlaceholder('商品代码')
  await symbolSearch.fill('ETHUSDT')
  await symbolSearch.press('Tab')
  const ethRow = page
    .locator('.klinecharts-pro-symbol-search-modal-list li')
    .filter({ hasText: 'ETHUSDT' })
  await expect(ethRow).toHaveCount(1)
  await ethRow.click({ position: { x: 5, y: 20 } })
  await expect(page.locator('.klinecharts-pro-period-bar .symbol')).toHaveText(
    'ETHUSDT',
  )

  const oneHour = page
    .locator('.klinecharts-pro-period-bar .period')
    .filter({ hasText: /^1h$/ })
  await oneHour.click()
  await expect(oneHour).toHaveClass(/selected/)

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

  const originalChartHost = await chartHost.elementHandle()
  expect(originalChartHost).not.toBeNull()

  await page.getByRole('button', { name: '实时行情' }).click()
  await expect(page.getByTestId('live-status')).toContainText('只读模式')
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
  await expectCanvasContent(page)
  expect(notFoundResponses).toEqual([])
  expect(runtimeErrors).toEqual([])
})
