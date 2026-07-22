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

  it('keeps CI triggers, permissions, current actions, and checks in the verify job', async () => {
    const workflow = normalizeWorkflow(
      await readFile('.github/workflows/ci.yml', 'utf8'),
    )
    const triggers = capture(workflow, /^on:\n([\s\S]*?)^permissions:/m)
    const permissions = capture(workflow, /^permissions:\n([\s\S]*?)^jobs:/m)
    const verifyJob = capture(workflow, /^  verify:\n([\s\S]*)$/m)

    expect(triggers).toMatch(/^  pull_request:$/m)
    expect(triggers).toMatch(/^  push:\n    branches:\n      - main$/m)
    expect(permissions).toMatch(/^  contents: read$/m)
    expect(verifyJob).toMatch(/^    runs-on: ubuntu-latest$/m)
    expect(verifyJob).toMatch(/^        uses: actions\/checkout@v6$/m)
    expect(verifyJob).toMatch(/^        uses: actions\/setup-node@v6$/m)
    expectLinesInOrder(verifyJob, [
      '        run: npm ci',
      '        run: npm run check',
      '        run: npx playwright install --with-deps chromium',
      '        run: npm run test:e2e',
    ])
    expectNoSecrets(workflow)
  })

  it('keeps the Pages build and deploy contract structurally valid', async () => {
    const workflow = normalizeWorkflow(
      await readFile('.github/workflows/deploy-pages.yml', 'utf8'),
    )
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>
    }
    const triggers = capture(workflow, /^on:\n([\s\S]*?)^permissions:/m)
    const permissions = capture(workflow, /^permissions:\n([\s\S]*?)^concurrency:/m)
    const buildJob = capture(workflow, /^  build:\n([\s\S]*?)^  deploy:/m)
    const deployJob = capture(workflow, /^  deploy:\n([\s\S]*)$/m)
    const buildStep = captureStep(buildJob, 'Build Pages artifact')
    const verifyStep = captureStep(buildJob, 'Verify Pages artifact')
    const installBrowserStep = captureStep(
      buildJob,
      'Install Playwright Chromium',
    )
    const browserTestStep = captureStep(buildJob, 'Pages browser smoke test')
    const uploadStep = captureStep(buildJob, 'Upload Pages artifact')
    const deployStep = captureStep(deployJob, 'Deploy')

    expect(triggers).toMatch(/^  workflow_dispatch:$/m)
    expect(triggers).toMatch(/^  push:\n    branches:\n      - main$/m)
    expect(permissions).toMatch(/^  contents: read$/m)
    expect(permissions).toMatch(/^  pages: write$/m)
    expect(permissions).toMatch(/^  id-token: write$/m)
    expect(buildJob).toMatch(/^        uses: actions\/checkout@v6$/m)
    expect(buildJob).toMatch(/^        uses: actions\/setup-node@v6$/m)
    expect(buildJob).toMatch(/^        uses: actions\/configure-pages@v5$/m)
    expect(buildStep).toBe(
      [
        '      - name: Build Pages artifact',
        '        run: npm run build',
        '        env:',
        '          VITE_BASE_PATH: /crypto_contract_workstation/',
      ].join('\n'),
    )
    expect(buildJob.slice(buildJob.indexOf(buildStep) + buildStep.length)).toMatch(
      /^\n      - name: Verify Pages artifact\n        run: npm run verify:pages\n      - name: Install Playwright Chromium\n        run: npx playwright install --with-deps chromium\n      - name: Pages browser smoke test\n        run: npm run test:e2e:pages\n      - name: Upload Pages artifact/m,
    )
    expect(verifyStep).toBe(
      ['      - name: Verify Pages artifact', '        run: npm run verify:pages'].join(
        '\n',
      ),
    )
    expect(installBrowserStep).toBe(
      [
        '      - name: Install Playwright Chromium',
        '        run: npx playwright install --with-deps chromium',
      ].join('\n'),
    )
    expect(browserTestStep).toBe(
      [
        '      - name: Pages browser smoke test',
        '        run: npm run test:e2e:pages',
      ].join('\n'),
    )
    expect(uploadStep).toBe(
      [
        '      - name: Upload Pages artifact',
        '        uses: actions/upload-pages-artifact@v4',
        '        with:',
        '          path: ./dist',
      ].join('\n'),
    )
    expectLinesInOrder(buildJob, [
      '        run: npm ci',
      '        run: npm run check',
      '        uses: actions/configure-pages@v5',
      '        run: npm run build',
      '        run: npm run verify:pages',
      '        run: npx playwright install --with-deps chromium',
      '        run: npm run test:e2e:pages',
      '        uses: actions/upload-pages-artifact@v4',
    ])
    expect(deployJob).toMatch(
      /^    environment:\n      name: github-pages\n      url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}$/m,
    )
    expect(deployJob).toMatch(/^    needs: build$/m)
    expect(deployStep).toBe(
      [
        '      - name: Deploy',
        '        id: deployment',
        '        uses: actions/deploy-pages@v4',
      ].join('\n'),
    )
    expect(packageJson.scripts['verify:pages']).toBe(
      'node scripts/verify-pages-artifact.mjs',
    )
    expect(packageJson.scripts['test:e2e:pages']).toBe(
      'playwright test --config=playwright.pages.config.ts',
    )
    expectNoSecrets(workflow)
  })
})
