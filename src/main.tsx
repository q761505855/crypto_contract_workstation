import '@klinecharts/pro/dist/klinecharts-pro.css'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import { createMarketDataRuntime } from './market-data/runtime'
import { ConfigAutoSync } from './github-sync/config-auto-sync'
import { resolveDefaultGitHubToken } from './github-sync/default-storage'
import { CHART_WINDOW_QUERY } from './chart/chart-window'
import { AuxiliaryChartWindow } from './chart/AuxiliaryChartWindow'
import { ctraderStorage } from './storage/ctrader-storage'

const rootElement = document.getElementById('root')
if (rootElement === null) {
  throw new Error('Root element #root was not found.')
}

const root = createRoot(rootElement)
if (new URLSearchParams(window.location.search).has(CHART_WINDOW_QUERY)) {
  root.render(<AuxiliaryChartWindow />)
} else {
  root.render(<div className="startup-sync" role="status">正在检查云端配置…</div>)
  const runtime = createMarketDataRuntime(await resolveDefaultGitHubToken())
  if (runtime.defaultGitHubClient) {
    runtime.configSync = new ConfigAutoSync({ storage: ctraderStorage, backups: runtime.backups, sync: runtime.githubSync, client: runtime.defaultGitHubClient })
    await runtime.configSync.start()
  }
  runtime.drawingSync.start()
  window.addEventListener('pagehide', event => {
    runtime.drawingSync.stop()
    if (!event.persisted) runtime.disposeMarketConnection()
  })
  window.addEventListener('pageshow', event => { if (event.persisted) runtime.drawingSync.start() })
  root.render(<App runtime={runtime} />)
}
