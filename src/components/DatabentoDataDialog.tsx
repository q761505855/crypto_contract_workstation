import { useEffect, useState } from 'react'
import { bybitDay } from '../market-data/bybit/trades'
import type { DatabentoArchive, DatabentoFiles } from '../market-data/databento/files'
import { DatabentoArchivePicker } from './DatabentoArchivePicker'
import { resolveDayDownloadRange, TradeDownloadRange, type DayDownloadSelection } from './TradeDownloadRange'
import { WorkspaceDialog } from './WorkspaceDialog'
import './okx-local-data.css'

export function DatabentoDataDialog({ files, revision, symbol, loadedDays, anchor, onClose, onFolderChange, onLoad }: {
  files: DatabentoFiles
  revision: number
  symbol: string
  loadedDays: readonly string[]
  anchor?: string | null
  onClose(): void
  onFolderChange(replaced: boolean): void
  onLoad(symbol: string, days: readonly string[], append: boolean): Promise<void>
}) {
  const [products, setProducts] = useState<Map<string, DatabentoArchive[]>>()
  const [selectionVersion, setSelectionVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [rangeInput, setRangeInput] = useState<DayDownloadSelection>()
  const { ready, name, available } = files
  const entries = products?.get(symbol) ?? []
  const anchored = anchor !== undefined
  const today = bybitDay(Date.now())
  const selection = rangeInput ?? { anchor: anchor ?? entries.at(-1)?.day ?? today, before: '0', after: '0' }
  const range = anchored ? resolveDayDownloadRange(selection, today) : undefined
  const { start, end } = range ?? {}
  const matching = start && end ? entries.filter(file => file.day >= start && file.day <= end).map(file => file.day) : []
  const pendingCount = matching.filter(day => !loadedDays.includes(day)).length

  useEffect(() => {
    let active = true
    setProducts(undefined)
    if (ready) void files.list().then(result => {
      if (active) setProducts(result)
    }, reason => { if (active) setError(reason instanceof Error ? reason.message : '无法读取本地文件夹') })
    return () => { active = false }
  }, [files, ready, revision])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try { await action() }
    catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        setError(reason instanceof Error ? reason.message : '无法读取本地数据')
      }
    } finally { setBusy(false) }
  }

  return <WorkspaceDialog open title={anchored ? '按锚点加载本地成交' : 'Databento-CME 本地数据'}
    className="okx-local-dialog" closeDisabled={busy} onClose={onClose}>
    <div className="okx-local-content">
      <section aria-label="本地文件夹">
        <div className="okx-local-section-heading">
          <div><h3>本地文件夹</h3><p className="okx-local-note">{name ?? '尚未选择文件夹'}</p></div>
          <div className="okx-local-actions">
            <button type="button" disabled={!available || busy} onClick={() => void run(async () => {
              await files.choose()
              setSelectionVersion(version => version + 1)
              onFolderChange(true)
            })}>选择文件夹</button>
            {name && !ready && <button type="button" disabled={busy} onClick={() => void run(() => files.authorize())}>允许读取</button>}
          </div>
        </div>
        {!ready && <p className="okx-local-note">{available ? '请选择包含产品子文件夹的上一级目录。'
          : '请使用桌面 Chrome 或 Edge，通过 HTTPS 或本机地址打开工作站。'}</p>}
        {!anchored && error && <p role="alert" className="okx-local-error">{error}</p>}
      </section>
      {anchored && <section aria-label="锚点加载范围">
        <div className="okx-local-section-heading">
          <h3>{symbol ? `${symbol} 本地日档` : '本地日档'}</h3>
          <span className="okx-local-note">UTC 日档</span>
        </div>
        <form onSubmit={event => {
          event.preventDefault()
          if (busy || !ready || !pendingCount) return
          void run(async () => {
            await onLoad(symbol, matching, true)
            onClose()
          })
        }}>
          <TradeDownloadRange selection={selection} onChange={setRangeInput} today={today}
            disabled={busy || !ready} rangeLabel="加载范围" />
          <p className="okx-local-note">日档日期用 UTC，图表横轴用北京时间。</p>
          {range?.error && <p className="okx-local-error" role="alert">{range.error}</p>}
          {error && <p role="alert" className="okx-local-error">{error}</p>}
          {ready && products && !range?.error && <p className="okx-local-note" role="status">
            {busy ? '正在读取本地日档…' : matching.length === 0 ? '所选范围内没有本地日档。'
              : pendingCount === 0 ? '所选范围内的日档已全部加载。'
              : `所选范围已有 ${matching.length} 个日档，其中 ${pendingCount} 个待加载。`}
          </p>}
          <div className="okx-local-actions"><button type="submit" className="okx-local-primary"
            disabled={busy || !ready || !pendingCount}>{busy ? '正在加载…' : '加载本地日档'}</button></div>
        </form>
      </section>}
      {!anchored && ready && <section aria-label="本地日档">
        <div className="okx-local-section-heading">
          <h3>{symbol ? `${symbol} 日档` : '本地日档'}</h3>
          <button type="button" disabled={busy} onClick={() => {
            setError('')
            files.refresh()
            onFolderChange(false)
          }}>刷新列表</button>
        </div>
        {!products ? !error && <p role="status" className="okx-local-note">正在扫描文件夹…</p>
          : entries.length === 0 && <p className="okx-local-note">暂无可用的 CME Trades DBN 日档。</p>}
        <DatabentoArchivePicker key={`${symbol}:${selectionVersion}`} entries={entries} loadedDays={loadedDays}
          busy={busy} onLoad={days => void run(async () => {
            await onLoad(symbol, days, false)
            onClose()
          })} />
      </section>}
    </div>
  </WorkspaceDialog>
}
