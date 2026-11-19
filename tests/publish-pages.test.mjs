// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { publishPages } from '../scripts/publish-pages.mjs'

const token = 'published-test-token'
const commit = 'a'.repeat(40)
const repository = 'github.com/q761505855/crypto_contract_workstation'
const connection = { schemaVersion: 1, project: 'crypto-contract-workstation', token }

function releaseMocks(event = 'push') {
  const workflowRun = { databaseId: 2, event, status: 'completed', conclusion: 'success' }
  const oldRun = { ...workflowRun, databaseId: 1 }
  const workflowRuns = vi.fn().mockReturnValueOnce([oldRun])
    .mockReturnValueOnce([{ ...workflowRun, status: 'in_progress' }, oldRun])
    .mockReturnValue([workflowRun, oldRun])
  const command = vi.fn((program, args) => {
    if (program === 'gh' && args[0] === 'run') return JSON.stringify(workflowRuns())
    if (program === 'gh' && args[0] === 'workflow') return ''
    if (args[0] === 'merge-base') return ''
    if (args[0] === 'branch') return 'main'
    if (args[0] === 'status') return ''
    if (args[0] === 'remote') return `https://${repository}.git`
    if (args[0] === 'rev-parse') return commit
    if (args[0] === 'ls-remote') return `${commit}\trefs/heads/main`
    if (args[0] === 'push') return event === 'push' ? ' \tHEAD:refs/heads/main\ta..b' : '=\tHEAD:refs/heads/main\t[up to date]'
    throw new Error(`Unexpected command: ${program} ${args.join(' ')}`)
  })
  const request = vi.fn()
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(Response.json(connection))
    .mockResolvedValueOnce(new Response('', { status: 200 }))
  return {
    command,
    request,
    pause: vi.fn(),
    log: vi.fn(),
  }
}

describe('Pages publishing', () => {
  it('publishes with the existing Actions Secret and authenticates the online token after deployment', async () => {
    const mocks = releaseMocks()
    await publishPages(mocks)

    expect(mocks.command).toHaveBeenCalledWith('git', ['push', '--porcelain', 'origin', `${commit}:refs/heads/main`], expect.any(String))
    expect(mocks.command.mock.calls.filter(([program]) => program === 'gh').map(([, args]) => args[0])).toEqual(['run', 'run', 'run'])
    expect(mocks.request.mock.calls[0][0].pathname).toBe('/crypto_contract_workstation/cloud-connection.json')
    expect(mocks.request.mock.calls[1][0].search).not.toBe(mocks.request.mock.calls[0][0].search)
    expect(mocks.request).toHaveBeenNthCalledWith(3, 'https://api.github.com/user', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
    }))
    expect(mocks.log.mock.lastCall[0]).toContain('发布成功')
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(token)
  })

  it('dispatches a fresh workflow for a token-only change with no commit to push', async () => {
    const mocks = releaseMocks('workflow_dispatch')
    await publishPages(mocks)

    expect(mocks.command).toHaveBeenCalledWith('gh', [
      'workflow', 'run', 'deploy-pages.yml', '--ref', 'main', '--repo', repository,
    ], expect.any(String))
    expect(mocks.log.mock.lastCall[0]).toContain('发布成功')
  })

  it('reports a deployed connection with a rejected token and does not print it', async () => {
    const mocks = releaseMocks()
    mocks.request.mockReset().mockImplementation(url => url instanceof URL
      ? Promise.resolve(Response.json(connection))
      : Promise.resolve(new Response('', { status: 401 })))
    await expect(publishPages(mocks)).rejects.toThrow('线上云同步连接未通过验证')

    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(token)
  })

  it('reports a missing or invalid connection without authenticating an invalid token', async () => {
    const mocks = releaseMocks()
    mocks.request.mockReset().mockImplementation(async () => Response.json({ ...connection, token: ' ' }))
    await expect(publishPages(mocks)).rejects.toThrow('CLOUD_STORAGE_TOKEN')

    expect(mocks.request.mock.calls.every(([url]) => url instanceof URL)).toBe(true)
  })
})
