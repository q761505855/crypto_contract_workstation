import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketDataRuntime } from '../market-data/runtime'
import { EMPTY_SERIES_SUMMARY, toSymbolInfo, type MarketSymbol } from '../market-data/models'
import { GitHubContentsClient } from '../github-sync/github-client'
import { defaultStorageTarget } from '../github-sync/default-storage'
import { BackupSyncPanel } from './BackupSyncPanel'
import { DataManager } from './DataManager'
import { HistoryUploadStatus } from './HistoryUploadStatus'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

const symbol: MarketSymbol = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: Date.UTC(2020, 0, 1), pricePrecision: 2, quantityPrecision: 3 }

function fixture() {
  let pending = 2
  const service = {
    getBaseUrl: () => 'https://example.test', getSymbols: vi.fn(async () => [symbol]),
    inspectSeries: vi.fn(async () => EMPTY_SERIES_SUMMARY), resetReplayRequests: vi.fn(),
    usesMinuteHistory: () => true,
    prepareHistory: vi.fn(async () => ({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1) - 60_000 })),
    getPendingUploadCount: () => pending,
    retryPendingUploads: vi.fn(async () => { pending = 0 }), deleteSeries: vi.fn(async () => undefined),
  }
  const compare = vi.fn(async (_client: GitHubContentsClient, _selection: unknown) => ({ localFiles: 1, localBytes: 12, remoteFiles: 0, remoteBytes: 0, changedFiles: 1 }))
  const runtime = { service, replaySessions: { list: async () => [] }, githubSync: { compare } } as unknown as MarketDataRuntime
  return { runtime, service, compare }
}

describe('history storage UI', () => {
  it('keeps pending cloud uploads visible outside the drawer until successful retry', () => {
    vi.useFakeTimers()
    let pending = 0
    const open = vi.fn()
    render(<HistoryUploadStatus service={{getPendingUploadCount:()=>pending}} onOpen={open}/>)
    expect(screen.queryByTestId('history-upload-status')).not.toBeInTheDocument()
    act(()=> { pending = 2; vi.advanceTimersByTime(1_000) })
    const status = screen.getByTestId('history-upload-status')
    expect(status).toHaveTextContent('已缓存，云端待上传：2 个月')
    fireEvent.click(status)
    expect(open).toHaveBeenCalledOnce()
    act(()=>vi.advanceTimersByTime(5_000))
    expect(status).toBeVisible()
    act(()=> { pending = 0; vi.advanceTimersByTime(1_000) })
    expect(screen.queryByTestId('history-upload-status')).not.toBeInTheDocument()
  })

  it('keeps the completed download message when a later background upload fails', async () => {
    const {runtime,service} = fixture()
    let warn: ((message:string) => void) | undefined
    service.prepareHistory.mockImplementation(async (...args:unknown[]) => {
      warn = (args[3] as {onWarning?:(message:string)=>void}).onWarning
      return {from:Date.UTC(2026,9,1),to:Date.UTC(2026,10,1)-60_000}
    })
    render(<DataManager open runtime={runtime} selection={{symbol:toSymbolInfo(symbol),period:{text:'5m',multiplier:5,timespan:'minute'}}} onApplySelection={()=>undefined} onClose={()=>undefined}/>)
    await waitFor(()=>expect(screen.getByRole('button',{name:'下载两类数据'})).toBeEnabled())
    fireEvent.click(screen.getByRole('button',{name:'下载两类数据'}))
    expect(await screen.findByText(/下载完成/)).toBeVisible()
    act(()=>warn?.('已缓存，待上传：模拟网络失败'))
    expect(screen.getByText(/下载完成/)).toBeVisible()
  })
  it('prepares both minute kinds for the previous complete UTC month regardless of chart timeframe', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 5, 10))
    const { runtime, service } = fixture()
    render(<DataManager open runtime={runtime} selection={{ symbol: toSymbolInfo(symbol), period: { text: '4h', multiplier: 4, timespan: 'hour' } }} onApplySelection={() => undefined} onClose={() => undefined} />)
    await waitFor(() => expect(service.inspectSeries).toHaveBeenCalledWith('trade', 'BTCUSDT', '1m'))
    expect(screen.getByText(/固定下载 1m/)).toBeVisible()
    expect(screen.getByTestId('history-range-preview')).toHaveTextContent('UTC')
    fireEvent.click(screen.getByRole('button', { name: '下载两类数据' }))
    await waitFor(() => expect(service.prepareHistory).toHaveBeenCalledWith('BTCUSDT', Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1) - 60_000, expect.objectContaining({ kinds: ['trade', 'mark'], signal: expect.any(AbortSignal) })))
    expect(await screen.findByText(/下载完成/)).toHaveTextContent('已缓存，待上传')
  })

  it('shows and retries pending cloud uploads without re-downloading', async () => {
    const { runtime, service } = fixture()
    render(<DataManager open runtime={runtime} selection={{ symbol: toSymbolInfo(symbol), period: { text: '1h', multiplier: 1, timespan: 'hour' } }} onApplySelection={() => undefined} onClose={() => undefined} />)
    fireEvent.click(await screen.findByRole('button', { name: /重试待上传/ }))
    await waitFor(() => expect(service.retryPendingUploads).toHaveBeenCalledOnce())
    expect(service.prepareHistory).not.toHaveBeenCalled()
    expect(await screen.findByText(/待上传：0/)).toBeVisible()
  })

  it('deletes minute source caches while the selected chart period remains 4h', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { runtime, service } = fixture()
    render(<DataManager open runtime={runtime} selection={{ symbol: toSymbolInfo(symbol), period: { text: '4h', multiplier: 4, timespan: 'hour' } }} onApplySelection={() => undefined} onClose={() => undefined} />)
    await waitFor(() => expect(service.getSymbols).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '删除当前缓存' }))
    await waitFor(() => expect(service.deleteSeries).toHaveBeenCalledWith('trade', 'BTCUSDT', '1m'))
    expect(service.deleteSeries).toHaveBeenCalledWith('mark', 'BTCUSDT', '1m')
  })

  it('uses the runtime default cloud client while keeping its credential out of the input', async () => {
    const { runtime, compare } = fixture()
    const defaultClient = new GitHubContentsClient(defaultStorageTarget(), 'test-only-placeholder')
    Object.assign(runtime, { defaultGitHubClient: defaultClient })
    render(<BackupSyncPanel runtime={runtime} symbol="BTCUSDT" timeframe="1m" disabled={false} onChanged={() => undefined} />)
    expect(screen.getByRole('heading', { name: 'GitHub 公共仓库同步' })).toBeVisible()
    expect(screen.getByLabelText('GitHub 用户或组织')).toHaveValue('q761505855')
    expect(screen.getByLabelText('GitHub 数据仓库')).toHaveValue('personal-cloud-storage')
    expect(screen.getByLabelText('GitHub Token')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '比较本地与云端' }))
    await waitFor(() => expect(compare).toHaveBeenCalledWith(defaultClient, expect.objectContaining({ config: true })))
  })

  it('preserves manually selected legacy repository roots and allows missing default clients', async () => {
    const { runtime, compare } = fixture()
    render(<BackupSyncPanel runtime={runtime} symbol="BTCUSDT" timeframe="1m" disabled={false} onChanged={() => undefined} />)
    fireEvent.change(screen.getByLabelText('GitHub 用户或组织'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('GitHub 数据仓库'), { target: { value: 'legacy' } })
    fireEvent.change(screen.getByLabelText('GitHub Token'), { target: { value: 'test-only-placeholder' } })
    fireEvent.click(screen.getByRole('button', { name: '比较本地与云端' }))
    await waitFor(() => expect(compare).toHaveBeenCalledOnce())
    expect(compare.mock.calls[0]![0].getTarget()).toEqual({ owner: 'alice', repository: 'legacy', branch: 'main' })
  })

  it.each([
    ['another branch', 'q761505855', 'personal-cloud-storage', 'history-copy'],
    ['owner casing', 'Q761505855', 'personal-cloud-storage', 'main'],
    ['repository casing', 'q761505855', 'PERSONAL-CLOUD-STORAGE', 'main'],
  ])('keeps the shared repository inside its project namespace after changing %s', async (_, owner, repository, branch) => {
    const { runtime, compare } = fixture()
    const defaultClient = new GitHubContentsClient(defaultStorageTarget(), 'test-only-placeholder')
    Object.assign(runtime, { defaultGitHubClient: defaultClient })
    render(<BackupSyncPanel runtime={runtime} symbol="BTCUSDT" timeframe="1m" disabled={false} onChanged={() => undefined} />)
    fireEvent.change(screen.getByLabelText('GitHub 用户或组织'), { target: { value: owner } })
    fireEvent.change(screen.getByLabelText('GitHub 数据仓库'), { target: { value: repository } })
    fireEvent.change(screen.getByLabelText('GitHub 分支'), { target: { value: branch } })
    fireEvent.click(screen.getByRole('button', { name: '比较本地与云端' }))
    await waitFor(() => expect(compare).toHaveBeenCalledOnce())
    const usedClient = compare.mock.calls[0]![0]
    expect(usedClient.getTarget()).toEqual({ owner, repository, branch, root: 'projects/crypto-contract-workstation' })
    expect(usedClient).not.toBe(defaultClient)
    expect(usedClient.canWrite()).toBe(false)
    expect(screen.getByText(/项目目录：projects\/crypto-contract-workstation/)).toBeVisible()
    expect(screen.queryByText(/手动仓库使用仓库根目录/)).not.toBeInTheDocument()
  })
})
