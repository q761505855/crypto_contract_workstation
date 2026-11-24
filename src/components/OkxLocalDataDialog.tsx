import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { BYBIT_DAY_MS } from '../market-data/bybit/trades'
import { okxArchiveDay } from '../market-data/okx/archive'
import type { OkxLocalDownloadResult, OkxLocalFile, OkxLocalFiles } from '../market-data/okx/local-files'
import type { OkxLocalDownloads } from '../market-data/okx/local-downloads'
import { WorkspaceDialog } from './WorkspaceDialog'
import { resolveDayDownloadRange, TradeDownloadRange, type DayDownloadSelection } from './TradeDownloadRange'
import './okx-local-data.css'

const downloadLabels: Record<OkxLocalDownloadResult['status'], string> = {
  saved: '已保存',
  existing: '文件已存在',
  unavailable: '官方暂无归档',
  failed: '下载失败',
}

type Listing = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; entries: OkxLocalFile[] }

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function OkxLocalDataDialog({ files, downloads, symbol, anchor, loadedDays = [], onClose, onFolderChange, onLoad }: {
  files: OkxLocalFiles
  downloads: OkxLocalDownloads
  symbol: string
  anchor?: string
  loadedDays?: readonly string[]
  onClose(): void
  onFolderChange(replaced: boolean): void
  onLoad(symbol: string, days: readonly string[], append: boolean): Promise<void>
}) {
  const subscribe = useCallback((listener: () => void) => files.subscribe(listener), [files])
  const revision = useSyncExternalStore(subscribe, () => files.revision)
  const { ready, available, name } = files
  const now = Date.now()
  const today = okxArchiveDay(now)
  const lastArchiveDay = okxArchiveDay(now - BYBIT_DAY_MS)
  const [startDate, setStartDate] = useState(lastArchiveDay)
  const [endDate, setEndDate] = useState(lastArchiveDay)
  const [selection, setSelection] = useState<DayDownloadSelection>(() => ({
    anchor: anchor ?? today, before: anchor === today ? '1' : '0', after: '0',
  }))
  const [operation, setOperation] = useState<'folder' | 'load'>()
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [marked, setMarked] = useState(new Map<string, boolean>())
  const [folderError, setFolderError] = useState('')
  const job = useSyncExternalStore(downloads.subscribe, downloads.snapshot)
  const downloading = job?.status === 'running' || job?.status === 'stopping'
  const stopping = job?.status === 'stopping'
  const anchored = anchor !== undefined
  const range = anchored ? resolveDayDownloadRange(selection, today, lastArchiveDay) : undefined
  const from = anchored ? range?.start : startDate
  const to = anchored ? range?.end : endDate
  const rangeError = anchored ? range?.error : startDate && endDate && startDate > endDate ? '开始日期必须早于或等于结束日期。'
    : startDate > lastArchiveDay || endDate > lastArchiveDay ? '请选择昨天或更早的日期。' : ''
  const entries = listing.status === 'ready' ? listing.entries.filter(file => file.symbol === symbol) : []
  const selected = entries.filter(file => marked.get(file.day) ?? loadedDays.includes(file.day)).map(file => file.day)

  useEffect(() => {
    if (!ready) return
    let active = true
    setListing({ status: 'loading' })
    files.list().then(entries => {
      if (active) setListing({ status: 'ready', entries })
    }).catch(error => {
      if (active) setListing({ status: 'error', message: errorMessage(error, '无法读取文件夹。') })
    })
    return () => { active = false }
  }, [files, ready, revision])

  async function openFolder(pick: boolean) {
    if (operation || downloading) return
    setOperation('folder')
    setFolderError('')
    const previousRevision = files.revision
    try {
      if (pick) await files.pick()
      else await files.authorize()
      if (!files.ready && files.name) setFolderError('请允许浏览器读写该文件夹。')
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setFolderError(errorMessage(error, '无法打开文件夹。'))
      }
    } finally {
      setOperation(undefined)
      if (files.revision !== previousRevision) {
        setMarked(new Map())
        onFolderChange(pick)
      }
    }
  }

  function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (operation || downloading || !symbol || !ready || !from || !to || rangeError) return
    void downloads.start({
      symbol, from, to, anchor: anchored ? selection.anchor : okxArchiveDay(Date.now()),
      onArchive: anchored ? day => onLoad(symbol, [day], true) : undefined,
    })
  }

  return <WorkspaceDialog open title={anchored ? '下载成交数据' : 'OKX 本地数据'}
    className="okx-local-dialog" closeDisabled={!!operation} onClose={onClose}>
    <div className="okx-local-content">
      <section aria-label="本地文件夹">
        <div className="okx-local-section-heading">
          <div>
            <h3>本地文件夹</h3>
            <p className="okx-local-note">{name ?? '尚未选择文件夹'}</p>
          </div>
          <div className="okx-local-actions">
            {name && !ready && <button type="button" disabled={!!operation || downloading} onClick={() => void openFolder(false)}>授权访问</button>}
            <button type="button" disabled={!available || !!operation || downloading} onClick={() => void openFolder(true)}>
              {name ? '更换文件夹' : '选择文件夹'}
            </button>
          </div>
        </div>
        {!available && <p className="okx-local-note">请选择支持文件夹读写的 Chrome 或 Edge 浏览器，并通过 HTTPS 或本机地址访问工作站。</p>}
        {name && !ready && <p className="okx-local-note">授权后即可读取和下载 ZIP。</p>}
        {folderError && <p className="okx-local-error" role="alert">{folderError}</p>}
      </section>

      <section aria-label="下载官方归档">
        <h3>下载官方逐笔成交</h3>
        <p className="okx-local-note">{symbol ? `${symbol} · 归档日期按 UTC+8 计算。` : '请先选择交易对。'}</p>
        <form className={anchored ? 'bybit-download-form' : undefined} onSubmit={download}>
          {anchored ? <TradeDownloadRange selection={selection} onChange={setSelection} today={today}
            lastDownloadDay={lastArchiveDay} disabled={downloading} /> : <div className="okx-local-dates">
            <label>开始日期<input type="date" value={startDate} max={lastArchiveDay} required disabled={downloading}
              onChange={event => setStartDate(event.target.value)} /></label>
            <label>结束日期<input type="date" value={endDate} max={lastArchiveDay} required disabled={downloading}
              onChange={event => setEndDate(event.target.value)} /></label>
          </div>}
          {rangeError && <p className="okx-local-error" role="alert">{rangeError}</p>}
          <div className="okx-local-actions">
            {downloading
              ? <button type="button" onClick={() => downloads.stop()} disabled={stopping}>停止下载</button>
              : <button type="submit" className="okx-local-primary" disabled={!symbol || !ready || !!operation || !from || !to || !!rangeError}>
                {anchored ? '下载' : '下载 ZIP'}
              </button>}
          </div>
        </form>
        {job && <p className="okx-local-note" role="status">{downloading
          ? `${job.symbol} · ${stopping ? '正在停止' : '正在下载'}，已处理 ${job.results.length} / ${job.total} 天… 关闭窗口可继续下载。`
          : job.status === 'stopped' ? '已停止下载。' : job.status === 'finished' ? '本次下载任务已结束。' : ''}</p>}
        {job?.message && <p className="okx-local-error" role="alert">{job.message}</p>}
        {!!job?.results.length && <ul aria-label="下载结果" className="okx-local-list">
          {job.results.map(result => <li key={result.day}>
            <time dateTime={result.day}>{result.day}</time>
            <span data-download-status={result.status}>{downloadLabels[result.status]}{result.message && ` · ${result.message}`}</span>
          </li>)}
        </ul>}
      </section>

      <section aria-label="已下载日期">
        <div className="okx-local-section-heading">
          <h3>已下载日期</h3>
          {ready && <button type="button" disabled={!!operation || downloading} onClick={() => { files.refresh(); onFolderChange(false) }}>刷新列表</button>}
        </div>
        {!ready && <p className="okx-local-note">打开文件夹后查看 ZIP。</p>}
        {ready && listing.status === 'loading' && <p className="okx-local-note" role="status">正在扫描文件夹…</p>}
        {ready && listing.status === 'error' && <p className="okx-local-error" role="alert">{listing.message}</p>}
        {ready && listing.status === 'ready' && (entries.length === 0 ? <p className="okx-local-note">文件夹中暂无该交易对的 ZIP。</p> : <>
          <ul aria-label="本地 ZIP 文件" className="okx-local-list">
            {entries.map(file => <li key={file.filename}>
              {anchored ? <time dateTime={file.day}>{file.day}</time> : <label className="okx-local-archive-choice">
                <input type="checkbox" checked={marked.get(file.day) ?? loadedDays.includes(file.day)} disabled={!!operation || downloading}
                  onChange={event => {
                    const checked = event.target.checked
                    setMarked(current => new Map(current).set(file.day, checked))
                  }} />
                <time dateTime={file.day}>{file.day}</time>
              </label>}
              <span title={file.filename}>{file.filename}</span>
            </li>)}
          </ul>
          {!anchored && <div className="okx-local-actions">
            <button type="button" className="okx-local-primary" disabled={!selected.length || !!operation || downloading}
              onClick={() => {
                setOperation('load')
                void onLoad(symbol, selected, false).then(() => setMarked(new Map())).finally(() => setOperation(undefined))
              }}>{operation === 'load' ? '正在加载…' : '加载所选日期'}</button>
          </div>}
        </>)}
      </section>
    </div>
  </WorkspaceDialog>
}
