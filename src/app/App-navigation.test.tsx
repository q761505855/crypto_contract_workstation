import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CTRADER_SYMBOL } from '../chart/chart-config'
import { ctraderStorage } from '../storage/ctrader-storage'
import { DEFAULT_TRADING_CONFIG, type ReplaySession } from '../replay/models'
import type { MarketSelection } from '../market-data/models'

const harness = vi.hoisted(() => ({
  chart: null as null | { jumpRequest: { id: string; timestamp: number } | null; onSelectionChange: (selection: MarketSelection) => void },
  replay: {
    session: null as ReplaySession | null, sessions: [], busy: false, error: '', preparationStatus: '', isPlaying: false,
    pause: vi.fn(), next: vi.fn(), previous: vi.fn(), reset: vi.fn(), jumpToEnd: vi.fn(), endSession: vi.fn(),
    play: vi.fn(), setSpeed: vi.fn(), createSession: vi.fn(), loadSession: vi.fn(),
  },
  simulation: { state: null, busy: false, error: '' },
  runtime: {
    datafeed: { setLiveEnabled: vi.fn(), setLiveStatusListener: vi.fn(), setReconnectListener: vi.fn() },
    replayDatafeed: { setSelectionListener: vi.fn(), setWarningListener: vi.fn(), setHistoryStatusListener: vi.fn(), setReplayContext: vi.fn() },
  },
}))

vi.mock('../market-data/runtime', () => ({ createMarketDataRuntime: () => harness.runtime }))
vi.mock('../replay/useCTraderReplayController', () => ({ useCTraderReplayController: () => harness.replay }))
vi.mock('../simulation/useSimulationController', () => ({ useSimulationController: () => harness.simulation }))
vi.mock('../components/DataManager', () => ({ DataManager: () => null }))
vi.mock('../components/panels', () => ({ SimulationPanel: () => null, LiveStatus: () => null }))
vi.mock('../chart/ChartWorkspace', () => ({ ChartWorkspace: (props: typeof harness.chart) => { harness.chart = props; return null } }))

import App from './App'

beforeEach(() => {
  vi.clearAllMocks()
  harness.chart = null
  harness.replay.session = null
  harness.replay.busy = false
  harness.simulation.busy = false
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function activeSession(): ReplaySession {
  return {
    schemaVersion: 2, id: 'navigation-session', symbol: DEFAULT_CTRADER_SYMBOL,
    period: { text: '15m', multiplier: 15, timespan: 'minute' },
    startTime: Date.UTC(2025, 8, 15), currentTime: Date.UTC(2025, 8, 15, 12), endTime: Date.UTC(2025, 8, 16),
    currentIndex: 48, candleCount: 97, speed: 1, status: 'paused', active: true, hasTrades: true,
    tradingConfig: DEFAULT_TRADING_CONFIG, createdAt: 0, updatedAt: 0,
  }
}

describe('App locate latest navigation', () => {
  it('requests the last revealed source minute without changing replay or trades', () => {
    harness.replay.session = activeSession()
    const before = structuredClone(harness.replay.session)
    render(<App />)
    act(() => harness.chart!.onSelectionChange({ symbol: DEFAULT_CTRADER_SYMBOL, period: { text: '1m', multiplier: 1, timespan: 'minute' } }))
    expect(screen.getByRole('contentinfo')).toHaveTextContent('EURUSD · 1m')
    fireEvent.click(screen.getByRole('button', { name: '定位最新' }))
    expect(harness.chart?.jumpRequest).toMatchObject({ timestamp: Date.UTC(2025, 8, 15, 12, 15) - 1, followLatest: false })
    expect(harness.replay.session).toEqual(before)
    expect(harness.replay.next).not.toHaveBeenCalled()
    expect(harness.replay.jumpToEnd).not.toHaveBeenCalled()
    expect(harness.replay.reset).not.toHaveBeenCalled()
    const first = harness.chart?.jumpRequest?.id
    fireEvent.click(screen.getByRole('button', { name: '定位最新' }))
    expect(harness.chart?.jumpRequest?.id).not.toBe(first)
  })

  it('uses click-time now without a replay boundary', () => {
    render(<App />)
    const now = Date.UTC(2026, 10, 5, 14, 32, 20)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    fireEvent.click(screen.getByRole('button', { name: '定位最新' }))
    expect(harness.chart?.jumpRequest).toMatchObject({ timestamp: now, followLatest: true })
  })

  it.each(['setup', 'active'] as const)('honors existing %s navigation locks', state => {
    if (state === 'setup') harness.replay.busy = true
    else { harness.replay.session = activeSession(); harness.simulation.busy = true }
    render(<App />)
    const latest = screen.getByRole('button', { name: '定位最新' })
    expect(latest).toBeDisabled()
    fireEvent.click(latest)
    expect(harness.chart?.jumpRequest).toBeNull()
  })
})


describe('workspace panel collapse controls', () => {
  it.each([
    ['下单面板', 'order'], ['持仓面板', 'dock'],
  ] as const)('retains an inline expand control after collapsing %s', (label, key) => {
    localStorage.clear()
    harness.replay.session = activeSession()
    render(<App />)
    const collapse = screen.getByRole('button', { name: `收起${label}` })
    expect(collapse).toHaveAttribute('aria-expanded', 'true')
    expect(collapse.querySelector('svg')).not.toBeNull()
    fireEvent.click(collapse)
    const expand = screen.getByRole('button', { name: `展开${label}` })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    expect(JSON.parse(ctraderStorage.getItem('workspace.layout.v1')!).panels[key]).toBe(false)
    fireEvent.click(expand)
    expect(screen.getByRole('button', { name: `收起${label}` })).toHaveAttribute('aria-expanded', 'true')
    expect(JSON.parse(ctraderStorage.getItem('workspace.layout.v1')!).panels[key]).toBe(true)
  })

  it.each(['history', 'live'] as const)('keeps replay and status visible in %s while preserving legacy archive flags', mode => {
    const layout = { schemaVersion: 1, panels: { account: false, order: true, dock: false, replay: false, status: false }, chartHeight: null, mobileChartHeight: null, dockHeight: 220 }
    ctraderStorage.setItem('workspace.layout.v1', JSON.stringify(layout))
    if (mode === 'history') harness.replay.session = activeSession()
    render(<App />)
    expect(screen.getByRole('button', { name: '定位最新' })).toBeVisible()
    expect(screen.getByRole('contentinfo')).toBeVisible()
    expect(screen.queryByRole('button', { name: /(?:展开|收起)(?:回放控制|底部状态)/ })).toBeNull()
    const tools = screen.getByRole('button', { name: '工具' })
    fireEvent.click(tools)
    fireEvent.click(screen.getByRole('button', { name: '工作区' }))
    expect(screen.queryByRole('checkbox', { name: '回放控制' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: '底部状态' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭工作区面板' }))
    fireEvent.click(tools)
    fireEvent.click(screen.getByRole('button', { name: '专注看图' }))
    expect(screen.getByRole('button', { name: '定位最新' })).toBeVisible()
    expect(screen.getByRole('contentinfo')).toBeVisible()
    expect(JSON.parse(ctraderStorage.getItem('workspace.layout.v1')!)).toEqual(layout)
  })

  it('expands the account summary again without opening workspace settings', () => {
    localStorage.clear()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '收起账户摘要' }))
    expect(screen.queryByRole('region', { name: '实时行情摘要' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开账户摘要' }))
    expect(screen.getByRole('region', { name: '实时行情摘要' })).toBeVisible()
  })
})
