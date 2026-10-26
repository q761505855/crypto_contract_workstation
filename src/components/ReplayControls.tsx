import { useEffect, useState } from 'react'
import type { MarketSelection } from '../market-data/models'
import type {
  ReplaySession,
  ReplaySpeed,
} from '../replay/models'
import { DEFAULT_TRADING_CONFIG } from '../replay/models'
import type { ReplayController } from '../replay/useReplayController'
import { TimeJumpControl } from './TimeJumpControl'

interface ReplayControlsProps {
  selection: MarketSelection
  replay: ReplayController
  interactionLocked?: boolean
  chartStartTime: number | null
  onJumpToTime: (timestamp: number) => void
}

function displayTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false,
  }).format(timestamp)
}

function sessionName(session: ReplaySession): string {
  return `${session.symbol.ticker} ${session.period.text} · ${displayTime(
    session.startTime,
  )}`
}

export function ReplayControls({
  selection,
  replay,
  interactionLocked = false,
  chartStartTime,
  onJumpToTime,
}: ReplayControlsProps) {
  const [toText, setToText] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [initialBalance, setInitialBalance] = useState(
    DEFAULT_TRADING_CONFIG.initialBalance,
  )
  const [leverage, setLeverage] = useState(
    String(DEFAULT_TRADING_CONFIG.leverage),
  )
  const [feeRate, setFeeRate] = useState(
    DEFAULT_TRADING_CONFIG.feeRate,
  )
  const [slippageRate, setSlippageRate] = useState(
    DEFAULT_TRADING_CONFIG.slippageRate,
  )
  const [maintenanceMarginRate, setMaintenanceMarginRate] = useState(
    DEFAULT_TRADING_CONFIG.maintenanceMarginRate,
  )
  const [liquidationFeeRate, setLiquidationFeeRate] = useState(
    DEFAULT_TRADING_CONFIG.liquidationFeeRate,
  )

  useEffect(() => {
    if (
      selectedSessionId.length === 0 &&
      replay.sessions.length > 0
    ) {
      setSelectedSessionId(replay.sessions[0].id)
    }
  }, [replay.sessions, selectedSessionId])

  useEffect(() => {
    if (replay.session === null) setToText('')
  }, [replay.session])

  if (replay.session === null) {
    return (
      <section className="replay-controls replay-setup" data-testid="replay-controls">
        <TimeJumpControl
          disabled={replay.busy}
          onJump={onJumpToTime}
        />
        <span>
          创建回放：{selection.symbol.ticker} · {selection.period.text}
        </span>
        <span className="replay-start-time">
          起点：
          {chartStartTime === null
            ? '等待图表 K 线'
            : displayTime(chartStartTime)}
        </span>
        <label>
          结束（可选）
          <input
            aria-label="回放结束时间"
            onChange={(event) => setToText(event.target.value)}
            type="datetime-local"
            value={toText}
          />
        </label>
        <button
          disabled={replay.busy || chartStartTime === null}
          onClick={() => {
            if (chartStartTime === null) return
            void replay.createSession({
              symbol: selection.symbol,
              period: selection.period,
              startTime: chartStartTime,
              ...(toText.length === 0
                ? {}
                : { endTime: new Date(toText).getTime() }),
              tradingConfig: {
                initialBalance,
                leverage: Number(leverage),
                feeRate,
                slippageRate,
                maintenanceMarginRate,
                liquidationFeeRate,
              },
            })
          }}
          type="button"
        >
          {replay.busy ? '准备中…' : '创建回放'}
        </button>
        <label>
          初始资金
          <input
            aria-label="初始资金"
            min="0"
            onChange={(event) => setInitialBalance(event.target.value)}
            step="100"
            type="number"
            value={initialBalance}
          />
        </label>
        <label>
          杠杆
          <input
            aria-label="杠杆"
            min="1"
            onChange={(event) => setLeverage(event.target.value)}
            step="1"
            type="number"
            value={leverage}
          />
        </label>
        <details className="replay-advanced">
          <summary>交易参数</summary>
          <div>
            <label>
              手续费率
              <input
                aria-label="手续费率"
                min="0"
                onChange={(event) => setFeeRate(event.target.value)}
                step="0.0001"
                type="number"
                value={feeRate}
              />
            </label>
            <label>
              滑点率
              <input
                aria-label="滑点率"
                min="0"
                onChange={(event) => setSlippageRate(event.target.value)}
                step="0.0001"
                type="number"
                value={slippageRate}
              />
            </label>
            <label>
              维持保证金率
              <input
                aria-label="维持保证金率"
                min="0"
                onChange={(event) =>
                  setMaintenanceMarginRate(event.target.value)
                }
                step="0.0001"
                type="number"
                value={maintenanceMarginRate}
              />
            </label>
            <label>
              强平费用率
              <input
                aria-label="强平费用率"
                min="0"
                onChange={(event) =>
                  setLiquidationFeeRate(event.target.value)
                }
                step="0.0001"
                type="number"
                value={liquidationFeeRate}
              />
            </label>
          </div>
        </details>
        {replay.sessions.length > 0 && (
          <>
            <select
              aria-label="已有回放会话"
              onChange={(event) => setSelectedSessionId(event.target.value)}
              value={selectedSessionId}
            >
              {replay.sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {sessionName(session)}
                </option>
              ))}
            </select>
            <button
              disabled={replay.busy || selectedSessionId.length === 0}
              onClick={() => void replay.loadSession(selectedSessionId)}
              type="button"
            >
              加载会话
            </button>
          </>
        )}
        {replay.error.length > 0 && (
          <span className="replay-error" role="alert">
            {replay.error}
          </span>
        )}
      </section>
    )
  }

  const session = replay.session
  return (
    <section className="replay-controls" data-testid="replay-controls">
      <TimeJumpControl
        disabled={interactionLocked}
        onJump={onJumpToTime}
      />
      <span className="replay-position">
        {session.symbol.ticker} · 步进 {session.period.text} · 当前：
        {displayTime(session.currentTime)} · {session.currentIndex + 1}/
        {session.candleCount}
      </span>
      <button
        disabled={
          interactionLocked ||
          session.currentIndex === 0 ||
          session.hasTrades
        }
        onClick={replay.previous}
        type="button"
      >
        上一根
      </button>
      <button
        disabled={interactionLocked || session.status === 'completed'}
        onClick={() => void replay.next()}
        type="button"
      >
        下一根
      </button>
      <button
        disabled={interactionLocked || session.status === 'completed'}
        onClick={replay.isPlaying ? replay.pause : replay.play}
        type="button"
      >
        {replay.isPlaying ? '暂停' : '播放'}
      </button>
      <select
        aria-label="回放速度"
        onChange={(event) =>
          replay.setSpeed(Number(event.target.value) as ReplaySpeed)
        }
        value={session.speed}
      >
        {[1, 2, 5, 10].map((speed) => (
          <option key={speed} value={speed}>
            {speed}x
          </option>
        ))}
      </select>
      <button
        disabled={interactionLocked || session.status === 'completed'}
        onClick={() => void replay.jumpToEnd()}
        type="button"
      >
        跳转结束
      </button>
      <button
        disabled={interactionLocked}
        onClick={() => {
          if (
            !session.hasTrades ||
            window.confirm('重置回放会清空当前模拟交易记录，是否继续？')
          ) {
            void replay.reset()
          }
        }}
        type="button"
      >
        重置
      </button>
      <button onClick={() => void replay.endSession()} type="button">
        结束会话
      </button>
      {replay.error.length > 0 && (
        <span className="replay-error" role="alert">
          {replay.error}
        </span>
      )}
    </section>
  )
}
