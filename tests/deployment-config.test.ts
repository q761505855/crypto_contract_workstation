import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('deployment configuration', () => {
  it('builds with the repository Pages base path and no secrets', async () => {
    const workflow = await readFile(
      '.github/workflows/deploy-pages.yml',
      'utf8',
    )
    expect(workflow).toContain('VITE_BASE_PATH: /crypto_contract_workstation/')
    expect(workflow).toContain('actions/configure-pages@v5')
    expect(workflow).toContain('actions/upload-pages-artifact@v4')
    expect(workflow).toContain('actions/deploy-pages@v4')
    expect(workflow).not.toMatch(/TOKEN|API_KEY|SECRET_KEY/)
  })

  it('runs type, unit, build, and browser checks in CI', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8')
    expect(workflow).toContain('npm run check')
    expect(workflow).toContain('npm run test:e2e')
    expect(workflow).toContain('playwright install --with-deps chromium')
  })
})
