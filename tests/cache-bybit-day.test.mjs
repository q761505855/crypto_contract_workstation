import { gunzipSync, gzipSync } from 'node:zlib'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { archiveRoot, cacheBybitDay } from '../scripts/cache-bybit-day.mjs'

const symbol = 'SPYUSDT'
const day = '2026-05-15'
const header = 'timestamp,symbol,side,size,price,trdMatchID'
const utc = Date.parse(day) / 1000

describe('Bybit 日成交缓存', () => {
  it('按 UTC 天下载一次，保存带校验和的小时分片', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bybit-test-'))
    const fetcher = vi.fn(async () => new Response(new Uint8Array(gzipSync(
      [header, `${utc + 3600},${symbol},Sell,2,601,b`, `${utc}.123457,${symbol},Buy,1,599,c`,
        `${utc}.123456,${symbol},Buy,1,600,a`, ''].join('\n'),
    ))))
    try {
      const first = await cacheBybitDay({ repository, symbol, day, fetcher })
      expect(first).toMatchObject({ cached: false, rows: 3 })
      const path = join(repository, archiveRoot, symbol, day)
      expect(JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))).toMatchObject({
        version: 1, symbol, day, rows: 3,
        parts: [
          { file: '00-000.csv.gz', rows: 2, hour: 0, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
          { file: '01-000.csv.gz', rows: 1, hour: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        ],
      })
      expect(gunzipSync(await readFile(join(path, '00-000.csv.gz'))).toString()).toBe(
        `${utc}.123456,a,Buy,600,1\n${utc}.123457,c,Buy,599,1\n`,
      )
      expect(await cacheBybitDay({ repository, symbol, day, fetcher })).toMatchObject({ cached: true, rows: 3 })
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally { await rm(repository, { recursive: true, force: true }) }
  })

  it('拒绝越界日期或无效品种，在连接之前完成校验', async () => {
    const fetcher = vi.fn()
    await expect(cacheBybitDay({ repository: '.', symbol: '../../unrelated', day, fetcher })).rejects.toThrow('请选择')
    await expect(cacheBybitDay({ repository: '.', symbol, day: '2026-02-31', fetcher })).rejects.toThrow('请选择')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
