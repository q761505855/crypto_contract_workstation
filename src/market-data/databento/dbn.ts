import { decompress } from 'fzstd'

export interface DatabentoTrade {
  id: string
  time: number
  price: number
  size: number
  side: 'Buy' | 'Sell' | undefined
}

const DBN_TRADE_BYTES = 48
const text = new TextDecoder('utf-8', { fatal: true })

export function readDatabentoTrades(input: Uint8Array, product: string, day: string,
  accept: (contract: string, trade: DatabentoTrade) => void): string[] {
  const bytes = input[0] === 0x44 && input[1] === 0x42 && input[2] === 0x4e ? input : decompress(input)
  if (bytes.length < 128 || bytes[0] !== 0x44 || bytes[1] !== 0x42 || bytes[2] !== 0x4e ||
    bytes[3] < 1 || bytes[3] > 3) throw new Error('无法识别 Databento DBN v1–v3 文件')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = 8 + view.getUint32(4, true)
  const cString = (at: number, width: number) => text.decode(bytes.subarray(at, at + width)).replace(/\0+$/, '')
  if (end < 128 || end > bytes.length || cString(8, 16) !== 'GLBX.MDP3' || view.getUint16(24, true) !== 4 ||
    (bytes.length - end) % DBN_TRADE_BYTES !== 0 || bytes[52] !== 0) {
    throw new Error('需要完整的 CME GLBX.MDP3 Trades 日档')
  }
  const mappings = readContracts(bytes, view, end, cString, product, Number(day.replaceAll('-', '')))
  if (mappings.size === 0) throw new Error(`日档没有 ${product} 的实际合约映射`)
  for (let at = end; at < bytes.length; at += DBN_TRADE_BYTES) {
    if (bytes[at] !== 12 || bytes[at + 1] !== 0 || bytes[at + 28] !== 84) throw new Error('DBN 逐笔成交记录无效')
    const contract = mappings.get(view.getUint32(at + 4, true))
    if (!contract) continue
    // Historical Trades files are keyed by Databento's capture time (ts_recv).
    const ns = view.getBigUint64(at + 32, true)
    const time = Number(ns / 1000n) / 1000
    const rawPrice = view.getBigInt64(at + 16, true)
    const price = Number(rawPrice) / 1e9
    const size = view.getUint32(at + 24, true)
    const side = bytes[at + 29] === 66 ? 'Buy' : bytes[at + 29] === 65 ? 'Sell' : undefined
    if (ns === 0n || ns === 0xffff_ffff_ffff_ffffn || size === 0 || rawPrice === 0x7fff_ffff_ffff_ffffn) {
      throw new Error('DBN 成交时间、价格或数量无效')
    }
    accept(contract, { id: String((at - end) / DBN_TRADE_BYTES), time, price, size, side })
  }
  return [...new Set(mappings.values())]
}

function readContracts(bytes: Uint8Array, view: DataView, end: number, cString: (at: number, width: number) => string,
  product: string, day: number): Map<number, string> {
  const width = bytes[3] === 1 ? 22 : view.getUint16(53, true)
  if (!width || view.getUint32(108, true) !== 0) throw new Error('DBN 合约映射格式无效')
  const outputIsId = bytes[51] === 0
  if (!outputIsId && (bytes[50] !== 0 || bytes[51] !== 1)) throw new Error('DBN 日档缺少可解析的实际合约代码')
  let cursor = 112
  const advance = (length: number) => {
    const start = cursor
    cursor += length
    if (cursor > end) throw new Error('DBN 合约映射不完整')
    return start
  }
  const count = () => view.getUint32(advance(4), true)
  const symbol = () => cString(advance(width), width)
  for (let list = 0; list < 3; list++) advance(count() * width)
  const length = count()
  const contracts = new Map<number, string>()
  const parent = product.endsWith('.FUT')
  const root = parent ? product.slice(0, -4) : product
  for (let index = 0; index < length; index++) {
    const input = symbol()
    const intervals = count()
    for (let interval = 0; interval < intervals; interval++) {
      const start = count()
      const until = count()
      const output = symbol()
      const contract = outputIsId ? input : output
      const id = outputIsId ? output : input
      if (start > day || day >= until || !/^\d+$/.test(id)) continue
      if (parent ? contract.startsWith(root) && /^[FGHJKMNQUVXZ]\d{1,4}$/.test(contract.slice(root.length))
        : contract === product) contracts.set(Number(id), contract)
    }
  }
  return contracts
}
