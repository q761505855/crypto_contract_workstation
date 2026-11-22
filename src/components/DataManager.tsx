import { useEffect, useRef, useState } from 'react'
import type { MarketDataRuntime } from '../market-data/runtime'
import { BackupSyncPanel } from './BackupSyncPanel'
import { DrawingStorage } from './DrawingStorage'

interface DataManagerProps {
  runtime: MarketDataRuntime
  onClose(): void
}

export function DataManager({ runtime, onClose }: DataManagerProps) {
  const okx = runtime.service?.source === 'okx'
  const refreshRequest = useRef<AbortController | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => () => refreshRequest.current?.abort(), [])

  async function refreshSymbols(): Promise<void> {
    const request = new AbortController()
    refreshRequest.current = request
    setLoading(true)
    setError('')
    try {
      await runtime.service.getSymbols({ forceRefresh: true, signal: request.signal })
    } catch (reason) {
      if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取品种。')
    } finally {
      refreshRequest.current = null
      if (!request.signal.aborted) setLoading(false)
    }
  }

  return (
    <>
      <button aria-label="关闭数据管理" className="drawer-backdrop" onClick={onClose} type="button" />
      <aside aria-label="数据管理" aria-modal="true" className="data-drawer" data-testid="data-manager" role="dialog">
        <header>
          <h2>数据管理</h2>
          <button data-testid="close-data-manager" onClick={onClose} type="button">关闭</button>
        </header>
        <section>
          <h3>{okx ? 'OKX 行情' : 'cTrader 行情'}</h3>
          <p className="muted-text">{okx ? '使用 OKX 公开行情接口读取 USDT 永续合约目录和成交价 K 线。'
            : '网页直连所选 cTrader 账户，按图表或回放周期读取原生 K 线。行情缓存在当前页面。'}</p>
          <button disabled={loading} onClick={() => void refreshSymbols()} type="button">刷新品种列表</button>
          {loading && <span role="status">正在读取品种…</span>}
          {error && <p className="data-error" role="alert">{error}</p>}
        </section>
        {runtime.drawingSync && <DrawingStorage service={runtime.drawingSync} disabled={false} />}
        <BackupSyncPanel runtime={runtime} disabled={false} />
      </aside>
    </>
  )
}
