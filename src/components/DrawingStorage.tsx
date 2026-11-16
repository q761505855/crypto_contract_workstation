import { useState, useSyncExternalStore } from 'react'
import type { DrawingAutoSync } from '../github-sync/drawing-auto-sync'

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KB`
}

export function DrawingStorage({ service, disabled }: { service: DrawingAutoSync; disabled: boolean }) {
  const { store } = service
  const raw = useSyncExternalStore(store.subscribe, store.snapshot)
  const { local, cloudBytes } = store.read(raw)
  const status = useSyncExternalStore(service.subscribe, service.getStatus)
  const [error, setError] = useState('')
  const localBytes = local.drawings.length ? new TextEncoder().encode(JSON.stringify(local)).length : 0

  async function clear(): Promise<void> {
    if (!window.confirm('清空所有产品和回放会话的绘图？此操作将自动同步到云端和其他设备。')) return
    try {
      await store.replace([])
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '清空失败')
    }
  }

  return <section aria-label="图表绘图存档">
    <h3>图表绘图存档</h3>
    <p className="muted-text">全部绘图 {local.drawings.length.toLocaleString()} 个 · 本机 {sizeText(localBytes)} · 云端文件 {cloudBytes === null ? '尚未读取' : sizeText(cloudBytes)}</p>
    <p className="muted-text" role="status">{status.message}</p>
    <div className="button-row">
      <button className="danger-button" type="button" disabled={disabled} onClick={() => void clear()}>一键清空绘图</button>
      {status.phase === 'conflict' && <>
        <button type="button" onClick={() => service.resolve('local')}>保留本地绘图冲突项</button>
        <button type="button" onClick={() => service.resolve('remote')}>使用云端绘图冲突项</button>
      </>}
      {status.phase === 'error' && <button type="button" onClick={() => void service.flush()}>重试绘图同步</button>}
    </div>
    {error && <p role="alert" className="data-error">{error}</p>}
  </section>
}
