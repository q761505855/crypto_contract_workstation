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
import catalog from '../src/market-data/bybit/instruments.json' with { type: 'json' }

const dayMs = 86_400_000
const hourMs = 3_600_000
const maxPartBytes = 16 * 1024 ** 2
export const archiveRoot = 'projects/crypto-contract-workstation/experiments/ctrader/data/bybit-trades'

export class BybitArchiveHttpError extends Error {
  constructor(status) {
    super(`Bybit 日归档暂不可用（HTTP ${status}）`)
    this.status = status
  }
}

export function archiveInputs(symbol, day, now = Date.now()) {
  const start = Date.parse(day)
  if (!Object.hasOwn(catalog.firstDays, symbol) || !/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(start) || day < catalog.firstDays[symbol] ||
      new Date(start).toISOString().slice(0, 10) !== day || start + dayMs > now) {
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

  const spot = catalog.spot.includes(symbol)
  const source = spot ? `spot/${symbol}/${symbol}_${day}` : `trading/${symbol}/${symbol}${day}`
  const response = await fetcher(`https://public.bybit.com/${source}.csv.gz`,
    { signal: AbortSignal.timeout(360_000) })
  if (!response.ok || !response.body) throw new BybitArchiveHttpError(response.status)
  await mkdir(dirname(target), { recursive: true })
  const staging = await mkdtemp(join(dirname(target), '.bybit-'))
  const parts = []
  const hours = new Map()
  const gunzip = createGunzip()
  let rows = 0
  let columns
  let part
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
    const transfer = pipeline(Readable.fromWeb(response.body), gunzip)
    // The read loop also sees stream errors; attach a rejection handler immediately.
    void transfer.catch(() => {})
    for await (const line of createInterface({ input: gunzip, crlfDelay: Infinity })) {
      if (!columns) {
        const names = line.replace(/^\uFEFF/, '').split(',')
        const required = spot ? ['timestamp', 'side', 'volume', 'price', 'id'] : ['timestamp', 'side', 'size', 'price', 'trdMatchID', 'symbol']
        columns = required.map(name => names.indexOf(name))
        if (columns.includes(-1)) throw new Error('Bybit 成交文件缺少必需字段')
        continue
      }
      if (!line) continue
      const fields = line.split(',')
      const [rawTime, rawSide, size, price, id, ticker = symbol] = columns.map(index => fields[index])
      const timestamp = spot && /^\d+$/.test(rawTime) ? `${rawTime.slice(0, -3)}.${rawTime.slice(-3)}` : rawTime
      const side = spot ? ({ buy: 'Buy', sell: 'Sell' })[rawSide] : rawSide
      const time = Number(timestamp) * 1000
      if (!(time >= start && time < start + dayMs) || ticker !== symbol ||
          !['Buy', 'Sell'].includes(side) || !(Number(size) > 0 && Number(price) > 0) ||
          !Number.isFinite(Number(size) * Number(price)) || !id ||
          !/^[0-9]+(?:\.\d{1,6})?$/.test(timestamp) || !/^[\w-]+$/.test(id)) {
        throw new Error(`Bybit 成交文件第 ${rows + 2} 行无效：${line.slice(0, 90)}`)
      }
      const hour = Math.floor((time - start) / hourMs)
      let spool = hours.get(hour)
      if (!spool) {
        const path = join(staging, `${hour}.csv`)
        const output = createWriteStream(path)
        const done = finished(output)
        void done.catch(() => {})
        spool = { path, output, done }
        hours.set(hour, spool)
      }
      if (!spool.output.write(`${timestamp},${id},${side},${price},${size}\n`)) await once(spool.output, 'drain')
      rows++
    }
    await transfer
    if (!rows) throw new Error('Bybit 日归档没有成交')
    for (const spool of hours.values()) spool.output.end()
    await Promise.all([...hours.values()].map(spool => spool.done))
    // Some older exports arrive in reverse order. Sort one hour at a time, retaining
    // the file's order for trades that carry an identical timestamp.
    for (const [hour, spool] of [...hours].sort(([a], [b]) => a - b)) {
      const records = (await readFile(spool.path, 'utf8')).trimEnd().split('\n')
        .map(line => ({ line, time: Number(line.slice(0, line.indexOf(','))) }))
      records.sort((a, b) => a.time - b.time)
      for (const { line } of records) {
        if (!part || part.written + line.length + 1 > maxPartBytes) {
          const index = part ? part.index + 1 : 0
          await closePart()
          const file = `${String(hour).padStart(2, '0')}-${String(index).padStart(3, '0')}.csv.gz`
          const gzip = createGzip()
          const done = pipeline(gzip, createWriteStream(join(staging, file)))
          void done.catch(() => {})
          part = { file, gzip, done, hour, index, rows: 0, written: 0 }
        }
        if (!part.gzip.write(line + '\n')) await once(part.gzip, 'drain')
        part.written += line.length + 1
        part.rows++
      }
      await closePart()
      await rm(spool.path)
    }
    const manifest = createWriteStream(join(staging, 'manifest.json'))
    manifest.end(JSON.stringify({ version: 1, symbol, day, rows, parts }) + '\n')
    await finished(manifest)
    await rename(staging, target)
    return { target, cached: false, rows }
  } finally {
    gunzip.destroy()
    for (const spool of hours.values()) spool.output.destroy()
    part?.gzip.destroy()
    await Promise.allSettled([...hours.values()].map(spool => spool.done).concat(part?.done ?? []))
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [symbol, day, repository] = process.argv.slice(2)
  if (!repository) throw new Error('用法：node scripts/cache-bybit-day.mjs 品种 UTC日期 存储仓库目录')
  const result = await cacheBybitDay({ symbol, day, repository })
  console.log(`${symbol} ${day}：${result.rows} 笔，${result.cached ? '已缓存' : '校验完成'}`)
}
