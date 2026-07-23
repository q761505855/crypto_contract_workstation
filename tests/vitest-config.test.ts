import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Vitest discovery configuration', () => {
  it('excludes project-local Git worktrees from test discovery', async () => {
    const config = await readFile('vitest.config.ts', 'utf8')

    expect(config).toContain("'.worktrees/**'")
    expect(config).toContain("'worktrees/**'")
  })
})
