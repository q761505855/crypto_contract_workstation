import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OkxLocalDownloadResult, OkxLocalFile, OkxLocalFiles } from '../market-data/okx/local-files'
import { OkxLocalDataDialog } from './OkxLocalDataDialog'
import { OkxLocalDownloads } from '../market-data/okx/local-downloads'

const symbol = 'BTC-USDT-SWAP'

function file(day: string, ticker = symbol): OkxLocalFile {
  return { symbol: ticker, day, filename: `${ticker}-trades-${day}.zip` }
}

function fixture(ready: boolean, initialFiles: OkxLocalFile[] = [], pickError?: Error, anchor?: string) {
  let revision = 0
  const listeners = new Set<() => void>()
  const refresh = () => {
    revision++
    for (const listener of listeners) listener()
  }
  const downloaded = [...initialFiles]
  const files = {
    name: ready ? 'OKX-ZIP' : undefined,
    available: true,
    ready,
    get revision() { return revision },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async pick() {
      files.name = 'OKX-ZIP'
      files.ready = true
      refresh()
      if (pickError) throw pickError
    },
    async list() { return [...downloaded] },
    download: vi.fn<OkxLocalFiles['download']>(),
  }
  const onFolderChange = vi.fn()
  const onLoad = vi.fn(async () => {})
  const onClose = vi.fn()
  const local = files as unknown as OkxLocalFiles
  const downloads = new OkxLocalDownloads(local)
  render(<OkxLocalDataDialog files={local} downloads={downloads} symbol={symbol} anchor={anchor}
    onFolderChange={onFolderChange} onLoad={onLoad} onClose={onClose} />)
  return { files, downloaded, refresh, onFolderChange, onLoad, onClose }
}

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('OKX local data dialog', () => {
  it('enables download after opening a directory and only lists the current contract dates', async () => {
    const { onFolderChange, onLoad } = fixture(false, [file('2025-05-02'), file('2025-05-03', 'ETH-USDT-SWAP')])
    expect(screen.getByRole('button', { name: '下载 ZIP' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    expect(await screen.findByText('2025-05-02')).toBeVisible()
    expect(screen.queryByText('2025-05-03')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载 ZIP' })).toBeEnabled()
    expect(onFolderChange).toHaveBeenCalledExactlyOnceWith(true)
    expect(onLoad).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: '2025-05-02' }))
    fireEvent.click(screen.getByRole('button', { name: '加载所选日期' }))
    expect(onLoad).toHaveBeenCalledExactlyOnceWith(symbol, ['2025-05-02'], false)
  })

  it('refreshes the chart when the folder is accessible but its handle cannot be remembered', async () => {
    const { onFolderChange } = fixture(false, [file('2025-05-02')], new Error('无法保存文件夹授权'))
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存文件夹授权')
    expect(await screen.findByText('2025-05-02')).toBeVisible()
    expect(onFolderChange).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('can close the toolbar dialog during download and loads each successful day before the batch finishes', async () => {
    const { files, downloaded, refresh, onLoad, onClose } = fixture(true, [], undefined, '2025-05-02')
    let progress!: (result: OkxLocalDownloadResult) => void
    files.download.mockImplementation((_symbol, _from, _to, report, signal) => {
      progress = report
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    fireEvent.change(screen.getByLabelText('往前天数'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    expect(files.download).toHaveBeenCalledWith(symbol, '2025-05-01', '2025-05-02', expect.any(Function), expect.any(AbortSignal), '2025-05-02')
    const close = screen.getByRole('button', { name: '关闭下载成交数据' })
    expect(close).toBeEnabled()
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    act(() => {
      downloaded.push(file('2025-05-01'))
      progress({ day: '2025-05-01', status: 'saved' })
      refresh()
    })
    expect(onLoad).toHaveBeenCalledExactlyOnceWith(symbol, ['2025-05-01'], true)
    fireEvent.click(screen.getByRole('button', { name: '停止下载' }))
    expect(await screen.findByText('已停止下载。')).toBeVisible()
    expect(await screen.findByRole('list', { name: '本地 ZIP 文件' })).toHaveTextContent('2025-05-01')
    expect(close).toBeEnabled()
  })

  it('downloads from the current calendar day in data management and waits for an explicit load', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2025-05-05T17:00:00Z'))
    const { files, onLoad } = fixture(true)
    files.download.mockImplementation(async (_symbol, _from, _to, report) => {
      report({ day: '2025-05-01', status: 'existing' })
      report({ day: '2025-05-02', status: 'existing' })
      report({ day: '2025-05-03', status: 'unavailable' })
    })
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2025-05-01' } })
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2025-05-03' } })
    fireEvent.click(screen.getByRole('button', { name: '下载 ZIP' }))
    expect(await screen.findByText('本次下载任务已结束。')).toBeVisible()
    expect(files.download).toHaveBeenCalledWith(symbol, '2025-05-01', '2025-05-03', expect.any(Function), expect.any(AbortSignal), '2025-05-06')
    expect(onLoad).not.toHaveBeenCalled()
  })

  it('accepts today as an anchor, downloads only completed UTC+8 dates and uses the selected directory', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2025-05-05T17:00:00Z'))
    const { files } = fixture(false, [], undefined, '2025-05-06')
    files.download.mockResolvedValue(undefined)
    expect(screen.getByRole('dialog', { name: '下载成交数据' })).toBeVisible()
    expect(screen.getByLabelText('锚点日期')).toHaveValue('2025-05-06')
    expect(screen.getByRole('button', { name: '下载' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    await screen.findByText('OKX-ZIP')
    fireEvent.change(screen.getByLabelText('往前天数'), { target: { value: '0' } })
    expect(screen.getByText(/没有已结束的归档日期/)).toBeVisible()
    fireEvent.change(screen.getByLabelText('往前天数'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('往后天数'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    await screen.findByText('本次下载任务已结束。')
    expect(files.download).toHaveBeenCalledWith(symbol, '2025-05-03', '2025-05-05', expect.any(Function), expect.any(AbortSignal), '2025-05-06')
  })
})
