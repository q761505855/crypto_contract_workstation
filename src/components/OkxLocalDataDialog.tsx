import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { BYBIT_DAY_MS } from '../market-data/bybit/trades'
import { okxArchiveDay } from '../market-data/okx/archive'
import type { OkxLocalDownloadResult, OkxLocalFile, OkxLocalFiles } from '../market-data/okx/local-files'
import { WorkspaceDialog } from './WorkspaceDialog'
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

export function OkxLocalDataDialog({ files, symbol, onClose, onChange }: {
  files: OkxLocalFiles
  symbol: string
  onClose(): void
  onChange(): void
}) {
  const subscribe = useCallback((listener: () => void) => files.subscribe(listener), [files])
  const revision = useSyncExternalStore(subscribe, () => files.revision)
  const { ready, available, name } = files
  const lastArchiveDay = okxArchiveDay(Date.now() - BYBIT_DAY_MS)
  const [from, setFrom] = useState(lastArchiveDay)
  const [to, setTo] = useState(lastArchiveDay)
  const [operation, setOperation] = useState<'folder' | 'download'>()
  const [stopping, setStopping] = useState(false)
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [results, setResults] = useState<OkxLocalDownloadResult[]>([])
  const [notice, setNotice] = useState('')
  const [folderError, setFolderError] = useState('')
  const [downloadError, setDownloadError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const downloading = operation === 'download'
  const rangeError = from && to && from > to ? '开始日期必须早于或等于结束日期。'
    : from > lastArchiveDay || to > lastArchiveDay ? '请选择昨天或更早的日期。' : ''
  const totalDays = (Date.parse(to) - Date.parse(from)) / BYBIT_DAY_MS + 1
  const entries = listing.status === 'ready' ? listing.entries : []

  useEffect(() => {
    if (!ready || downloading) return
    let active = true
    setListing({ status: 'loading' })
    files.list().then(entries => {
      if (active) setListing({ status: 'ready', entries })
    }).catch(error => {
      if (active) setListing({ status: 'error', message: errorMessage(error, '无法读取文件夹。') })
    })
    return () => { active = false }
  }, [files, ready, revision, downloading])

  useEffect(() => () => controller.current?.abort(), [])

  async function openFolder(pick: boolean) {
    if (operation) return
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
        setResults([])
        setNotice('')
        setDownloadError('')
        onChange()
      }
    }
  }

  async function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (operation || !symbol || !ready || !from || !to || rangeError) return
    const batch = new AbortController()
    controller.current = batch
    setOperation('download')
    setResults([])
    setNotice('')
    setDownloadError('')
    let saved = false
    try {
      await files.download(symbol, from, to, result => {
        if (result.status === 'saved') saved = true
        setResults(current => [...current, result])
      }, batch.signal)
      setNotice(batch.signal.aborted ? '已停止下载。' : '本次下载任务已结束。')
    } catch (error) {
      if (batch.signal.aborted) setNotice('已停止下载。')
      else setDownloadError(errorMessage(error, '下载中断，请重试。'))
    } finally {
      controller.current = null
      setOperation(undefined)
      setStopping(false)
      if (saved) onChange()
    }
  }

  function stopDownload() {
    setStopping(true)
    controller.current?.abort()
  }

  return <WorkspaceDialog open title="OKX 本地数据" className="okx-local-dialog" closeDisabled={!!operation} onClose={onClose}>
    <div className="okx-local-content">
      <section aria-label="本地文件夹">
        <div className="okx-local-section-heading">
          <div>
            <h3>本地文件夹</h3>
            <p className="okx-local-note">{name ?? '尚未选择文件夹'}</p>
          </div>
          <div className="okx-local-actions">
            {name && !ready && <button type="button" disabled={!!operation} onClick={() => void openFolder(false)}>授权访问</button>}
            <button type="button" disabled={!available || !!operation} onClick={() => void openFolder(true)}>
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
        <form onSubmit={download}>
          <div className="okx-local-dates">
            <label>开始日期<input type="date" value={from} max={lastArchiveDay} required disabled={downloading}
              onChange={event => setFrom(event.target.value)} /></label>
            <label>结束日期<input type="date" value={to} max={lastArchiveDay} required disabled={downloading}
              onChange={event => setTo(event.target.value)} /></label>
          </div>
          {rangeError && <p className="okx-local-error" role="alert">{rangeError}</p>}
          <div className="okx-local-actions">
            {downloading
              ? <button type="button" onClick={stopDownload} disabled={stopping}>停止下载</button>
              : <button type="submit" className="okx-local-primary" disabled={!symbol || !ready || !!operation || !from || !to || !!rangeError}>下载 ZIP</button>}
          </div>
        </form>
        {(downloading || notice) && <p className="okx-local-note" role="status">{downloading
          ? `${stopping ? '正在停止' : '正在下载'}，已处理 ${results.length} / ${totalDays} 天…` : notice}</p>}
        {downloadError && <p className="okx-local-error" role="alert">{downloadError}</p>}
        {results.length > 0 && <ul aria-label="下载结果" className="okx-local-list">
          {results.map(result => <li key={result.day}>
            <time dateTime={result.day}>{result.day}</time>
            <span data-download-status={result.status}>{downloadLabels[result.status]}{result.message && ` · ${result.message}`}</span>
          </li>)}
        </ul>}
      </section>

      <section aria-label="已下载日期">
        <div className="okx-local-section-heading">
          <h3>已下载日期</h3>
          {ready && <button type="button" disabled={!!operation} onClick={() => { files.refresh(); onChange() }}>刷新列表</button>}
        </div>
        {!ready && <p className="okx-local-note">打开文件夹后查看 ZIP。</p>}
        {ready && listing.status === 'loading' && <p className="okx-local-note" role="status">正在扫描文件夹…</p>}
        {ready && listing.status === 'error' && <p className="okx-local-error" role="alert">{listing.message}</p>}
        {ready && listing.status === 'ready' && <DownloadedDates files={entries} symbol={symbol} />}
      </section>
    </div>
  </WorkspaceDialog>
}

function DownloadedDates({ files, symbol }: { files: OkxLocalFile[]; symbol: string }) {
  const matches = files.filter(file => file.symbol === symbol).sort((a, b) => b.day.localeCompare(a.day))
  if (matches.length === 0) return <p className="okx-local-note">文件夹中暂无该交易对的 ZIP。</p>
  return <>
    <p className="okx-local-note">{matches.length} 天</p>
    <ul aria-label="本地 ZIP 文件" className="okx-local-list">
      {matches.map(file => <li key={file.filename}>
        <time dateTime={file.day}>{file.day}</time>
        <span title={file.filename}>{file.filename}</span>
      </li>)}
    </ul>
  </>
}
