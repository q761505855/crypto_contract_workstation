import type { LiveMarketStatus } from '../market-data/live-models'

function displayTradeTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

const connectionLabels: Record<
  LiveMarketStatus['connection'],
  string
> = {
  connecting: '正在连接',
  connected: '已连接',
  reconnecting: '正在重连',
  disconnected: '已断开',
}

export function LiveStatus({ status }: { status: LiveMarketStatus }) {
  return (
    <aside className="side-panel" data-testid="live-status">
      <h2>实时行情</h2>
      <p>只读模式</p>
      <dl>
        <div>
          <dt>连接状态</dt>
          <dd>{connectionLabels[status.connection]}</dd>
        </div>
        <div>
          <dt>最后消息</dt>
          <dd>
            {status.lastMessageTime === null
              ? '—'
              : displayTradeTime(status.lastMessageTime)}
          </dd>
        </div>
        <div>
          <dt>数据延迟</dt>
          <dd>
            {status.latencyMs === null ? '—' : `${status.latencyMs} ms`}
          </dd>
        </div>
        <div>
          <dt>当前 K 线</dt>
          <dd>
            {status.candleClosed === null
              ? '—'
              : status.candleClosed
                ? '已完成'
                : '进行中'}
          </dd>
        </div>
        <div>
          <dt>最新价格</dt>
          <dd>{status.lastPrice ?? '—'}</dd>
        </div>
        {status.reconnectAttempt > 0 && (
          <div>
            <dt>重连次数</dt>
            <dd>{status.reconnectAttempt}</dd>
          </div>
        )}
      </dl>
      {status.warning.length > 0 && (
        <p className="panel-warning">{status.warning}</p>
      )}
      <p className="muted-text">此模式不提供任何下单操作。</p>
    </aside>
  )
}
