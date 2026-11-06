import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [react()],
    // Serve the patched chart directly so dependency prebundling cannot retain
    // older chart implementations after patch-package updates.
    optimizeDeps: { exclude: ['@klinecharts/pro', 'klinecharts'] },
    // Playwright writes large attachments while Vite runs. Watching those
    // generated files can fail with EBUSY on Windows and restart test pages.
    server: { watch: { ignored: ['**/test-results/**', '**/test-results-*/**'] } },
  }
})
