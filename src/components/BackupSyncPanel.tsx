import { useEffect, useRef, useState } from 'react'
import type { MarketDataRuntime } from '../market-data/runtime'
import type { ReplaySession } from '../replay/models'
import type { BackupEnvelope } from '../storage/backup-service'
import {
  GitHubContentsClient,
  type GitHubRepositoryInfo,
} from '../github-sync/github-client'
import {
  ALL_SYNC_SELECTION,
  type ConflictResolution,
  type SyncSelection,
} from '../github-sync/sync-service'

interface BackupSyncPanelProps {
  runtime: MarketDataRuntime
  symbol: string
  timeframe: string
  disabled: boolean
  onChanged(): Promise<void> | void
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '-')
}

function downloadJson(name: string, value: BackupEnvelope): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

export function BackupSyncPanel({
  runtime,
  symbol,
  timeframe,
  disabled,
  onChanged,
}: BackupSyncPanelProps) {
  const [sessions, setSessions] = useState<ReplaySession[]>([])
  const [sessionId, setSessionId] = useState('')
  const [owner, setOwner] = useState('')
  const [repository, setRepository] = useState('')
  const [branch, setBranch] = useState('main')
  const [token, setToken] = useState('')
  const [repositoryInfo, setRepositoryInfo] =
    useState<GitHubRepositoryInfo | null>(null)
  const [resolution, setResolution] =
    useState<ConflictResolution>('stop')
  const [selection, setSelection] = useState<SyncSelection>({
    ...ALL_SYNC_SELECTION,
  })
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [logs, setLogs] = useState<string[]>([])
  const importInputRef = useRef<HTMLInputElement | null>(null)

  async function refreshSessions(): Promise<void> {
    const next = await runtime.replaySessions.list()
    setSessions(next)
    setSessionId((current) =>
      next.some((session) => session.id === current)
        ? current
        : (next[0]?.id ?? ''),
    )
  }

  useEffect(() => {
    void refreshSessions()
  }, [runtime])

  function addLog(message: string): void {
    const time = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(Date.now())
    setLogs((current) => [`${time} ${message}`, ...current].slice(0, 30))
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      addLog(`失败：${message}`)
    } finally {
      setBusy(false)
    }
  }

  function client(): GitHubContentsClient {
    return new GitHubContentsClient(
      { owner, repository, branch },
      token,
    )
  }

  async function exportPreferences(): Promise<void> {
    const envelope = await runtime.backups.exportPreferences()
    downloadJson('workstation-preferences.json', envelope)
    setStatus('应用配置已导出。')
  }

  async function exportMarketData(): Promise<void> {
    const envelope = await runtime.backups.exportMarketData(
      symbol,
      timeframe,
    )
    downloadJson(
      `market-${safeFilenamePart(symbol)}-${safeFilenamePart(
        timeframe,
      )}.json`,
      envelope,
    )
    setStatus(
      `已导出 ${envelope.data.tradeCandles?.length ?? 0} 根普通 K 线和 ${
        envelope.data.markCandles?.length ?? 0
      } 根标记价格 K 线。`,
    )
  }

  async function exportSession(): Promise<void> {
    if (sessionId.length === 0) throw new Error('没有可导出的回放会话')
    const envelope = await runtime.backups.exportSession(sessionId)
    downloadJson(`session-${safeFilenamePart(sessionId)}.json`, envelope)
    setStatus('所选回放会话已导出。')
  }

  async function exportAll(): Promise<void> {
    const envelope = await runtime.backups.exportAll()
    downloadJson('workstation-full-backup.json', envelope)
    setStatus('全部本地数据已导出。')
  }

  async function importFile(file: File): Promise<void> {
    if (!window.confirm('导入会合并数据，并覆盖主键相同的本地记录，是否继续？')) {
      return
    }
    const raw = JSON.parse(await file.text()) as unknown
    const report = await runtime.backups.import(raw)
    await refreshSessions()
    await onChanged()
    setStatus(
      `导入完成：${report.tradeCandles + report.markCandles} 根 K 线，${
        report.sessions
      } 个会话，${report.simulations} 个模拟账户。刷新页面可恢复导入的活动会话。`,
    )
  }

  async function testConnection(): Promise<void> {
    const info = await client().testConnection()
    setRepositoryInfo(info)
    setStatus(
      `已连接 ${info.fullName}（${info.private ? '私人仓库' : '公开仓库'}，${
        info.canPush ? '可写' : '只读'
      }）。`,
    )
    addLog(`连接成功：${info.fullName}`)
  }

  async function compare(): Promise<void> {
    const result = await runtime.githubSync.compare(client(), selection)
    setStatus(
      `本地 ${result.localFiles} 个文件 / ${bytes(
        result.localBytes,
      )}；远端 ${result.remoteFiles} 个文件 / ${bytes(
        result.remoteBytes,
      )}；差异 ${result.changedFiles} 个。`,
    )
    addLog(`比较完成：${result.changedFiles} 个差异`)
  }

  async function upload(): Promise<void> {
    if (!Object.values(selection).some(Boolean)) {
      throw new Error('请至少选择一类同步数据')
    }
    const result = await runtime.githubSync.upload(
      client(),
      resolution,
      selection,
      (message) => {
        setStatus(message)
        addLog(message)
      },
    )
    setStatus(
      `上传完成：${result.files} 个文件，${bytes(result.bytes)}${
        result.copiedConflicts > 0
          ? `，${result.copiedConflicts} 个冲突另存为副本`
          : ''
      }${
        result.skippedConflicts > 0
          ? `，${result.skippedConflicts} 个冲突保留云端`
          : ''
      }。`,
    )
    addLog('上传完成')
  }

  async function pull(): Promise<void> {
    if (
      !window.confirm(
        '从 GitHub 拉取会先完整校验远端文件，再合并并覆盖同主键的本地数据，是否继续？',
      )
    ) {
      return
    }
    const result = await runtime.githubSync.pull(client(), (message) => {
      setStatus(message)
      addLog(message)
    })
    await refreshSessions()
    await onChanged()
    setStatus(
      `云端恢复完成：${result.files} 个文件，${bytes(
        result.bytes,
      )}。刷新页面可恢复导入的活动会话。`,
    )
    addLog('云端恢复完成')
  }

  const actionDisabled = disabled || busy

  return (
    <div data-testid="backup-sync-panel">
      <section>
        <h3>本地备份</h3>
        <div className="button-row backup-actions">
          <button
            disabled={actionDisabled}
            onClick={() => void run(exportPreferences)}
            type="button"
          >
            导出应用配置
          </button>
          <button
            disabled={actionDisabled}
            onClick={() => void run(exportMarketData)}
            type="button"
          >
            导出当前行情
          </button>
          <button
            disabled={actionDisabled}
            onClick={() => void run(exportAll)}
            type="button"
          >
            导出全部数据
          </button>
        </div>
        <label>
          单个回放会话
          <select
            aria-label="备份回放会话"
            onChange={(event) => setSessionId(event.target.value)}
            value={sessionId}
          >
            {sessions.length === 0 && <option value="">暂无会话</option>}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.symbol.ticker} {session.period.text} ·{' '}
                {new Date(session.startTime).toLocaleString('zh-CN')}
              </option>
            ))}
          </select>
        </label>
        <div className="button-row">
          <button
            data-testid="export-session-backup"
            disabled={actionDisabled || sessionId.length === 0}
            onClick={() => void run(exportSession)}
            type="button"
          >
            导出所选会话
          </button>
          <button
            disabled={actionDisabled}
            onClick={() => importInputRef.current?.click()}
            type="button"
          >
            导入备份文件
          </button>
          <input
            accept=".json,application/json"
            data-testid="import-backup-file"
            aria-label="选择备份文件"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) void run(() => importFile(file))
            }}
            ref={importInputRef}
            type="file"
          />
        </div>
      </section>

      <section>
        <h3>GitHub 私有仓库同步</h3>
        <p className="muted-text">
          使用只授予目标仓库 Contents 读写权限的 Fine-grained Token。
          Token 仅保存在当前页面内存，刷新或断开后清除。
        </p>
        <label>
          用户或组织
          <input
            aria-label="GitHub 用户或组织"
            autoComplete="off"
            data-testid="github-owner"
            onChange={(event) => {
              setOwner(event.target.value)
              setRepositoryInfo(null)
            }}
            value={owner}
          />
        </label>
        <label>
          数据仓库
          <input
            aria-label="GitHub 数据仓库"
            autoComplete="off"
            data-testid="github-repository"
            onChange={(event) => {
              setRepository(event.target.value)
              setRepositoryInfo(null)
            }}
            value={repository}
          />
        </label>
        <label>
          分支
          <input
            aria-label="GitHub 分支"
            autoComplete="off"
            onChange={(event) => {
              setBranch(event.target.value)
              setRepositoryInfo(null)
            }}
            value={branch}
          />
        </label>
        <label>
          Fine-grained Token
          <input
            aria-label="GitHub Token"
            autoComplete="off"
            onChange={(event) => {
              setToken(event.target.value)
              setRepositoryInfo(null)
            }}
            type="password"
            data-testid="github-token"
            value={token}
          />
        </label>
        <div className="sync-selection" aria-label="同步数据范围">
          {[
            ['config', '应用配置'],
            ['sessions', '会话与交易'],
            ['marketData', '历史行情'],
          ].map(([key, label]) => (
            <label key={key}>
              <input
                checked={selection[key as keyof SyncSelection]}
                onChange={(event) =>
                  setSelection((current) => ({
                    ...current,
                    [key]: event.target.checked,
                  }))
                }
                type="checkbox"
              />
              {label}
            </label>
          ))}
        </div>
        <label>
          SHA 冲突处理
          <select
            aria-label="GitHub 冲突处理"
            onChange={(event) =>
              setResolution(event.target.value as ConflictResolution)
            }
            value={resolution}
          >
            <option value="stop">停止并提示</option>
            <option value="keep-local">保留本地并重试</option>
            <option value="keep-remote">保留云端</option>
            <option value="save-copy">将本地另存为副本</option>
          </select>
        </label>
        <div className="button-row sync-actions">
          <button
            data-testid="github-test-connection"
            disabled={actionDisabled || token.length === 0}
            onClick={() => void run(testConnection)}
            type="button"
          >
            测试连接
          </button>
          <button
            data-testid="github-compare"
            disabled={actionDisabled || token.length === 0}
            onClick={() => void run(compare)}
            type="button"
          >
            比较本地与云端
          </button>
          <button
            data-testid="github-upload"
            disabled={actionDisabled || token.length === 0}
            onClick={() => void run(upload)}
            type="button"
          >
            上传选中数据
          </button>
          <button
            data-testid="github-pull"
            disabled={actionDisabled || token.length === 0}
            onClick={() => void run(pull)}
            type="button"
          >
            从云端拉取
          </button>
          <button
            data-testid="github-disconnect"
            disabled={actionDisabled || token.length === 0}
            onClick={() => {
              setToken('')
              setRepositoryInfo(null)
              setStatus('GitHub 已断开，内存中的 Token 已清除。')
              addLog('已断开并清除 Token')
            }}
            type="button"
          >
            断开并清除 Token
          </button>
        </div>
        {repositoryInfo !== null && (
          <p className="data-status" data-testid="github-repository-info">
            {repositoryInfo.fullName} ·{' '}
            {repositoryInfo.private ? '私人仓库' : '公开仓库'} ·{' '}
            {repositoryInfo.canPush ? '可写' : '只读'}
          </p>
        )}
        {logs.length > 0 && (
          <details className="sync-log">
            <summary>同步日志（{logs.length}）</summary>
            <ol>
              {logs.map((entry, index) => (
                <li key={`${entry}-${index}`}>{entry}</li>
              ))}
            </ol>
          </details>
        )}
      </section>

      {status.length > 0 && (
        <p className="data-status" data-testid="backup-status">
          {status}
        </p>
      )}
      {error.length > 0 && (
        <p className="data-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
