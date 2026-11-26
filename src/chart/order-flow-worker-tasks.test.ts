import { expect, it } from 'vitest'
import { orderFlowSettings } from './order-flow-preferences'
import { runOrderFlowTask } from './order-flow-worker-tasks'
import { footprintRowsFromLevels, mergeFootprintLevels } from './order-flow-metrics'
import { VolumeProfileLevels } from './order-flow'

it('uses the true low and high after merging price levels from parallel chunks', () => {
  const levels = new VolumeProfileLevels()
  levels.addPacked(runOrderFlowTask({ kind: 'profile', values: new Float64Array([100, 1, 101, 3, 104, 2]) }))
  levels.addPacked(runOrderFlowTask({ kind: 'profile', values: new Float64Array([101, -5, 102, -7]) }))
  const settings = orderFlowSettings('profile')
  expect(levels.profile(10_000, settings)?.rows).toEqual([
    { low: 100, high: 101, buy: 1, sell: 0 },
    { low: 101, high: 102, buy: 3, sell: 5 },
    { low: 102, high: 103, buy: 0, sell: 7 },
    { low: 104, high: 104, buy: 2, sell: 0 },
  ])
  const single = new VolumeProfileLevels()
  single.add(100, 2)
  single.add(100, -1)
  expect(single.profile(100, settings)).toEqual({ poc: 100, vah: 100, val: 100,
    rows: [{ low: 100, high: 100, buy: 2, sell: 1 }] })
})

it('keeps OHLC price projection and exact aggregate bubble identities in a worker batch', () => {
  const values = new Float64Array([
    10, 2, 1000, 0,
    10, 3, 1000, 0,
    10, 4, 2000, 0,
    13, -1, 2000, 1,
  ])
  const bubble = runOrderFlowTask({ kind: 'bubbles', values, mode: 'aggregate', limit: 1,
    filter: { unit: 'quantity', minimum: 1, maximum: 0 } })
  expect(bubble).toEqual([{ row: 0, size: 5, count: 2, amount: 5 }])
  const settings = orderFlowSettings('footprint', { footprint: { grouping: 'manual' } })
  const footing = (part: Float64Array<ArrayBuffer>) => runOrderFlowTask({ kind: 'footprint', values: part, open: 20,
    firstBybitPrice: 10, projected: true, precision: 0, settings })
  const levels = mergeFootprintLevels([footing(values.slice(0, 8)), footing(values.slice(8))])
  expect(footprintRowsFromLevels(levels, settings, 0, 8)).toMatchObject([
    { low: 12.5, sell: 1 }, { low: 19.5, buy: 9, poc: true },
  ])
})
