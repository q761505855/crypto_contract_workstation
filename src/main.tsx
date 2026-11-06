import '@klinecharts/pro/dist/klinecharts-pro.css'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import { createMarketDataRuntime } from './market-data/runtime'
import { ConfigAutoSync } from './github-sync/config-auto-sync'

const rootElement = document.getElementById('root')
if (rootElement === null) {
  throw new Error('Root element #root was not found.')
}

const root = createRoot(rootElement)
root.render(<div className="startup-sync" role="status">正在检查云端配置…</div>)
const runtime = createMarketDataRuntime()
if (runtime.defaultGitHubClient) {
  runtime.configSync = new ConfigAutoSync({ storage: localStorage, backups: runtime.backups, sync: runtime.githubSync, client: runtime.defaultGitHubClient })
  await runtime.configSync.start()
}
// Construct the UI only after cloud preferences are applied (or a bounded
// network failure). Old chart/layout state cannot write over startup restore.
runtime.service.setBaseUrl((await runtime.backups.exportPreferences()).data.preferences!.binanceRestBaseUrl)
root.render(<App runtime={runtime} />)
