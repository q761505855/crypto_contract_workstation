import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OkxLocalDownloadResult, OkxLocalFile, OkxLocalFiles } from '../market-data/okx/local-files'
import { OkxLocalDataDialog } from './OkxLocalDataDialog'

const symbol = 'BTC-USDT-SWAP'

function file(day: string, ticker = symbol): OkxLocalFile {
  return { symbol: ticker, day, filename: `${ticker}-trades-${day}.zip` }
}

function fixture(ready: boolean, initialFiles: OkxLocalFile[] = [], pickError?: Error) {
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
  const onChange = vi.fn()
  const onClose = vi.fn()
  render(<OkxLocalDataDialog files={files as unknown as OkxLocalFiles} symbol={symbol} onChange={onChange} onClose={onClose} />)
  return { files, downloaded, refresh, onChange, onClose }
}

afterEach(cleanup)

describe('OKX local data dialog', () => {
  it('enables download after opening a directory and only lists the current contract dates', async () => {
    const { onChange } = fixture(false, [file('2025-05-02'), file('2025-05-03', 'ETH-USDT-SWAP')])
    expect(screen.getByRole('button', { name: '下载 ZIP' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    expect(await screen.findByText('2025-05-02')).toBeVisible()
    expect(screen.queryByText('2025-05-03')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载 ZIP' })).toBeEnabled()
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('refreshes the chart when the folder is accessible but its handle cannot be remembered', async () => {
    const { onChange } = fixture(false, [file('2025-05-02')], new Error('无法保存文件夹授权'))
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存文件夹授权')
    expect(await screen.findByText('2025-05-02')).toBeVisible()
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('cancels a batch, retains saved dates, and updates the chart after a partial save', async () => {
    const { files, downloaded, refresh, onChange, onClose } = fixture(true)
    let progress!: (result: OkxLocalDownloadResult) => void
    files.download.mockImplementation((_symbol, _from, _to, report, signal) => {
      progress = report
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2025-05-01' } })
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2025-05-02' } })
    fireEvent.click(screen.getByRole('button', { name: '下载 ZIP' }))
    expect(files.download).toHaveBeenCalledWith(symbol, '2025-05-01', '2025-05-02', expect.any(Function), expect.any(AbortSignal))
    const close = screen.getByRole('button', { name: '关闭OKX 本地数据' })
    expect(close).toBeDisabled()
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      downloaded.push(file('2025-05-01'))
      progress({ day: '2025-05-01', status: 'saved' })
      refresh()
    })
    fireEvent.click(screen.getByRole('button', { name: '停止下载' }))
    expect(await screen.findByText('已停止下载。')).toBeVisible()
    expect(await screen.findByRole('list', { name: '本地 ZIP 文件' })).toHaveTextContent('2025-05-01')
    expect(onChange).toHaveBeenCalledOnce()
    expect(close).toBeEnabled()
  })
})
