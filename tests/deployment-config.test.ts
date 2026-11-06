import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

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
    for (const project of ['chromium', 'chromium-integration', 'chromium-monthly-replay', 'chromium-production']) {
      expect(browserJob).toContain(`          - ${project}\n`)
    }
    expectLinesInOrder(browserJob, [
      '        run: npm ci',
      '        run: node scripts/install-playwright.mjs',
      '        run: npm run test:e2e -- --project=${{ matrix.project }}',
    ])
    expectNoSecrets(workflow)
  })

  it('publishes each main push with one production build and no verification gates', async () => {
    const workflow = normalizeWorkflow(await readFile('.github/workflows/deploy-pages.yml', 'utf8'))
    const triggers = capture(workflow, /^on:\n([\s\S]*?)^permissions:/m)
    const permissions = capture(workflow, /^permissions:\n([\s\S]*?)^concurrency:/m)
    const deployJob = capture(workflow, /^  deploy:\n([\s\S]*)$/m)
    expect(triggers).toMatch(/^  workflow_dispatch:$/m)
    expect(triggers).toMatch(/^  push:\n    branches:\n      - main$/m)
    for (const permission of ['contents: read', 'pages: write', 'id-token: write']) expect(permissions).toContain(permission)
    expect(workflow.match(/^  [a-z]+:\n    (?:runs-on|environment):/gm)).toHaveLength(1)
    expect(workflow).toContain('cancel-in-progress: true')
    expect(deployJob).toContain('runs-on: ubuntu-24.04')
    expect(deployJob).toMatch(/^    environment:\n      name: github-pages\n      url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}$/m)
    expectLinesInOrder(deployJob, [
      '        uses: actions/checkout@v6',
      '        uses: actions/setup-node@v6',
      '        run: npm ci',
      '        uses: actions/configure-pages@v5',
      '        run: npx vite build',
      '        uses: actions/upload-pages-artifact@v4',
      '        uses: actions/deploy-pages@v4',
    ])
    expect(captureStep(deployJob, 'Build Pages artifact')).toContain('VITE_BASE_PATH: /crypto_contract_workstation/')
    expect(captureStep(deployJob, 'Build Pages artifact')).toContain('VITE_GITHUB_TOKEN: ${{ secrets.CLOUD_STORAGE_TOKEN }}')
    expect(captureStep(deployJob, 'Upload Pages artifact')).toContain('path: ./dist')
    expect(captureStep(deployJob, 'Deploy')).toContain('id: deployment')
    expect(workflow.match(/^        run: npx vite build$/gm)).toHaveLength(1)
    expect(workflow).not.toMatch(/^        run: .*?(?:npm run (?:check|test|typecheck|verify)|playwright|tsc)/m)
    expect(workflow).not.toContain('e2e-mock-storage-token')
    expect(workflow).not.toContain('needs:')
    expectNoSecrets(workflow.replace('          VITE_GITHUB_TOKEN: ${{ secrets.CLOUD_STORAGE_TOKEN }}\n', ''))
  })
})
