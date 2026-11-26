import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function normalizeWorkflow(source: string): string {
  return source.replace(/\r\n?/g, '\n')
}

function capture(source: string, pattern: RegExp): string {
  const match = source.match(pattern)
  expect(match).not.toBeNull()
  return match?.[1] ?? ''
}

function captureStep(source: string, name: string): string {
  const header = `      - name: ${name}\n`
  const start = source.indexOf(header)
  expect(start).toBeGreaterThanOrEqual(0)
  const nextStep = source.indexOf('\n      - name:', start + header.length)
  return source.slice(start, nextStep === -1 ? source.length : nextStep).trimEnd()
}

function expectLinesInOrder(source: string, lines: string[]) {
  let previousIndex = -1
  for (const line of lines) {
    const expression = new RegExp(
      `^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      'm',
    )
    const match = expression.exec(source.slice(previousIndex + 1))
    const index = match ? previousIndex + 1 + match.index : -1
    expect(index).toBeGreaterThan(previousIndex)
    previousIndex = index
  }
}

function expectNoSecrets(source: string) {
  expect(source).not.toMatch(
    /TOKEN|API_KEY|SECRET_KEY|ghp_|github_pat_|\$\{\{\s*secrets\./,
  )
}

describe('deployment configuration', () => {
  it('normalizes CRLF workflow text before structural parsing', () => {
    const workflow = [
      'on:',
      '  workflow_dispatch:',
      'permissions:',
      '  contents: read',
    ].join('\r\n')

    const normalized = normalizeWorkflow(workflow)

    expect(capture(normalized, /^on:\n([\s\S]*?)^permissions:/m)).toBe(
      '  workflow_dispatch:\n',
    )
  })

  it('pauses automatic CI and retains the full suite behind explicit manual opt-in', async () => {
    const workflow = normalizeWorkflow(
      await readFile('.github/workflows/ci.yml', 'utf8'),
    )
    const triggers = capture(workflow, /^on:\n([\s\S]*?)^permissions:/m)
    const permissions = capture(workflow, /^permissions:\n([\s\S]*?)^concurrency:/m)
    const concurrency = capture(workflow, /^concurrency:\n([\s\S]*?)^jobs:/m)
    const verifyJob = capture(workflow, /^  verify:\n([\s\S]*?)^  browser:/m)
    const browserJob = capture(workflow, /^  browser:\n([\s\S]*)$/m)

    expect(triggers).not.toMatch(/^  (?:push|pull_request):$/m)
    expect(triggers).toMatch(/^  workflow_dispatch:$/m)
    expect(triggers).toMatch(/^      run_tests:\n        description: .+\n        type: boolean\n        required: false\n        default: false$/m)
    expect(verifyJob).toContain('if: ${{ inputs.run_tests }}')
    expect(permissions).toMatch(/^  contents: read$/m)
    expect(concurrency).toContain('cancel-in-progress: true')
    expect(concurrency).toContain('group: ci-${{ github.event.pull_request.number || github.ref }}')
    expect(verifyJob).toMatch(/^    runs-on: ubuntu-24\.04$/m)
    expect(verifyJob).toMatch(/^        uses: actions\/checkout@v6$/m)
    expect(verifyJob).toMatch(/^        uses: actions\/setup-node@v6$/m)
    expectLinesInOrder(verifyJob, [
      '        run: npm ci',
      '        run: npm run check',
    ])
    expect(browserJob).toMatch(/^    needs: verify$/m)
    expect(browserJob).toMatch(/^    runs-on: ubuntu-24\.04$/m)
    expectLinesInOrder(browserJob, [
      '        run: npm ci',
      '        run: node scripts/install-playwright.mjs',
      '        run: npm run test:e2e',
      '        run: npm run test:e2e:pages',
    ])
    expectNoSecrets(workflow)
  })

  it('publishes the uploaded production build on each main push without running the test suite', async () => {
    const workflow = normalizeWorkflow(await readFile('.github/workflows/deploy-pages.yml', 'utf8'))
    const triggers = capture(workflow, /^on:\n([\s\S]*?)^permissions:/m)
    const permissions = capture(workflow, /^permissions:\n([\s\S]*?)^concurrency:/m)
    const buildJob = capture(workflow, /^  build:\n([\s\S]*?)^  deploy:/m)
    const deployJob = capture(workflow, /^  deploy:\n([\s\S]*)$/m)
    expect(triggers).toMatch(/^  workflow_dispatch:$/m)
    expect(triggers).toMatch(/^  push:\n    branches:\n      - main$/m)
    for (const permission of ['actions: read', 'contents: read', 'pages: write', 'id-token: write']) expect(permissions).toContain(permission)
    expect(workflow).toContain('cancel-in-progress: true')
    expect(buildJob).toContain('runs-on: ubuntu-24.04')
    expect(deployJob).toContain('runs-on: ubuntu-24.04')
    expect(deployJob).toMatch(/^    needs: build$/m)
    expect(deployJob).toMatch(/^    environment:\n      name: github-pages\n      url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}$/m)
    expectLinesInOrder(buildJob, [
      '        uses: actions/checkout@v6',
      '        uses: actions/setup-node@v6',
      '        run: npm ci',
      '        uses: actions/configure-pages@v5',
      '        run: npx vite build',
      '        uses: actions/upload-pages-artifact@v4',
    ])
    expectLinesInOrder(deployJob, [
      '      - name: Wait for Pages artifact',
      '        uses: actions/deploy-pages@v4',
    ])
    const buildStep = captureStep(buildJob, 'Build Pages artifact')
    expect(buildStep).toContain('VITE_BASE_PATH: /crypto_contract_workstation/')
    expect(buildStep).toContain('CLOUD_STORAGE_TOKEN: ${{ secrets.CLOUD_STORAGE_TOKEN }}')
    expect(buildStep).toContain("REQUIRE_CTRADER_CONNECTION: '1'")
    const upload = captureStep(buildJob, 'Upload Pages artifact')
    expect(upload).toContain('id: upload')
    expect(upload).toContain('path: ./dist')
    expect(upload).toContain('name: ${{ env.PAGES_ARTIFACT }}')
    expect(buildJob).toContain('artifact-name: ${{ env.PAGES_ARTIFACT }}')
    expect(buildJob).toContain('artifact-id: ${{ steps.upload.outputs.artifact_id }}')
    const artifactWait = captureStep(deployJob, 'Wait for Pages artifact')
    expect(artifactWait).toContain('PAGES_ARTIFACT_NAME: ${{ needs.build.outputs.artifact-name }}')
    expect(artifactWait).toContain('PAGES_ARTIFACT_ID: ${{ needs.build.outputs.artifact-id }}')
    const deploy = captureStep(deployJob, 'Deploy')
    expect(deploy).toContain('id: deployment')
    expect(deploy).toContain('artifact_name: ${{ needs.build.outputs.artifact-name }}')
    expect(workflow.match(/^        run: npx vite build$/gm)).toHaveLength(1)
    expect(workflow).not.toMatch(/^        run: .*?(?:npm run (?:check|test|typecheck|verify)|playwright|tsc)/m)
    expect(workflow).not.toContain('e2e-mock-storage-token')
    expectNoSecrets(workflow.replace('          CLOUD_STORAGE_TOKEN: ${{ secrets.CLOUD_STORAGE_TOKEN }}\n', ''))
  })

  it('retries internal artifact lookup and only accepts the exact uploaded artifact', async () => {
    const workflow = normalizeWorkflow(await readFile('.github/workflows/deploy-pages.yml', 'utf8'))
    const waitStep = captureStep(workflow, 'Wait for Pages artifact')
    const script = capture(waitStep, /^          script: \|\n([\s\S]+)$/m)
    const target = { name: 'github-pages-2', id: 42 }
    const older = { name: target.name, id: 41 }
    const runnerTemp = 'runner-temp'
    const listArtifacts = vi.fn().mockResolvedValue({ artifacts: [] })
    const delay = vi.fn().mockResolvedValue(undefined)
    const runWait = () => runInNewContext(`(async () => {${script}\n})()`, {
      require(name: string) {
        if (name === 'node:path') return { join }
        if (name === 'node:timers/promises') return { setTimeout: delay }
        expect(name).toBe(join(runnerTemp, 'pages-artifact-client', 'node_modules', '@actions', 'artifact'))
        return { DefaultArtifactClient: class { listArtifacts = listArtifacts } }
      },
      core: { info: vi.fn(), warning: vi.fn() },
      process: { env: { RUNNER_TEMP: runnerTemp, PAGES_ARTIFACT_NAME: target.name, PAGES_ARTIFACT_ID: '42' } },
    }) as Promise<void>

    listArtifacts.mockRejectedValueOnce(new Error('temporary service error'))
      .mockResolvedValueOnce({ artifacts: [] })
      .mockResolvedValueOnce({ artifacts: [older] })
      .mockResolvedValueOnce({ artifacts: [older, target] })
      .mockResolvedValueOnce({ artifacts: [target] })
    await expect(runWait()).resolves.toBeUndefined()
    expect(listArtifacts.mock.calls).toEqual([[], [], [], [], []])
    expect(delay).toHaveBeenCalledTimes(4)

    listArtifacts.mockClear()
    delay.mockClear()
    await expect(runWait()).rejects.toThrow(/is not visible as a unique match/)
    expect(listArtifacts).toHaveBeenCalledTimes(12)
    expect(delay).toHaveBeenCalledTimes(11)
  })
})
