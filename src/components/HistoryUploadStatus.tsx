import { useEffect, useState } from 'react'
import type { MarketDataService } from '../market-data/market-data-service'

export interface HistoryUploadStatusProps {
  service: Pick<MarketDataService, 'getPendingUploadCount'>
  onOpen(): void
}

export function HistoryUploadStatus({ service, onOpen }: HistoryUploadStatusProps) {
  const [pending, setPending] = useState(() => service.getPendingUploadCount())
  useEffect(() => {
    const update = () => setPending(service.getPendingUploadCount())
    update()
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  }, [service])
  if (pending === 0) return null
  return (
    <button className="history-upload-status" data-testid="history-upload-status" type="button" onClick={onOpen}>
      已缓存，云端待上传：{pending} 个月 · 查看
    </button>
  )
}
