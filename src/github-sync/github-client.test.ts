import { describe, expect, it, vi } from 'vitest'
import {
  GitHubConflictError,
  GitHubContentsClient,
} from './github-client'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('GitHubContentsClient', () => {
  it('reads the current branch head after another upload despite a fresh browser HTTP cache', async () => {
    let head = 'first'
    let cachedHead: string | undefined
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith('/git/ref/heads/main')) {
        cachedHead ??= head
        return jsonResponse({object:{sha:init?.cache === 'no-store' ? head : cachedHead}})
      }
      const commit = String(input).split('/').at(-1)
      return jsonResponse({tree:{sha:`tree-${commit}`}})
    })
    const client = new GitHubContentsClient({owner:'alice',repository:'backup',branch:'main'},'token',fetcher)
    expect((await client.getSnapshot()).commitSha).toBe('first')
    head = 'second'
    expect(await client.getSnapshot()).toEqual({commitSha:'second',treeSha:'tree-second'})
  })

  it.each([false,true])('reads changed branch file metadata and bytes without stale HTTP cache (raw=%s)', async (raw) => {
    let content = 'before'
    const cached = new Map<string,string>()
    const fetcher = vi.fn<typeof fetch>(async (input,init) => {
      const isRaw = (init?.headers as Record<string,string>).Accept.includes('raw+json')
      const key = `${input}:${isRaw}`
      if (!cached.has(key)) cached.set(key,content)
      const value = init?.cache === 'no-store' ? content : cached.get(key)!
      return isRaw ? new Response(value) : jsonResponse({type:'file',path:'preferences.json',sha:value,encoding:raw?'none':'base64',content:btoa(value)})
    })
    const client = new GitHubContentsClient({owner:'alice',repository:'backup',branch:'main'},'token',fetcher)
    expect(new TextDecoder().decode((await client.getFile('preferences.json'))!.bytes)).toBe('before')
    content = 'after'
    const file = await client.getFile('preferences.json')
    expect(file?.sha).toBe('after')
    expect(new TextDecoder().decode(file!.bytes)).toBe('after')
  })

  it('allows public scoped reads and rejects traversal and unauthenticated writes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ type: 'file', path: 'projects/app/manifest.json', sha: 'a', encoding: 'base64', content: btoa('{}') }))
    const client = new GitHubContentsClient({ owner: 'alice', repository: 'backup', branch: 'main', root: 'projects/app' }, '', fetcher)
    expect((await client.getFile('manifest.json'))?.path).toBe('manifest.json')
    expect(String(fetcher.mock.calls[0][0])).toContain('/contents/projects/app/manifest.json?')
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization')
    for (const path of ['../x', 'a\\b', '/x', 'a/%2e%2e/x']) await expect(client.getFile(path)).rejects.toThrow()
    await expect(client.putFile('x', new Uint8Array(), 'write')).rejects.toThrow(/Token/)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('uses the authenticated raw contents API for large files at the same immutable ref', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ type: 'file', path: 'large.gz', sha: 'blob', encoding: 'none', size: 2_000_000, content: '' }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
    const client = new GitHubContentsClient({ owner: 'alice', repository: 'backup', branch: 'main' }, 'token', fetcher)
    expect((await client.getFile('large.gz', { ref: 'commit' }))?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(String(fetcher.mock.calls[1][0])).toContain('?ref=commit')
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ Accept: 'application/vnd.github.raw+json', Authorization: 'Bearer token' })
  })

  it('commits scoped files atomically and rejects a branch race without forcing', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sha: 'blob' }))
      .mockResolvedValueOnce(jsonResponse({ sha: 'tree' }))
      .mockResolvedValueOnce(jsonResponse({ sha: 'commit' }))
      .mockResolvedValueOnce(jsonResponse({}, 422))
    const client = new GitHubContentsClient({ owner: 'alice', repository: 'backup', branch: 'main', root: 'projects/app' }, 'token', fetcher)
    await expect(client.commitFiles([{ path: 'manifest.json', bytes: new Uint8Array([1]) }], 'atomic', { commitSha: 'parent', treeSha: 'base' })).rejects.toBeInstanceOf(GitHubConflictError)
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({ base_tree: 'base', tree: [{ path: 'projects/app/manifest.json', mode: '100644', type: 'blob', sha: 'blob' }] })
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toMatchObject({ parents: ['parent'] })
    expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body))).toEqual({ sha: 'commit', force: false })
  })
  it('tests a private repository connection with the required API headers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        full_name: 'alice/trading-backup',
        private: true,
        default_branch: 'main',
        permissions: { push: true },
      }),
    )
    const client = new GitHubContentsClient(
      {
        owner: 'alice',
        repository: 'trading-backup',
        branch: 'main',
      },
      'github_pat_secret',
      fetcher,
    )

    await expect(client.testConnection()).resolves.toEqual({
      fullName: 'alice/trading-backup',
      private: true,
      defaultBranch: 'main',
      canPush: true,
    })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe(
      'https://api.github.com/repos/alice/trading-backup',
    )
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer github_pat_secret',
      'X-GitHub-Api-Version': '2026-03-10',
    })
  })

  it('reads and updates base64 file contents with the expected SHA', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          type: 'file',
          path: 'config/preferences.json',
          sha: 'old-sha',
          encoding: 'base64',
          content: btoa('hello'),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ content: { sha: 'new-sha' } }, 200),
      )
    const client = new GitHubContentsClient(
      { owner: 'alice', repository: 'backup', branch: 'develop' },
      'token',
      fetcher,
    )

    const file = await client.getFile('config/preferences.json')
    expect(new TextDecoder().decode(file?.bytes)).toBe('hello')
    await expect(
      client.putFile(
        'config/preferences.json',
        new TextEncoder().encode('updated'),
        'Update settings',
        file?.sha,
      ),
    ).resolves.toBe('new-sha')

    const [, putInit] = fetcher.mock.calls[1]
    expect(JSON.parse(String(putInit?.body))).toEqual({
      message: 'Update settings',
      content: btoa('updated'),
      branch: 'develop',
      sha: 'old-sha',
    })
  })

  it('distinguishes missing files, authorization failures, and conflicts', async () => {
    const missingClient = new GitHubContentsClient(
      { owner: 'alice', repository: 'backup', branch: 'main' },
      'secret-token',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })),
    )
    await expect(missingClient.getFile('missing.json')).resolves.toBeNull()

    const unauthorizedClient = new GitHubContentsClient(
      { owner: 'alice', repository: 'backup', branch: 'main' },
      'secret-token',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
    )
    const error = await unauthorizedClient
      .testConnection()
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('Token')
    expect(String(error)).not.toContain('secret-token')

    const conflictClient = new GitHubContentsClient(
      { owner: 'alice', repository: 'backup', branch: 'main' },
      'token',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 409 })),
    )
    await expect(
      conflictClient.putFile(
        'config/preferences.json',
        new Uint8Array([1]),
        'Update',
        'stale-sha',
      ),
    ).rejects.toBeInstanceOf(GitHubConflictError)
  })

  it('rejects unsafe repository segments and file paths before fetching', async () => {
    expect(
      () =>
        new GitHubContentsClient(
          { owner: '../alice', repository: 'backup', branch: 'main' },
          'token',
        ),
    ).toThrow()

    const fetcher = vi.fn<typeof fetch>()
    const client = new GitHubContentsClient(
      { owner: 'alice', repository: 'backup', branch: 'main' },
      'token',
      fetcher,
    )
    await expect(client.getFile('../secret')).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
