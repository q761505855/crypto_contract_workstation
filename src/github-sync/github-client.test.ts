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
