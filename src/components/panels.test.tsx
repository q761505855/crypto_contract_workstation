import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from '../chart/chart-config'
import type { MarketCandle } from '../market-data/models'
import { ReplayEngine } from '../replay/replay-engine'
import { SimulationEngine } from '../simulation/simulation-engine'
import type { SimulationController } from '../simulation/useSimulationController'
import { SimulationOrder, SimulationDock, type TradingTab } from './TradingWorkspace'

afterEach(cleanup)

const candle: MarketCandle = {
  symbol: 'BTCUSDT', timeframe: '1m', openTime: 0, closeTime: 59_999,
  open: '100', high: '100', low: '100', close: '100', volume: '1',
  quoteVolume: '100', tradeCount: 1, isClosed: true, source: 'binance',
}

function Harness({ closePrice = candle.close }: { closePrice?: string }) {
  const [session] = useState(() => ReplayEngine.create({ symbol: DEFAULT_SYMBOL, period: SUPPORTED_PERIODS[0], startTime: 0, endTime: 0 }, [candle]).snapshot())
  const [engine] = useState(() => SimulationEngine.create(session))
  const [state, setState] = useState(() => engine.snapshot())
  const [tab, setTab] = useState<TradingTab>('positions')
  const publish = () => setState(engine.snapshot())
  const simulation: SimulationController = {
    state, busy: false, error: '', clearError() {},
    async preview(side, size) { return engine.previewOpen(side, size, candle.close) },
    async open(side, size) { engine.open(side, size, candle); publish() },
    async setOrderSettings(settings) { engine.setOrderSettings(settings); publish(); return true },
    async setWalletBalance(value) { engine.setWalletBalance(value, 0); publish(); return true },
    async reduce(side, quantity) { engine.reduce(side, quantity, candle); publish() },
    async reducePercent(side, percent) {
      const position = engine.snapshot().positions.find(position => position.side === side)!
      engine.reduce(side, String(Number(position.quantity) * percent / 100), candle); publish()
    },
    async closeAll(side) { engine.closeAll(side, { ...candle, close: closePrice }); publish() },
    setTakeProfit(side, price) { engine.setTakeProfit(side, price, 0); publish() },
    setStopLoss(side, price) { engine.setStopLoss(side, price, 0); publish() },
  }
  return <><SimulationOrder session={session} simulation={simulation} onClose={() => undefined} /><SimulationDock simulation={simulation} pricePrecision={session.symbol.pricePrecision} tab={tab} onTabChange={setTab} onClose={() => undefined} /></>
}

describe('simulation position cards', () => {
  it('shows isolated margin in the summary and position quantity in details', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '开多' }))
    const position = within(screen.getByTestId('position-long'))
    const summary = within(position.getByTestId('position-summary'))
    expect(summary.getByText('保证金', { exact: true }).nextElementSibling).toHaveTextContent('100.00 USDT')
    expect(summary.queryByText('数量', { exact: true })).not.toBeInTheDocument()

    fireEvent.click(position.getByRole('button', { name: '详情' }))
    const details = within(screen.getByRole('dialog', { name: '多仓 · 仓位详情' }))
    expect(details.getByText('数量', { exact: true }).nextElementSibling).toHaveTextContent('9.998')
  })

  it('previews and saves a short stop loss entered as a percentage of entry price', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /^空$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^开空$/ }))
    fireEvent.click(screen.getByRole('button', { name: '止盈止损' }))
    const dialog = within(screen.getByRole('dialog', { name: '空仓 · 止盈止损' }))
    fireEvent.change(dialog.getByLabelText('设置方式'), { target: { value: 'percent' } })
    fireEvent.change(dialog.getByLabelText('止损百分比'), { target: { value: '10' } })
    expect(dialog.getByText(/预计止损盈亏/)).toHaveTextContent('-100.57 USDT')
    expect(dialog.getByText(/预计止损盈亏/)).toHaveTextContent('109.98')
    fireEvent.click(dialog.getByRole('button', { name: '设置止损' }))
    expect(dialog.getByRole('status')).toHaveTextContent('止损 109.98')
  })

  it('allows hedging and keeps risk inputs and close actions bound to their position', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /^开多$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^空$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^开空$/ }))
    const long = within(screen.getByTestId('position-long'))
    const short = within(screen.getByTestId('position-short'))
    fireEvent.click(long.getByRole('button', { name: '止盈止损' }))
    const longDialog = within(screen.getByRole('dialog', { name: '多仓 · 止盈止损' }))
    fireEvent.change(longDialog.getByLabelText('止盈价格'), { target: { value: '120' } })
    fireEvent.click(longDialog.getByRole('button', { name: '设置止盈' }))
    fireEvent.click(longDialog.getByRole('button', { name: '完成' }))
    fireEvent.click(short.getByRole('button', { name: '止盈止损' }))
    const shortDialog = within(screen.getByRole('dialog', { name: '空仓 · 止盈止损' }))
    fireEvent.change(shortDialog.getByLabelText('止损价格'), { target: { value: '110' } })
    fireEvent.click(shortDialog.getByRole('button', { name: '设置止损' }))
    fireEvent.click(shortDialog.getByRole('button', { name: '完成' }))
    expect(long.getByTestId('position-summary')).toHaveTextContent('120 / —')
    expect(short.getByTestId('position-summary')).toHaveTextContent('— / 110')
    fireEvent.click(long.getByRole('button', { name: '减仓 / 平仓' }))
    const closeDialog = within(screen.getByRole('dialog', { name: '多仓 · 减仓和平仓' }))
    fireEvent.click(closeDialog.getByRole('button', { name: '全部平仓' }))
    expect(screen.queryByTestId('position-long')).not.toBeInTheDocument()
    expect(short.getByTestId('position-summary')).toHaveTextContent('— / 110')
    expect(screen.getByRole('button', { name: '同向加仓' })).toBeEnabled()
  })
})

it('distinguishes opening trades and realized gains, and shows signed wallet movements', () => {
  render(<Harness closePrice="120" />)
  const selectTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))
  const rows = (name: string) => within(screen.getByRole('tabpanel', { name })).getAllByRole('listitem')

  selectTab('成交记录')
  expect(screen.getByText('尚无成交')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '开多' }))
  expect(rows('成交记录')[0]).toHaveTextContent(/已实现盈亏\s*—/)
  selectTab('持仓 (1)')
  fireEvent.click(screen.getByRole('button', { name: '减仓 / 平仓' }))
  fireEvent.click(screen.getByRole('button', { name: '全部平仓' }))

  selectTab('成交记录')
  const [close, open] = rows('成交记录')
  expect(close).toHaveTextContent('平仓')
  expect(close).toHaveTextContent('多仓')
  expect(close).toHaveTextContent(/已实现盈亏\s*\+\d+\.\d+ USDT/)
  expect(open).toHaveTextContent('开仓')

  selectTab('账户流水')
  const [fee, pnl, , initial] = rows('账户流水')
  expect(fee).toHaveTextContent(/手续费.*变动金额\s*-0\.\d+ USDT/)
  expect(pnl).toHaveTextContent(/已实现盈亏.*变动金额\s*\+\d+\.\d+ USDT/)
  expect(initial).toHaveTextContent(/初始资金.*变动后余额\s*10,000\.0000 USDT/)
})

it('shows wallet costs while a position is open and classifies its net loss once it closes', () => {
  render(<Harness />)
  const selectTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))
  const stats = () => within(screen.getByRole('tabpanel', { name: '复盘统计' }))

  selectTab('复盘统计')
  expect(stats().getByText('尚无余额变动')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '开多' }))
  const balanceChart = stats().getByRole('slider', { name: '钱包余额曲线' })
  expect(balanceChart).toHaveAttribute('aria-valuenow', '1')
  fireEvent.keyDown(balanceChart, { key: 'Home' })
  expect(balanceChart).toHaveAttribute('aria-valuenow', '0')
  expect(balanceChart).toHaveAttribute('aria-valuetext', expect.stringContaining('10,000.00 USDT'))
  expect(stats().getByText('胜率', { exact: true }).nextElementSibling).toHaveTextContent('—')
  fireEvent.click(stats().getByRole('button', { name: /^回撤$/ }))
  expect(stats().getByRole('slider', { name: '回撤曲线' })).toBeVisible()

  selectTab('持仓 (1)')
  fireEvent.click(screen.getByRole('button', { name: '减仓 / 平仓' }))
  fireEvent.click(screen.getByRole('button', { name: '全部平仓' }))
  selectTab('复盘统计')
  expect(stats().getByText('完整平仓', { exact: true }).nextElementSibling).toHaveTextContent('1')
  expect(stats().getByText('胜率', { exact: true }).nextElementSibling).toHaveTextContent('0.00%')
})
