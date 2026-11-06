import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  workers: 2,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  // Keep individual durations visible so regressions are identifiable in CI.
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      grepInvert: /@integration/,
      fullyParallel: true,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-integration',
      grep: /@integration/,
      grepInvert: /@month-buffer|@production-path/,
      fullyParallel: false,
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-monthly-replay',
      grep: /@month-buffer/,
      fullyParallel: false,
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-production',
      grep: /@production-path/,
      fullyParallel: false,
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    port: 4173,
    // Reusing an ordinary dev server would omit the test-only instrumentation.
    reuseExistingServer: false,
    // Browser tests must never use a real deployment credential.
    env: { VITE_GITHUB_TOKEN: 'e2e-mock-storage-token', E2E_CHART_PROBE: '1' },
  },
})
