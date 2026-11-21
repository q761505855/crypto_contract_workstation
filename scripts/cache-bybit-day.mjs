import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'

const dayMs = 86_400_000
const hourMs = 3_600_000
const maxPartBytes = 16 * 1024 ** 2
const symbols = new Set(['SPYUSDT', 'QQQUSDT', 'XAUUSDT', 'BTCUSDT'])
export const archiveRoot = 'projects/crypto-contract-workstation/experiments/ctrader/data/bybit-trades'

export function archiveInputs(symbol, day) {
  const start = Date.parse(day)
  if (!symbols.has(symbol) || !/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(start) ||
      new Date(start).toISOString().slice(0, 10) !== day || start + dayMs > Date.now()) {
    throw new Error('请选择支持的 Bybit 品种和已经结束的 UTC 日期')
  }
  return start
}

export async function cacheBybitDay({ repository, symbol, day, fetcher = fetch }) {
  const start = archiveInputs(symbol, day)
  const target = resolve(repository, archiveRoot, symbol, day)
  const manifestPath = join(target, 'manifest.json')
  try {
    const cached = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (cached.version !== 1 || cached.symbol !== symbol || cached.day !== day || !cached.parts?.length) {
      throw new Error('现有 Bybit 归档清单无效')
    }
    return { target, cached: true, rows: cached.rows }
  } catch (error) { if (error.code !== 'ENOENT') throw error }

  const response = await fetcher(`https://public.bybit.com/trading/${symbol}/${symbol}${day}.csv.gz`,
    { signal: AbortSignal.timeout(360_000) })
  if (!response.ok || !response.body) throw new Error(`Bybit 日归档暂不可用（HTTP ${response.status}）`)
  await mkdir(dirname(target), { recursive: true })
  const staging = await mkdtemp(join(dirname(target), '.bybit-'))
  const parts = []
  let rows = 0
  let columns
  let part
  let previous = -Infinity
  const closePart = async () => {
    if (!part) return
    part.gzip.end()
    await part.done
    const checksum = createHash('sha256')
    let bytes = 0
    for await (const chunk of createReadStream(join(staging, part.file))) {
      checksum.update(chunk)
      bytes += chunk.length
    }
    parts.push({ file: part.file, hour: part.hour, rows: part.rows, bytes, sha256: checksum.digest('hex') })
    part = undefined
  }
  try {
    const gunzip = createGunzip()
    const transfer = pipeline(Readable.fromWeb(response.body), gunzip)
    // The read loop also sees stream errors; attach a rejection handler immediately.
    void transfer.catch(() => {})
    for await (const line of createInterface({ input: gunzip, crlfDelay: Infinity })) {
      if (!columns) {
        const names = line.replace(/^\uFEFF/, '').split(',')
        columns = ['timestamp', 'symbol', 'side', 'size', 'price', 'trdMatchID'].map(name => names.indexOf(name))
        if (columns.includes(-1)) throw new Error('Bybit 成交文件缺少必需字段')
        continue
      }
      if (!line) continue
      const [timestamp, ticker, side, size, price, id] = columns.map(index => line.split(',')[index])
      const time = Number(timestamp) * 1000
      if (!(time >= start && time < start + dayMs && time >= previous) || ticker !== symbol ||
          !['Buy', 'Sell'].includes(side) || !(Number(size) > 0 && Number(price) > 0) ||
          !Number.isFinite(Number(size)) || !Number.isFinite(Number(price)) || !id ||
          !/^[0-9]+(?:\.\d{1,6})?$/.test(timestamp) || !/^[\w-]+$/.test(id)) {
        throw new Error(`Bybit 成交文件第 ${rows + 2} 行无效：${line.slice(0, 90)}`)
      }
      previous = time
      const hour = Math.floor((time - start) / hourMs)
      if (!part || part.hour !== hour || part.written >= maxPartBytes) {
        const index = part?.hour === hour ? part.index + 1 : 0
        await closePart()
        const file = `${String(hour).padStart(2, '0')}-${String(index).padStart(3, '0')}.csv.gz`
        const gzip = createGzip()
        const output = createWriteStream(join(staging, file))
        const done = pipeline(gzip, output)
        void done.catch(() => {})
        part = { file, gzip, done, hour, index, rows: 0, written: 0 }
      }
      const record = `${timestamp},${id},${side},${price},${size}\n`
      if (!part.gzip.write(record)) await once(part.gzip, 'drain')
      part.written += record.length
      part.rows++
      rows++
    }
    await transfer
    await closePart()
    if (!rows) throw new Error('Bybit 日归档没有成交')
    const manifest = createWriteStream(join(staging, 'manifest.json'))
    manifest.end(JSON.stringify({ version: 1, symbol, day, rows, parts }) + '\n')
    await finished(manifest)
    await rename(staging, target)
    return { target, cached: false, rows }
  } finally {
    part?.gzip.destroy()
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [symbol, day, repository] = process.argv.slice(2)
  if (!repository) throw new Error('用法：node scripts/cache-bybit-day.mjs 品种 UTC日期 存储仓库目录')
  const result = await cacheBybitDay({ symbol, day, repository })
  console.log(`${symbol} ${day}：${result.rows} 笔，${result.cached ? '已缓存' : '校验完成'}`)
}
