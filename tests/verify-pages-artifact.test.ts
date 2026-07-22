import { execFile as executeFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const execFile = promisify(executeFile)
const verifierPath = join(process.cwd(), 'scripts', 'verify-pages-artifact.mjs')

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

async function createArtifact(indexHtml: string, assetContents = '') {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-artifact-'))
  const directory = join(rootDirectory, 'dist')
  temporaryDirectories.push(rootDirectory)
  await mkdir(join(directory, 'assets'), { recursive: true })
  await writeFile(join(directory, 'index.html'), indexHtml)
  await writeFile(join(directory, 'assets', 'index.js'), assetContents)
  return rootDirectory
}

function runVerifier(rootDirectory: string) {
  return execFile(process.execPath, [verifierPath], { cwd: rootDirectory })
}

describe('verify:pages', () => {
  it('accepts repository-based assets with no secret-like values', async () => {
    const rootDirectory = await createArtifact(
      '<script src="/crypto_contract_workstation/assets/index.js"></script>',
    )

    await expect(runVerifier(rootDirectory)).resolves.toMatchObject({
      stdout: expect.stringContaining('verification passed'),
    })
  })

  it('reports secret-like content and asset URLs outside the repository base', async () => {
    const rootDirectory = await createArtifact(
      '<link href="/assets/index.css" rel="stylesheet">',
      'github_pat_example',
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(/github_pat_|\/assets\/index\.css/),
    })
  })
})
