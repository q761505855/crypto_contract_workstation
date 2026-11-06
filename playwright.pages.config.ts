import { defineConfig, devices } from '@playwright/test'

const pagesUrl = 'http://127.0.0.1:4174/crypto_contract_workstation/'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: pagesUrl,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node scripts/preview-pages-e2e.mjs',
    url: pagesUrl,
    reuseExistingServer: false,
  },
})
