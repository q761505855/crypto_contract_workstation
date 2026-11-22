import { expect, it } from 'vitest'
import { DrawingStore } from '../chart/drawings'
import { DRAWING_CLOUD_PATH, DrawingAutoSync } from './drawing-auto-sync'
import type { GitHubFile } from './github-client'

const drawing = {
  id: 'drawing-line', scope: 'live:BTCUSDT', name: 'horizontalStraightLine',
  points: [{ timestamp: 120_000, value: 123 }],
}

function device() {
  const values = new Map<string, string>()
  return new DrawingStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } })
}

function repository() {
  const files = new Map<string, GitHubFile>()
  return { files, client: {
    canWrite: () => true,
    getSnapshot: async () => ({ commitSha: 'current', treeSha: 'tree' }),
    getFile: async (path: string) => files.get(path) ?? null,
    commitFiles: async (updated: readonly { path: string; bytes: Uint8Array }[]) => {
      for (const file of updated) files.set(file.path, { ...file, sha: 'cloud-blob' })
    },
  } }
}

it('restores a drawing on a clean device and syncs a clear without reviving its offline edits', async () => {
  const { files, client } = repository()
  const first = device()
  const second = device()
  const source = new DrawingAutoSync(first, client)
  const target = new DrawingAutoSync(second, client)
  await first.save(drawing)
  await source.flush()
  await target.flush()
  expect(second.forScope(drawing.scope)).toEqual([drawing])
  expect(second.read().cloudBytes).toBe(files.get(DRAWING_CLOUD_PATH)?.bytes.length)

  const styles = { line: { color: '#12ab34', size: 3 } }
  await first.editAppearance(drawing.id, 'initial', () => ({ locked: true, styles }))
  await source.flush()
  await target.flush()
  expect(second.forScope(drawing.scope)).toEqual([{ ...drawing, locked: true, styles }])
  await second.editAppearance(drawing.id, 'initial', () => ({ locked: false }))
  await target.flush()
  await source.flush()
  expect(first.forScope(drawing.scope)).toEqual([{ ...drawing, locked: false, styles }])

  await second.edit({ ...drawing, points: [{ timestamp: 120_000, value: 124 }] })
  await first.replace([])
  await source.flush()
  await target.flush()
  expect(second.forScope(drawing.scope)).toEqual([])
  const fresh = device()
  await fresh.save({ ...drawing, id: 'drawing-new-offline' })
  await new DrawingAutoSync(fresh, client).flush()
  await source.flush()
  expect(first.forScope(drawing.scope)).toEqual([{ ...drawing, id: 'drawing-new-offline' }])
})

it('leaves local drawings untouched when the remote checksum is invalid', async () => {
  const { files, client } = repository()
  const store = device()
  await store.save(drawing)
  const sync = new DrawingAutoSync(store, client)
  await sync.flush()
  const prior = files.get(DRAWING_CLOUD_PATH)!
  const raw = JSON.parse(new TextDecoder().decode(prior.bytes))
  raw.archive.drawings[0].points[0].value = 999
  files.set(DRAWING_CLOUD_PATH, { ...prior, bytes: new TextEncoder().encode(JSON.stringify(raw)) })
  await sync.flush()
  expect(sync.getStatus().phase).toBe('error')
  expect(store.forScope(drawing.scope)).toEqual([drawing])
})
