import { readArchive, type ArchiveRead, type ArchiveResult, type ArchiveTask } from './archive-data'

export type ArchiveWorkerMessage = { task: ArchiveTask; request: ArchiveRead }
export type ArchiveWorkerReply = { result: ArchiveResult } | { error: string }

self.addEventListener('message', async ({ data }: MessageEvent<ArchiveWorkerMessage>) => {
  try {
    const result = await readArchive(data.task, data.request)
    const transfer = result.kind === 'trades'
      ? [result.index.columns.buffer, ...(result.index.order ? [result.index.order.buffer] : [])] : []
    self.postMessage({ result } satisfies ArchiveWorkerReply, { transfer })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies ArchiveWorkerReply)
  }
}, { once: true })
