import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['ctrader-workstation.spec.ts', 'workspace-keyboard.spec.ts', 'bybit-workstation.spec.ts', 'okx-workstation.spec.ts'],
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
      fullyParallel: true,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    port: 4173,
    // Reusing an ordinary dev server would omit the test-only instrumentation.
    reuseExistingServer: false,
    env: { E2E_CHART_PROBE: '1' },
  },
})
