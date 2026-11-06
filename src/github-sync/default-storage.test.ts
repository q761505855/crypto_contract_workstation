import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultGitHubClient, defaultStorageTarget, PUBLISHED_CLOUD_CONNECTION_URL, resolveDefaultGitHubToken } from './default-storage'

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
  it('prefers the configured credential without fetching the published connection', async () => {
    vi.stubEnv('VITE_GITHUB_TOKEN', 'local-test-token')
    const fetcher = vi.fn<typeof fetch>()
    expect(await resolveDefaultGitHubToken(fetcher)).toBe('local-test-token')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('authenticates a fresh checkout with the published Pages credential', async () => {
    vi.stubEnv('VITE_GITHUB_TOKEN', '')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1, project: 'crypto-contract-workstation', token: 'pages-test-token',
    })))
    const token = await resolveDefaultGitHubToken(fetcher)
    expect(fetcher).toHaveBeenCalledWith(PUBLISHED_CLOUD_CONNECTION_URL, expect.objectContaining({ cache: 'no-store', credentials: 'omit', signal: expect.any(AbortSignal) }))
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ full_name: 'q761505855/personal-cloud-storage', private: false, default_branch: 'main' })))
    vi.stubGlobal('fetch', request)
    try {
      const client = createDefaultGitHubClient(token)!
      await client.testConnection()
      expect(request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer pages-test-token' }) }))
      expect(client.getTarget().root).toBe('projects/crypto-contract-workstation')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it.each([
    null, {}, { schemaVersion: 2, project: 'crypto-contract-workstation', token: 'test' },
    { schemaVersion: 1, project: 'another-project', token: 'test' },
    ...[undefined, null, false, 0, [], {}, '', ' ', 'bad\nheader'].map(token => ({ schemaVersion: 1, project: 'crypto-contract-workstation', token })),
  ])('ignores an invalid published connection: %j', async value => {
    vi.stubEnv('VITE_GITHUB_TOKEN', '')
    const token = await resolveDefaultGitHubToken(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value))))
    expect(token).toBe('')
    expect(createDefaultGitHubClient(token)).toBeNull()
  })
  it('keeps startup available for old deployments, malformed JSON, and network failures', async () => {
    vi.stubEnv('VITE_GITHUB_TOKEN', '')
    for (const fetcher of [
      vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 })),
      vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>not JSON</html>')),
      vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')),
    ]) expect(await resolveDefaultGitHubToken(fetcher)).toBe('')
  })
})
