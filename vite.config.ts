import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import { viewportProbeSource } from './e2e/viewport-probe-source'
import { parseCTraderConnection } from './src/market-data/ctrader-connection-config'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const publicDir = env.E2E_CHART_PROBE === '1' && process.env.E2E_PAGES_PUBLIC_DIR
    ? process.env.E2E_PAGES_PUBLIC_DIR : 'public'
  return {
    base: env.VITE_BASE_PATH || '/',
    publicDir,
    envPrefix: ['VITE_GITHUB_OWNER', 'VITE_GITHUB_REPOSITORY', 'VITE_GITHUB_BRANCH'],
    plugins: [react(), {
      name: 'published-connections',
      apply: 'build',
      buildStart() {
        if (process.env.REQUIRE_CTRADER_CONNECTION !== '1') return
        let value: unknown
        try {
          value = JSON.parse(readFileSync(resolve(publicDir, 'ctrader-connection.json'), 'utf8'))
        } catch {
          throw new Error('请在 public/ctrader-connection.json 中填写有效的 cTrader 发布配置。')
        }
        if (!parseCTraderConnection(value)) throw new Error('cTrader 发布连接配置缺少必要字段。')
      },
      generateBundle() {
        const token = process.env.CLOUD_STORAGE_TOKEN?.trim()
        if (token) this.emitFile({
          type: 'asset',
          fileName: 'cloud-connection.json',
          source: JSON.stringify({ schemaVersion: 1, project: 'crypto-contract-workstation', token }),
        })
      },
    }, ...(env.E2E_CHART_PROBE === '1' ? [{
      name: 'e2e-chart-probe',
      enforce: 'pre' as const,
      transform(source: string, id: string) {
        if (id.replaceAll('\\', '/').split('?')[0].endsWith('/src/chart/pro-chart-adapter.ts')) {
          return { code: `${source}\n${viewportProbeSource}`, map: null }
        }
      },
    }] : [])],
    // Serve the patched chart directly so dependency prebundling cannot retain
    // older chart implementations after patch-package updates.
    optimizeDeps: { exclude: ['@klinecharts/pro', 'klinecharts'] },
    // Playwright writes large attachments while Vite runs. Watching those
    // generated files can fail with EBUSY on Windows and restart test pages.
    server: { watch: { ignored: ['**/test-results/**', '**/test-results-*/**', '**/ctrader-connection.local.json'] } },
  }
})
