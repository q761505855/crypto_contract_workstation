import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubContentsClient } from '../github-sync/github-client'
import { defaultStorageTarget } from '../github-sync/default-storage'
import type { MarketDataRuntime } from '../market-data/runtime'
import { BackupSyncPanel } from './BackupSyncPanel'
import { DataManager } from './DataManager'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

function fixture() {
  const service = { getSymbols: vi.fn(async () => []) }
  const compare = vi.fn(async (_client: GitHubContentsClient, _selection: unknown) => ({ localFiles: 1, localBytes: 12, remoteFiles: 0, remoteBytes: 0, changedFiles: 1 }))
  const runtime = { service, replaySessions: { list: async () => [] }, githubSync: { compare } } as unknown as MarketDataRuntime
  return { runtime, service, compare }
}

describe('cTrader archive interface', () => {
  it('retains an in-flight cloud operation and its selections when the drawer rerenders', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { runtime } = fixture()
    let finishPull!: (result: { files: number; bytes: number }) => void
    Object.assign(runtime.githubSync, { pull: vi.fn(() => new Promise(resolve => { finishPull = resolve })) })
    const { rerender } = render(<DataManager runtime={runtime} onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('checkbox', { name: '会话与交易' }))
    fireEvent.click(screen.getByTestId('github-pull'))
    expect(screen.getByTestId('github-pull')).toBeDisabled()
    rerender(<DataManager runtime={runtime} onClose={() => undefined} />)
    expect(screen.getByRole('checkbox', { name: '会话与交易' })).not.toBeChecked()
    expect(screen.queryByRole('checkbox', { name: '历史行情' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '下载历史数据' })).not.toBeInTheDocument()
    expect(screen.getByTestId('github-pull')).toBeDisabled()
    await act(async () => finishPull({ files: 2, bytes: 494 }))
    expect(screen.getByTestId('backup-status')).toHaveTextContent('云端恢复完成：2 个文件')
    expect(screen.getByTestId('github-pull')).toBeEnabled()
  })

  it('uses the default cloud client without placing its token in the input', async () => {
    const { runtime, compare } = fixture()
    const client = new GitHubContentsClient(defaultStorageTarget(), 'test-only-placeholder')
    Object.assign(runtime, { defaultGitHubClient: client })
    render(<BackupSyncPanel runtime={runtime} disabled={false} />)
    expect(screen.getByLabelText('GitHub Token')).toHaveValue('')
    fireEvent.click(screen.getByTestId('github-compare'))
    await waitFor(() => expect(compare).toHaveBeenCalledWith(client, { config: true, sessions: true, marketData: false }))
  })

  it.each([
    ['q761505855', 'personal-cloud-storage', 'other-branch'],
    ['alice', 'alternate-storage', 'main'],
  ])('keeps the experiment root for %s/%s on %s', async (owner, repository, branch) => {
    const { runtime, compare } = fixture()
    render(<BackupSyncPanel runtime={runtime} disabled={false} />)
    fireEvent.change(screen.getByLabelText('GitHub 用户或组织'), { target: { value: owner } })
    fireEvent.change(screen.getByLabelText('GitHub 数据仓库'), { target: { value: repository } })
    fireEvent.change(screen.getByLabelText('GitHub 分支'), { target: { value: branch } })
    fireEvent.click(screen.getByTestId('github-compare'))
    await waitFor(() => expect(compare).toHaveBeenCalledOnce())
    expect(compare.mock.calls[0][0].getTarget()).toEqual({ owner, repository, branch, root: defaultStorageTarget().root })
  })
})
