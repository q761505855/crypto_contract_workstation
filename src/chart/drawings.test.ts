import { describe, expect, it } from 'vitest'
import { DrawingStore, drawingScope, mergeDrawings, validateDrawings } from './drawings'
import { drawingIndexAt, drawingTimeAt } from './drawing-coordinates'

const drawing = {
  id: 'drawing-horizontal', scope: 'live:BTCUSDT', name: 'horizontalStraightLine',
  points: [{ timestamp: 60_000, value: 120 }],
}

describe('drawing archive', () => {
  it('shares drawing records by product or replay session regardless of period', async () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) } }
    const main = new DrawingStore(storage)
    const auxiliary = new DrawingStore(storage)
    await main.save(drawing)
    expect(auxiliary.forScope(drawingScope('live', 'btcusdt', null))).toEqual([drawing])
    expect(auxiliary.forScope(drawingScope('history', 'BTCUSDT', 'replay-one'))).toEqual([])
    expect(auxiliary.forScope(drawingScope('history', 'BTCUSDT', null))).toEqual([drawing])
    expect(auxiliary.forScope(drawingScope('live', 'ETHUSDT', null))).toEqual([])
    await auxiliary.remove(drawing.id)
    expect(main.forScope(drawing.scope)).toEqual([])
  })

  it('merges independent additions and detects competing edits of one drawing', () => {
    const base = { epoch: 'initial', drawings: [drawing] }
    const local = { ...base, drawings: [drawing, { ...drawing, id: 'drawing-added' }] }
    const remote = { ...base, drawings: [{ ...drawing, points: [{ timestamp: 60_000, value: 130 }] }] }
    expect(mergeDrawings(base, local, remote)).toEqual({
      archive: { ...base, drawings: [{ ...drawing, id: 'drawing-added' }, ...remote.drawings] }, conflicts: [],
    })
    expect(mergeDrawings(base, { ...base, drawings: [] }, remote).conflicts).toEqual([drawing.id])
  })

  it('does not resurrect edits made against a cleared archive', () => {
    const base = { epoch: 'initial', drawings: [drawing] }
    const local = { ...base, drawings: [drawing, { ...drawing, id: 'drawing-offline' }] }
    const remote = { epoch: 'cleared', drawings: [] }
    expect(mergeDrawings(base, local, remote).archive).toEqual(remote)
  })

  it('keeps edits to separate anchors when two windows started from the same line', async () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) } }
    const first = new DrawingStore(storage)
    const second = new DrawingStore(storage)
    const line = { ...drawing, name: 'segment', points: [{ timestamp: 60_000, value: 120 }, { timestamp: 120_000, value: 130 }] }
    await first.save(line)
    await Promise.all([
      first.edit({ ...line, points: [{ timestamp: 60_000, value: 121 }, line.points[1]] }, 'initial', line),
      second.edit({ ...line, points: [line.points[0], { timestamp: 120_000, value: 132 }] }, 'initial', line),
    ])
    expect(first.forScope(line.scope)[0].points).toEqual([{ timestamp: 60_000, value: 121 }, { timestamp: 120_000, value: 132 }])
    await first.replace([line])
    await second.remove(line.id, 'initial')
    expect(first.forScope(line.scope)).toEqual([line])
  })

  it('accepts an empty archive and rejects invalid points and duplicate IDs', () => {
    expect(validateDrawings([])).toEqual([])
    expect(() => validateDrawings([drawing, drawing])).toThrow()
    expect(() => validateDrawings([{ ...drawing, points: [{ timestamp: 60_000, value: '120' }] }])).toThrow()
    expect(() => validateDrawings([{ ...drawing, styles: { line: { style: 'dashed', dashedValue: 42 } } }])).toThrow()
    expect(() => validateDrawings([{ ...drawing, styles: { point: { radius: -1 } } }])).toThrow()
    expect(() => validateDrawings([{ ...drawing, id: 'simulation-replay-time' }])).toThrow()
    expect(() => validateDrawings(null)).toThrow()
  })
})

it('preserves distinct minute anchors within one hourly candle and off the loaded range', () => {
  const candles = [{ timestamp: 3_600_000 }, { timestamp: 7_200_000 }]
  expect(drawingIndexAt(candles, 4_500_000, '1h')).toBe(0.25)
  expect(drawingIndexAt(candles, 5_400_000, '1h')).toBe(0.5)
  expect(drawingIndexAt(candles, 1_800_000, '1h')).toBe(-0.5)
  expect(drawingTimeAt(candles, 1.5, '1h')).toBe(9_000_000)
})
