import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Datafeed, SymbolInfo } from '@klinecharts/pro'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FAVORITE_SYMBOLS_STORAGE_KEY } from '../market-data/favorites'
import { SymbolPicker } from './SymbolPicker'

const symbols: SymbolInfo[] = [
  {
    ticker: 'BTCUSDT',
    shortName: 'BTCUSDT',
    name: 'BTC / USDT Perpetual',
    exchange: 'BINANCE',
  },
  {
    ticker: 'ETHUSDT',
    shortName: 'ETHUSDT',
    name: 'ETH / USDT Perpetual',
    exchange: 'BINANCE',
  },
]

function datafeed(): Datafeed {
  return {
    searchSymbols: vi.fn(async (search = '') => {
      const normalized = search.toUpperCase()
      return symbols.filter((item) => item.ticker.includes(normalized))
    }),
    getHistoryKLineData: vi.fn(async () => []),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }
}

afterEach(() => localStorage.clear())

describe('SymbolPicker', () => {
  it('opens on favorites and supports quick star toggles in both tabs', async () => {
    localStorage.setItem(
      FAVORITE_SYMBOLS_STORAGE_KEY,
      JSON.stringify(['BTCUSDT']),
    )
    const onSelect = vi.fn()
    render(
      <SymbolPicker
        currentSymbol={symbols[0]}
        datafeed={datafeed()}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    )

    expect(screen.getByRole('tab', { name: '收藏' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(
      await screen.findByRole('button', { name: '选择 BTCUSDT' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: '选择 ETHUSDT' }),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '全部' }))
    const addEth = await screen.findByRole('button', {
      name: '收藏 ETHUSDT',
    })
    fireEvent.click(addEth)

    expect(
      screen.getByRole('button', { name: '取消收藏 ETHUSDT' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      JSON.parse(
        localStorage.getItem(FAVORITE_SYMBOLS_STORAGE_KEY) ?? '[]',
      ),
    ).toEqual(['BTCUSDT', 'ETHUSDT'])

    fireEvent.click(screen.getByRole('tab', { name: '收藏' }))
    expect(
      screen.getByRole('button', { name: '选择 ETHUSDT' }),
    ).toBeVisible()
    fireEvent.click(
      screen.getByRole('button', { name: '取消收藏 BTCUSDT' }),
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: '选择 BTCUSDT' }),
      ).not.toBeInTheDocument(),
    )

    fireEvent.click(
      screen.getByRole('button', { name: '选择 ETHUSDT' }),
    )
    expect(onSelect).toHaveBeenCalledWith(symbols[1])
  })
})
