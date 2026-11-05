import { useEffect, useMemo, useRef, useState } from 'react'
import type { Period, SymbolInfo } from '@klinecharts/pro'
import { SUPPORTED_PERIODS } from '../chart/chart-config'
import type {
  CandleKind,
  DownloadProgress,
  MarketSelection,
  MarketSymbol,
  SeriesSummary,
} from '../market-data/models'
import {
  EMPTY_SERIES_SUMMARY,
  toSymbolInfo,
} from '../market-data/models'
import {
  readFavoriteSymbols,
  saveFavoriteSymbols,
} from '../market-data/favorites'
import { expandHistoryRange } from '../market-data/history-ranges'
import {
  saveBaseUrlPreference,
  type MarketDataRuntime,
} from '../market-data/runtime'
import { BackupSyncPanel } from './BackupSyncPanel'
import { RequestProtection } from './RequestProtection'

interface DataManagerProps {
  open: boolean
  runtime: MarketDataRuntime
  selection: MarketSelection
  onApplySelection: (selection: MarketSelection) => void
  onClose: () => void
}

interface SummaryPair {
  trade: SeriesSummary
  mark: SeriesSummary
}

function inputDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const localTimestamp = timestamp - date.getTimezoneOffset() * 60_000
  return new Date(localTimestamp).toISOString().slice(0, 16)
}

function parseInputDateTime(value: string): number {
  return new Date(value).getTime()
}

function displayTime(timestamp: number | null): string {
  if (timestamp === null) {
    return '—'
  }
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
  }).format(timestamp)
}

function progressText(progress: DownloadProgress): string {
  const name = progress.kind === 'trade' ? '普通 K 线' : '标记价格 K 线'
  return `${name}：第 ${progress.page} 页，本次已接收 ${progress.stored} 根`
}

function CacheSummary({
  title,
  summary,
}: {
  title: string
  summary: SeriesSummary
}) {
  return (
    <div className="cache-summary">
      <strong>{title}</strong>
      <span>{summary.count.toLocaleString()} 根</span>
      <span>
        {displayTime(summary.firstOpenTime)} — {displayTime(summary.lastOpenTime)}
      </span>
      <span>
        {summary.gaps.length === 0
          ? '已缓存范围内未发现缺口'
          : `${summary.gaps.length} 个缺失区间`}
      </span>
    </div>
  )
}

export function DataManager({
  open,
  runtime,
  selection,
  onApplySelection,
  onClose,
}: DataManagerProps) {
  const [symbols, setSymbols] = useState<MarketSymbol[]>([])
  const [symbolText, setSymbolText] = useState(selection.symbol.ticker)
  const [timeframe, setTimeframe] = useState(selection.period.text)
  const [search, setSearch] = useState('')
  const [initialRange] = useState(() => {
    const now = new Date(Date.now())
    return {
      from: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
      to: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 60_000,
    }
  })
  const [fromText, setFromText] = useState(() =>
    inputDateTime(initialRange.from),
  )
  const [toText, setToText] = useState(() => inputDateTime(initialRange.to))
  const [baseUrl, setBaseUrl] = useState(runtime.service.getBaseUrl())
  const [favorites, setFavorites] = useState<string[]>(readFavoriteSymbols)
  const [summary, setSummary] = useState<SummaryPair>({
    trade: EMPTY_SERIES_SUMMARY,
    mark: EMPTY_SERIES_SUMMARY,
  })
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [pendingUploads, setPendingUploads] = useState(() => runtime.service.getPendingUploadCount())
  const abortRef = useRef<AbortController | null>(null)

  const rangePreview = useMemo(() => {
    try {
      const symbol = symbols.find((item) => item.symbol === symbolText)
      return expandHistoryRange(parseInputDateTime(fromText), parseInputDateTime(toText), Date.now(), symbol?.onboardDate ?? 0)
    } catch {
      return null
    }
  }, [fromText, toText, symbols, symbolText])

  const visibleSymbols = useMemo(() => {
    const normalized = search.trim().toUpperCase()
    return symbols
      .filter(
        (symbol) =>
          symbol.symbol === symbolText ||
          normalized.length === 0 ||
          symbol.symbol.includes(normalized) ||
          symbol.baseAsset.includes(normalized),
      )
      .slice(0, 200)
  }, [search, symbols])

  async function refreshSummary(
    selectedSymbol = symbolText,
  ): Promise<void> {
    if (selectedSymbol.trim().length === 0) {
      return
    }
    const [trade, mark] = await Promise.all([
      runtime.service.inspectSeries(
        'trade',
        selectedSymbol,
        '1m',
      ),
      runtime.service.inspectSeries(
        'mark',
        selectedSymbol,
        '1m',
      ),
    ])
    setSummary({ trade, mark })
    setPendingUploads(runtime.service.getPendingUploadCount())
  }

  useEffect(() => {
    if (!open) {
      return
    }
    setSymbolText(selection.symbol.ticker)
    setTimeframe(selection.period.text)
    setFavorites(readFavoriteSymbols())
    setError('')
    void runtime.service
      .getSymbols()
      .then((items) => {
        setSymbols(items)
        return refreshSummary(selection.symbol.ticker)
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }, [open, runtime, selection.period.text, selection.symbol.ticker])

  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setPendingUploads(runtime.service.getPendingUploadCount()), 1000)
    return () => window.clearInterval(timer)
  }, [open, runtime])

  if (!open) {
    return null
  }

  function selectedSymbol(): MarketSymbol | undefined {
    const normalized = symbolText.trim().toUpperCase()
    return symbols.find((symbol) => symbol.symbol === normalized)
  }

  function selectedPeriod(): Period | undefined {
    return SUPPORTED_PERIODS.find((period) => period.text === timeframe)
  }

  function applySelection(): void {
    const symbol = selectedSymbol()
    const period = selectedPeriod()
    if (symbol === undefined || period === undefined) {
      setError('请选择列表中的有效交易对和周期')
      return
    }
    setError('')
    onApplySelection({ symbol: toSymbolInfo(symbol), period })
    void refreshSummary(symbol.symbol)
  }

  async function download(kinds: readonly CandleKind[]): Promise<void> {
    const symbol = selectedSymbol()
    const from = parseInputDateTime(fromText)
    const to = parseInputDateTime(toText)
    if (symbol === undefined) {
      setError('请选择列表中的有效交易对')
      return
    }
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      setError('下载开始时间必须早于结束时间')
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setError('')
    setStatus('正在检查本地缓存和数据缺口…')
    runtime.service.resetReplayRequests()
    try {
      const actual = await runtime.service.prepareHistory(symbol.symbol, from, to, {
        kinds,
        signal: controller.signal,
        onProgress: (progress) => setStatus(progressText(progress)),
        onStatus: setStatus,
        onWarning: (message) => {
          if (abortRef.current === controller) setStatus(message)
        },
      })
      await refreshSummary(symbol.symbol)
      const pending = runtime.service.getPendingUploadCount()
      setPendingUploads(pending)
      setStatus(`下载完成：${displayTime(actual.from)} — ${displayTime(actual.to)}，1m 数据已写入本地缓存。${pending > 0 ? `已缓存，待上传 ${pending} 个月份。` : runtime.defaultGitHubClient?.canWrite() ? '云端上传已安排。' : '已缓存，连接仓库后可上传。'}`)
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        setStatus('下载已取消，已经写入的数据会保留。')
      } else {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      abortRef.current = null
      setPendingUploads(runtime.service.getPendingUploadCount())
      setBusy(false)
    }
  }

  async function retryUploads(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await runtime.service.retryPendingUploads()
      const pending = runtime.service.getPendingUploadCount()
      setPendingUploads(pending)
      setStatus(pending > 0 ? `已缓存，待上传 ${pending} 个月份，请检查连接后重试。` : '待上传数据已处理完成。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPendingUploads(runtime.service.getPendingUploadCount())
      setBusy(false)
    }
  }

  async function refreshSymbols(): Promise<void> {
    setBusy(true)
    setError('')
    setStatus('正在读取币安合约列表…')
    try {
      const items = await runtime.service.getSymbols({ forceRefresh: true })
      setSymbols(items)
      setStatus(`已读取 ${items.length} 个正在交易的 USDT 永续合约。`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  function updateBaseUrl(): void {
    try {
      runtime.service.setBaseUrl(baseUrl)
      saveBaseUrlPreference(runtime.service.getBaseUrl())
      setBaseUrl(runtime.service.getBaseUrl())
      setError('')
      setStatus('行情基础地址已保存。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  function toggleFavorite(): void {
    const normalized = symbolText.trim().toUpperCase()
    if (normalized.length === 0) {
      return
    }
    const next = favorites.includes(normalized)
      ? favorites.filter((item) => item !== normalized)
      : [...favorites, normalized].sort()
    setFavorites(next)
    try {
      saveFavoriteSymbols(next)
    } catch {
      // Favorites remain available for the current component session.
    }
  }

  async function deleteCache(): Promise<void> {
    const symbol = selectedSymbol()
    if (symbol === undefined) {
      setError('请选择列表中的有效交易对')
      return
    }
    if (
      !window.confirm(
        `确认删除 ${symbol.symbol} 1m 的普通和标记价格 K 线缓存？`,
      )
    ) {
      return
    }
    setBusy(true)
    setError('')
    try {
      await Promise.all([
        runtime.service.deleteSeries('trade', symbol.symbol, '1m'),
        runtime.service.deleteSeries('mark', symbol.symbol, '1m'),
      ])
      await refreshSummary(symbol.symbol)
      setStatus('当前交易对的 1m 本地缓存已删除。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        aria-label="关闭数据管理"
        className="drawer-backdrop"
        onClick={onClose}
        type="button"
      />
      <aside
        aria-label="数据管理"
        aria-modal="true"
        className="data-drawer"
        data-testid="data-manager"
        role="dialog"
      >
        <header>
          <h2>数据管理</h2>
          <button
            data-testid="close-data-manager"
            onClick={onClose}
            type="button"
          >
            关闭
          </button>
        </header>
        {runtime.requestGuard !== undefined && (
          <RequestProtection
            guard={runtime.requestGuard}
            onResumed={() => {
              runtime.service.resetReplayRequests()
              setError('')
              setStatus('远程请求已恢复；需要数据时请手动刷新或下载。')
            }}
          />
        )}

        <section>
          <h3>行情接口</h3>
          <label>
            币安公开 REST 基础地址
            <input
              onChange={(event) => setBaseUrl(event.target.value)}
              spellCheck={false}
              value={baseUrl}
            />
          </label>
          <div className="button-row">
            <button disabled={busy} onClick={updateBaseUrl} type="button">
              保存地址
            </button>
            <button disabled={busy} onClick={refreshSymbols} type="button">
              刷新合约列表
            </button>
          </div>
        </section>

        <section>
          <h3>交易对与周期</h3>
          <label>
            搜索
            <input
              onChange={(event) => setSearch(event.target.value)}
              placeholder="BTC、ETH…"
              value={search}
            />
          </label>
          <label>
            交易对
            <select
              aria-label="交易对"
              onChange={(event) => setSymbolText(event.target.value)}
              value={symbolText}
            >
              {!symbols.some((symbol) => symbol.symbol === symbolText) && (
                <option value={symbolText}>{symbolText}</option>
              )}
              {visibleSymbols.map((symbol) => (
                <option key={symbol.symbol} value={symbol.symbol}>
                  {symbol.symbol}
                </option>
              ))}
            </select>
          </label>
          <label>
            周期
            <select
              onChange={(event) => setTimeframe(event.target.value)}
              value={timeframe}
            >
              {SUPPORTED_PERIODS.map((period) => (
                <option key={period.text} value={period.text}>
                  {period.text}
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button onClick={applySelection} type="button">
              应用到图表
            </button>
            <button onClick={toggleFavorite} type="button">
              {favorites.includes(symbolText) ? '取消收藏' : '收藏'}
            </button>
          </div>
          {favorites.length > 0 && (
            <div className="favorite-symbols" aria-label="收藏交易对">
              {favorites.map((favorite) => (
                <button
                  key={favorite}
                  onClick={() => setSymbolText(favorite)}
                  type="button"
                >
                  {favorite}
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3>历史数据区间</h3>
          <p className="muted-text">固定下载 1m 普通与标记价格数据，图表周期由分钟数据聚合。默认范围为上一个完整 UTC 月。</p>
          <label>
            开始时间
            <input
              onChange={(event) => setFromText(event.target.value)}
              type="datetime-local"
              value={fromText}
            />
          </label>
          <label>
            结束时间
            <input
              onChange={(event) => setToText(event.target.value)}
              type="datetime-local"
              value={toText}
            />
          </label>
          <p className="muted-text" data-testid="history-range-preview">
            {rangePreview ? `实际缓存范围：${displayTime(rangePreview.from)} — ${displayTime(rangePreview.to)}（本地时间显示，按 UTC 自然月展开，截止已收盘分钟及上市边界）。` : '请选择有效时间范围；归档按 UTC 自然月展开。'}
          </p>
          <div className="button-row download-actions">
            <button
              disabled={busy || selectedSymbol() === undefined}
              onClick={() => void download(['trade'])}
              type="button"
            >
              下载普通 K 线
            </button>
            <button
              disabled={busy || selectedSymbol() === undefined}
              onClick={() => void download(['mark'])}
              type="button"
            >
              下载标记价格
            </button>
            <button
              disabled={busy || selectedSymbol() === undefined}
              onClick={() => void download(['trade', 'mark'])}
              type="button"
            >
              下载两类数据
            </button>
            {busy && abortRef.current !== null && (
              <button
                className="danger-button"
                onClick={() => abortRef.current?.abort()}
                type="button"
              >
                取消
              </button>
            )}
          </div>
        </section>

        <section>
          <h3>本地缓存（1m 分钟源数据）</h3>
          <CacheSummary summary={summary.trade} title="普通 K 线" />
          <CacheSummary summary={summary.mark} title="标记价格 K 线" />
          <div className="button-row">
            <button
              disabled={busy}
              onClick={() => void refreshSummary()}
              type="button"
            >
              刷新统计
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => void deleteCache()}
              type="button"
            >
              删除当前缓存
            </button>
          </div>
          <p className="muted-text">已缓存，待上传：{pendingUploads} 个月份</p>
          <button disabled={busy || pendingUploads === 0} onClick={() => void retryUploads()} type="button">重试待上传</button>
        </section>

        <BackupSyncPanel
          disabled={busy}
          onChanged={async () => {
            const items = await runtime.service.getSymbols({
              forceRefresh: false,
            })
            setSymbols(items)
            await refreshSummary()
          }}
          runtime={runtime}
          symbol={symbolText}
          timeframe="1m"
        />

        {status.length > 0 && <p className="data-status">{status}</p>}
        {error.length > 0 && (
          <p className="data-error" role="alert">
            {error}
          </p>
        )}
      </aside>
    </>
  )
}
