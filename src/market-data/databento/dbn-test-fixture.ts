export function tradeDbn(trades: readonly [string, number, number, number, string][],
  mapping = { from: 20261119, to: 20261125 }): Uint8Array<ArrayBuffer> {
  const symbols = [...new Set(trades.map(([symbol]) => symbol))]
  const headerLength = 128 + symbols.length * 154
  const data = new Uint8Array(headerLength + trades.length * 48)
  const view = new DataView(data.buffer)
  const write = (offset: number, value: string) => data.set(new TextEncoder().encode(value), offset)
  data.set([68, 66, 78, 3]); view.setUint32(4, headerLength - 8, true)
  write(8, 'GLBX.MDP3'); view.setUint16(24, 4, true)
  data[50] = 4; view.setUint16(53, 71, true)
  view.setUint32(124, symbols.length, true)
  for (const [index, symbol] of symbols.entries()) {
    const offset = 128 + index * 154
    write(offset, symbol); view.setUint32(offset + 71, 1, true)
    view.setUint32(offset + 75, mapping.from, true); view.setUint32(offset + 79, mapping.to, true)
    write(offset + 83, String(index + 1))
  }
  for (const [index, [symbol, time, price, size, side]] of trades.entries()) {
    const offset = headerLength + index * 48
    data[offset] = 12; view.setUint16(offset + 2, 1, true)
    view.setUint32(offset + 4, symbols.indexOf(symbol) + 1, true)
    view.setBigUint64(offset + 8, BigInt(time) * 1_000_000n + BigInt(index), true)
    view.setBigInt64(offset + 16, BigInt(Math.round(price * 1e9)), true)
    view.setUint32(offset + 24, size, true); write(offset + 28, `T${side}`)
    view.setBigUint64(offset + 32, BigInt(time) * 1_000_000n, true)
  }
  return data
}
