import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultGitHubClient, defaultStorageTarget } from './default-storage'

afterEach(() => vi.unstubAllEnvs())
describe('default project storage', () => {
  it('uses project-scoped build defaults and disables implicit write clients without a token', () => {
    for (const name of ['OWNER', 'REPOSITORY', 'BRANCH', 'STORAGE_ROOT', 'TOKEN']) vi.stubEnv(`VITE_GITHUB_${name}`, '')
    expect(defaultStorageTarget()).toEqual({ owner: 'q761505855', repository: 'personal-cloud-storage', branch: 'main', root: 'projects/crypto-contract-workstation' })
    expect(createDefaultGitHubClient()).toBeNull()
  })
  it('consumes build settings without exposing the credential on the target', () => {
    vi.stubEnv('VITE_GITHUB_TOKEN', 'test-only')
    vi.stubEnv('VITE_GITHUB_STORAGE_ROOT', 'projects/test')
    expect(createDefaultGitHubClient()?.getTarget()).toMatchObject({ root: 'projects/test' })
    expect(JSON.stringify(defaultStorageTarget())).not.toContain('test-only')
  })
})
