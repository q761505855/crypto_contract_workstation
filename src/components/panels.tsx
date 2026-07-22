export function SimulationPanel() {
  return (
    <aside className="side-panel" data-testid="simulation-panel">
      <section>
        <h2>模拟账户</h2>
        <dl>
          <div>
            <dt>余额</dt>
            <dd>10,000.00 USDT</dd>
          </div>
          <div>
            <dt>权益</dt>
            <dd>10,000.00 USDT</dd>
          </div>
          <div>
            <dt>浮动盈亏</dt>
            <dd>0.00 USDT</dd>
          </div>
        </dl>
      </section>
      <section>
        <h2>模拟下单</h2>
        <p>Phase 4 接入开仓、加仓、减仓、止盈、止损和强平。</p>
        <button disabled type="button">
          开多
        </button>
        <button disabled type="button">
          开空
        </button>
      </section>
    </aside>
  )
}

export function ReplayControls() {
  return (
    <section className="replay-controls" data-testid="replay-controls">
      <span>当前时间：尚未创建会话</span>
      <button disabled type="button">
        上一根
      </button>
      <button disabled type="button">
        下一根
      </button>
      <button disabled type="button">
        播放
      </button>
    </section>
  )
}

export function LiveStatus() {
  return (
    <aside className="side-panel" data-testid="live-status">
      <h2>实时行情</h2>
      <p>只读模式</p>
      <p>Phase 5 接入币安公开 WebSocket。</p>
    </aside>
  )
}
