import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { viewportProbeSource } from './e2e/viewport-probe-source'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [react(), {
      name: 'published-cloud-connection',
      generateBundle() {
        const token = env.VITE_GITHUB_TOKEN?.trim()
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
    server: { watch: { ignored: ['**/test-results/**', '**/test-results-*/**'] } },
  }
})
