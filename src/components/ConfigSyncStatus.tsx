import { useSyncExternalStore } from 'react'
import type { ConfigAutoSync } from '../github-sync/config-auto-sync'

export function ConfigSyncStatus({ service }: { service: ConfigAutoSync }) {
  const status = useSyncExternalStore(service.subscribe, service.getStatus)
  return <div className={`config-sync-status is-${status.phase}`} data-testid="config-sync-status" role="status">
    <span title={status.message}>{status.message}</span>
    {status.phase === 'conflict' && <div className="button-row">
      <button type="button" onClick={() => void service.resolve('local')}>保留本地并同步</button>
      <button type="button" onClick={() => void service.resolve('remote')}>使用云端冲突项</button>
    </div>}
    {status.phase === 'error' && <button type="button" onClick={() => void service.flush()}>立即重试</button>}
  </div>
}
