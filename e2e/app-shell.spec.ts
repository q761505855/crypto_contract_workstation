import { expect, test } from '@playwright/test'

test('renders Pro chart shell and keeps live mode read-only', async ({ page }) => {
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: '加密货币合约回放工作站' }),
  ).toBeVisible()
  await expect(page.getByTestId('chart-host')).toBeVisible()
  await expect(page.getByText('指标', { exact: true })).toBeVisible()
  await expect(page.getByText('15m', { exact: true })).toBeVisible()
  await expect
    .poll(async () => page.getByTestId('chart-host').locator('canvas').count())
    .toBeGreaterThan(0)

  await page.getByRole('button', { name: '实时行情' }).click()
  await expect(page.getByTestId('live-status')).toContainText('只读模式')
  await expect(page.getByTestId('simulation-panel')).toHaveCount(0)
  await expect(page.getByTestId('replay-controls')).toHaveCount(0)
})
