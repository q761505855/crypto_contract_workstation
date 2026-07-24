import { useEffect, useMemo, useRef, useState } from 'react'
import type { Datafeed, SymbolInfo } from '@klinecharts/pro'
import {
  readFavoriteSymbols,
  saveFavoriteSymbols,
} from '../market-data/favorites'

type SymbolPickerTab = 'favorites' | 'all'

interface SymbolPickerProps {
  currentSymbol: SymbolInfo
  datafeed: Datafeed
  onClose: () => void
  onSelect: (symbol: SymbolInfo) => void
}

export function SymbolPicker({
  currentSymbol,
  datafeed,
  onClose,
  onSelect,
}: SymbolPickerProps) {
  const [tab, setTab] = useState<SymbolPickerTab>('favorites')
  const [search, setSearch] = useState('')
  const [symbols, setSymbols] = useState<SymbolInfo[]>([])
  const [favorites, setFavorites] = useState(readFavoriteSymbols)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void datafeed
      .searchSymbols(search)
      .then((items) => {
        if (active) setSymbols(items)
      })
      .catch((reason: unknown) => {
        if (!active) return
        setSymbols([])
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [datafeed, search])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const favoriteSet = useMemo(() => new Set(favorites), [favorites])
  const sortedSymbols = useMemo(
    () =>
      [...symbols].sort((left, right) =>
        left.ticker.localeCompare(right.ticker),
      ),
    [symbols],
  )
  const visibleSymbols = useMemo(
    () =>
      tab === 'favorites'
        ? sortedSymbols.filter((item) => favoriteSet.has(item.ticker))
        : sortedSymbols,
    [favoriteSet, sortedSymbols, tab],
  )

  useEffect(() => {
    if (listRef.current !== null) listRef.current.scrollTop = 0
  }, [search, tab])

  function toggleFavorite(ticker: string): void {
    const next = favoriteSet.has(ticker)
      ? favorites.filter((item) => item !== ticker)
      : [...favorites, ticker]
    setFavorites(next)
    try {
      saveFavoriteSymbols(next)
    } catch {
      // Keep the change available until this picker is closed.
    }
  }

  return (
    <div
      aria-label="选择交易对"
      aria-modal="true"
      className="symbol-picker-backdrop"
      data-testid="symbol-picker"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      role="dialog"
    >
      <div className="symbol-picker-dialog">
        <header>
          <strong>选择交易对</strong>
          <button aria-label="关闭交易对选择器" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <div aria-label="交易对范围" className="symbol-picker-tabs" role="tablist">
          <button
            aria-selected={tab === 'favorites'}
            onClick={() => setTab('favorites')}
            role="tab"
            type="button"
          >
            收藏
            <small aria-hidden="true">{favorites.length}</small>
          </button>
          <button
            aria-selected={tab === 'all'}
            onClick={() => setTab('all')}
            role="tab"
            type="button"
          >
            全部
            <small aria-hidden="true">{symbols.length}</small>
          </button>
        </div>
        <input
          aria-label="搜索交易对"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索交易对"
          ref={searchRef}
          value={search}
        />
        <div className="symbol-picker-summary">
          <span>{tab === 'favorites' ? '收藏交易对' : '全部交易对'}</span>
          <span>{visibleSymbols.length} 个</span>
        </div>
        <div className="symbol-picker-list" ref={listRef} role="list">
          {loading ? <p className="symbol-picker-empty">正在加载…</p> : null}
          {!loading && error.length > 0 ? (
            <p className="symbol-picker-empty">{error}</p>
          ) : null}
          {!loading && error.length === 0 && visibleSymbols.length === 0 ? (
            <p className="symbol-picker-empty">
              {tab === 'favorites'
                ? '暂无收藏交易对，可到“全部”中点击星标添加。'
                : '没有匹配的交易对。'}
            </p>
          ) : null}
          {!loading &&
            visibleSymbols.map((item) => {
              const favorite = favoriteSet.has(item.ticker)
              return (
                <div
                  className={
                    item.ticker === currentSymbol.ticker
                      ? 'symbol-picker-row selected'
                      : 'symbol-picker-row'
                  }
                  data-testid={`symbol-picker-row-${item.ticker}`}
                  key={item.ticker}
                  role="listitem"
                >
                  <button
                    aria-label={`选择 ${item.ticker}`}
                    className="symbol-picker-select"
                    onClick={() => onSelect(item)}
                    type="button"
                  >
                    <span>
                      <strong>{item.shortName ?? item.ticker}</strong>
                      {item.name ? <small>{item.name}</small> : null}
                    </span>
                    <small>{item.exchange ?? ''}</small>
                  </button>
                  <button
                    aria-label={
                      favorite
                        ? `取消收藏 ${item.ticker}`
                        : `收藏 ${item.ticker}`
                    }
                    aria-pressed={favorite}
                    className="symbol-picker-star"
                    onClick={() => toggleFavorite(item.ticker)}
                    title={favorite ? '取消收藏' : '收藏'}
                    type="button"
                  >
                    {favorite ? '★' : '☆'}
                  </button>
                </div>
              )
            })}
        </div>
      </div>
    </div>
  )
}
