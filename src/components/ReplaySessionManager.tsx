import { useState } from 'react'
import { formatDisplayTime } from '../format-display-time'
import { isLocalPriceSource, isPriceSource, priceSourceLabel, type PriceSource } from '../market-data/price-source-preferences'
import { REPLAY_NAME_LIMIT, REPLAY_NOTES_LIMIT, sessionPlaybackMode, type ReplaySession } from '../replay/models'
import type { useCTraderReplayController } from '../replay/useCTraderReplayController'
import { WorkspaceDialog } from './WorkspaceDialog'
import './replay-session-manager.css'

type SessionActions = Pick<ReturnType<typeof useCTraderReplayController>, 'session' | 'sessions' | 'busy' | 'error' |
  'preparationStatus' | 'loadSession' | 'deleteSession' | 'editSessionDetails' | 'clearError'>

function sourceName(session: ReplaySession): string {
  return isPriceSource(session.marketSource) ? priceSourceLabel(session.marketSource) : '币安旧存档'
}

function titleOf(session: ReplaySession): string {
  return session.name?.trim() || `${session.symbol.ticker} · ${session.period.text} · ${formatDisplayTime(session.startTime)}`
}

function SessionDetails({ session, replay, source, onLoaded, onOpenLocalData }: {
  session: ReplaySession
  replay: SessionActions
  source: PriceSource
  onLoaded(): void
  onOpenLocalData?: () => void
}) {
  const [name, setName] = useState(session.name ?? '')
  const [notes, setNotes] = useState(session.notes ?? '')
  const current = replay.session?.id === session.id
  const canLoad = session.marketSource === source
  const dirty = name !== (session.name ?? '') || notes !== (session.notes ?? '')
  const time = (value: number) => formatDisplayTime(value, undefined, 'second')
  return <section className="replay-session-detail" aria-label="会话详情">
    <h3>{titleOf(session)}</h3>
    <dl className="detail-list">
      <div><dt>行情来源</dt><dd>{sourceName(session)}</dd></div>
      <div><dt>品种和周期</dt><dd>{session.symbol.ticker} · {session.period.text}</dd></div>
      <div><dt>回放模式</dt><dd>{sessionPlaybackMode(session) === 'tick' ? '逐笔' : 'K 线'}</dd></div>
      <div><dt>状态</dt><dd>{current ? '当前会话' : session.status === 'completed' ? '已完成' : '已保存'}{session.hasTrades && ' · 有成交'}</dd></div>
      <div><dt>起点</dt><dd>{time(session.startTime)}</dd></div>
      <div><dt>当前进度</dt><dd>{time(session.currentTime)} · 第 {session.currentIndex + 1} 步</dd></div>
      <div><dt>最后更新</dt><dd>{time(session.updatedAt)}</dd></div>
    </dl>
    {isLocalPriceSource(session.marketSource) && (session.archiveDays?.length
      ? <details className="replay-session-archives">
        <summary>已记录 {session.archiveDays.length} 个本地日档</summary>
        <p>{session.archiveDays.join('、')}</p>
      </details>
      : <p className="muted-text">加载时按保存的回放区间查找本地日档。</p>)}
    <form className="replay-session-form" onSubmit={event => {
      event.preventDefault()
      const trimmedName = name.trim()
      setName(trimmedName)
      if (!replay.busy && dirty) void replay.editSessionDetails(session.id, { name: trimmedName, notes })
    }}>
      <label>会话名称<input value={name} maxLength={REPLAY_NAME_LIMIT} disabled={replay.busy}
        onChange={event => setName(event.target.value)} /></label>
      <label>备注<textarea rows={4} value={notes} maxLength={REPLAY_NOTES_LIMIT} disabled={replay.busy}
        onChange={event => setNotes(event.target.value)} /></label>
      <div className="button-row"><button type="submit" disabled={!dirty || replay.busy}>保存名称和备注</button></div>
    </form>
    <div className="button-row replay-session-actions">
      <button type="button" className="dialog-done" disabled={replay.busy || !canLoad || dirty}
        onClick={() => void replay.loadSession(session.id, onLoaded)}>加载会话</button>
      {canLoad && onOpenLocalData && <button type="button" disabled={replay.busy || dirty} onClick={onOpenLocalData}>本地数据管理</button>}
      <button type="button" className="danger-button" disabled={replay.busy || current} onClick={() => {
        if (window.confirm(`删除会话「${titleOf(session)}」及其模拟持仓、成交和流水？`)) void replay.deleteSession(session.id)
      }}>删除会话</button>
    </div>
    {!canLoad && <p className="muted-text">{isPriceSource(session.marketSource) ? `切换到 ${sourceName(session)} 后可以加载该会话。` : '此存档可在数据管理中导出。'}</p>}
  </section>
}

export function ReplaySessionManager({ replay, source, onClose, onLoaded, onOpenLocalData }: {
  replay: SessionActions
  source: PriceSource
  onClose(): void
  onLoaded(): void
  onOpenLocalData?: () => void
}) {
  const [selectedId, setSelectedId] = useState(replay.session?.id)
  const [query, setQuery] = useState('')
  const term = query.trim().toLocaleLowerCase()
  const sessions = replay.sessions.filter(session => [titleOf(session), session.symbol.ticker, sourceName(session), session.notes]
    .some(value => value?.toLocaleLowerCase().includes(term)))
  const selected = sessions.find(session => session.id === selectedId) ?? sessions[0]
  return <WorkspaceDialog open title="会话管理" className="replay-session-manager" closeDisabled={replay.busy} onClose={onClose}>
    <div className="replay-session-layout">
      <section className="replay-session-list" aria-label="会话列表">
        <label>搜索会话<input type="search" value={query} disabled={replay.busy} placeholder="名称、品种或备注"
          onChange={event => setQuery(event.target.value)} /></label>
        {sessions.length ? <ul>{sessions.map(session => <li key={session.id}>
          <button type="button" aria-pressed={session.id === selected?.id} disabled={replay.busy} onClick={() => {
            setSelectedId(session.id)
            replay.clearError()
          }}>
            <strong>{titleOf(session)}</strong>
            <span>{sourceName(session)} · {session.symbol.ticker}</span>
          </button>
        </li>)}</ul> : <p className="muted-text">{replay.busy ? '正在读取会话…' : term ? '没有匹配的会话。' : '暂无回放会话。'}</p>}
      </section>
      {selected && <SessionDetails key={selected.id} session={selected} replay={replay} source={source}
        onLoaded={onLoaded} onOpenLocalData={onOpenLocalData} />}
    </div>
    {replay.busy && replay.preparationStatus && <p role="status">{replay.preparationStatus}</p>}
    {replay.error && <p className="panel-error" role="alert">{replay.error}</p>}
  </WorkspaceDialog>
}
