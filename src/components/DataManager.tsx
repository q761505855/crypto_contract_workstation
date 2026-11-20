import { useEffect, useState } from 'react'
import { CTRADER_PERIODS } from '../chart/chart-config'
import { readFavoriteSymbols, saveFavoriteSymbols } from '../market-data/favorites'
import { toSymbolInfo, type MarketSelection, type MarketSymbol } from '../market-data/models'
import type { MarketDataRuntime } from '../market-data/runtime'
import { BackupSyncPanel } from './BackupSyncPanel'
import { DrawingStorage } from './DrawingStorage'

interface DataManagerProps {
  configurationRevision?: number
  open: boolean
  runtime: MarketDataRuntime
  selection: MarketSelection
  onApplySelection(selection: MarketSelection): void
  onClose(): void
}

export function DataManager({ configurationRevision, open, runtime, selection, onApplySelection, onClose }: DataManagerProps) {
  const [symbols, setSymbols] = useState<MarketSymbol[]>([])
  const [symbolText, setSymbolText] = useState(selection.symbol.ticker)
  const [timeframe, setTimeframe] = useState(selection.period.text)
  const [search, setSearch] = useState('')
  const [favorites, setFavorites] = useState(readFavoriteSymbols)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setSymbolText(selection.symbol.ticker)
    setTimeframe(selection.period.text)
    setFavorites(readFavoriteSymbols())
  }, [open, configurationRevision, selection.symbol.ticker, selection.period.text])

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    setLoading(true)
    setError('')
    void runtime.service.getSymbols({ forceRefresh: refresh > 0, signal: abort.signal }).then(result => {
      if (!abort.signal.aborted) setSymbols(result)
    }).catch((reason: unknown) => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取 cTrader 品种。')
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false)
    })
    return () => abort.abort()
  }, [open, runtime, refresh])

  if (!open) return null

  const selectedSymbol = symbols.find(item => item.symbol === symbolText)
  const selectedPeriod = CTRADER_PERIODS.find(period => period.text === timeframe)
  const visibleSymbols = symbols.filter(item => item.symbol !== symbolText &&
    `${item.symbol} ${item.baseAsset} ${item.quoteAsset} ${item.description ?? ''}`.toUpperCase().includes(search.trim().toUpperCase()))

  function toggleFavorite(): void {
    const next = favorites.includes(symbolText) ? favorites.filter(item => item !== symbolText) : [...favorites, symbolText]
    try {
      saveFavoriteSymbols(next)
      setFavorites(next)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '收藏保存失败。')
    }
  }

  return (
    <>
      <button aria-label="关闭数据管理" className="drawer-backdrop" onClick={onClose} type="button" />
      <aside aria-label="数据管理" aria-modal="true" className="data-drawer" data-testid="data-manager" role="dialog">
        <header>
          <h2>数据管理</h2>
          <button data-testid="close-data-manager" onClick={onClose} type="button">关闭</button>
        </header>
        <section>
          <h3>cTrader 行情</h3>
          <p className="muted-text">网页直连所选 cTrader 账户，按图表或回放周期读取原生 K 线。行情缓存在当前页面。</p>
          <button disabled={loading} onClick={() => setRefresh(current => current + 1)} type="button">刷新品种列表</button>
          {loading && <span role="status">正在读取品种…</span>}
          {error && <p className="data-error" role="alert">{error}</p>}
        </section>
        <section>
          <h3>交易对与周期</h3>
          <label>搜索<input value={search} onChange={event => setSearch(event.target.value)} placeholder="EURUSD、黄金…" /></label>
          <label>交易对
            <select aria-label="交易对" value={symbolText} onChange={event => setSymbolText(event.target.value)}>
              <option value={symbolText}>{symbolText}</option>
              {visibleSymbols.map(item => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}
            </select>
          </label>
          <label>周期
            <select value={timeframe} onChange={event => setTimeframe(event.target.value)}>
              {CTRADER_PERIODS.map(period => <option key={period.text} value={period.text}>{period.text}</option>)}
            </select>
          </label>
          <div className="button-row">
            <button disabled={!selectedSymbol || !selectedPeriod} type="button" onClick={() => {
              if (selectedSymbol && selectedPeriod) onApplySelection({ symbol: toSymbolInfo(selectedSymbol), period: selectedPeriod })
            }}>应用到图表</button>
            <button disabled={!selectedSymbol && !favorites.includes(symbolText)} onClick={toggleFavorite} type="button">
              {favorites.includes(symbolText) ? '取消收藏' : '收藏'}
            </button>
          </div>
          {favorites.some(ticker => symbols.some(item => item.symbol === ticker)) && (
            <div className="favorite-symbols" aria-label="收藏交易对">
              {favorites.filter(ticker => symbols.some(item => item.symbol === ticker)).map(ticker => (
                <button key={ticker} onClick={() => setSymbolText(ticker)} type="button">{ticker}</button>
              ))}
            </div>
          )}
        </section>
        {runtime.drawingSync && <DrawingStorage service={runtime.drawingSync} disabled={false} />}
        <BackupSyncPanel runtime={runtime} disabled={false} />
      </aside>
    </>
  )
}
