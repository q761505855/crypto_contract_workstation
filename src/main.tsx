import '@klinecharts/pro/dist/klinecharts-pro.css'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import { createMarketDataRuntime } from './market-data/runtime'
import { ConfigAutoSync } from './github-sync/config-auto-sync'
import { resolveDefaultGitHubToken } from './github-sync/default-storage'
import { CHART_WINDOW_QUERY } from './chart/chart-window'
import { AuxiliaryChartWindow } from './chart/AuxiliaryChartWindow'

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
    runtime.configSync = new ConfigAutoSync({ storage: localStorage, backups: runtime.backups, sync: runtime.githubSync, client: runtime.defaultGitHubClient })
    await runtime.configSync.start()
  }
  // Construct the UI after cloud preferences are applied or the sync attempt ends.
  runtime.service.setBaseUrl((await runtime.backups.exportPreferences()).data.preferences!.binanceRestBaseUrl)
  runtime.drawingSync.start()
  window.addEventListener('pagehide', () => runtime.drawingSync.stop())
  window.addEventListener('pageshow', event => { if (event.persisted) runtime.drawingSync.start() })
  root.render(<App runtime={runtime} />)
}
