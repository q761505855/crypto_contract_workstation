import { scanOkxArchive, type OkxLocalFile } from './local-files'
import { buildLocalTradeIndex, type LocalTradeIndex } from './local-trade-index'

export interface LocalTradeIndexTask {
  file: File
  archive: OkxLocalFile
}

export type LocalTradeIndexResult = { index: LocalTradeIndex } | { error: string }

self.addEventListener('message', async ({ data }: MessageEvent<LocalTradeIndexTask>) => {
  try {
    const { file, archive } = data
    const index = (await buildLocalTradeIndex(async accept => {
      await scanOkxArchive(file, archive.symbol, archive.day, accept, undefined, false)
      return true
    }))!
    const transfer = [index.columns.buffer]
    if (index.order) transfer.push(index.order.buffer)
    self.postMessage({ index } satisfies LocalTradeIndexResult, { transfer })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies LocalTradeIndexResult)
  }
}, { once: true })
