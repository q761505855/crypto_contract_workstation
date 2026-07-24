import { execFile as executeFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const execFile = promisify(executeFile)
const verifierPath = join(process.cwd(), 'scripts', 'verify-pages-artifact.mjs')
const requiredAttributionFiles = {
  'THIRD_PARTY_NOTICES.txt': 'KLineChart notices',
  'licenses/Apache-2.0.txt': 'Apache License',
  'licenses/decimal.js-MIT.txt': 'MIT License',
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

async function createArtifact(
  indexHtml: string,
  assetContents = '',
  attributionFiles: Record<string, string> = requiredAttributionFiles,
) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-artifact-'))
  const directory = join(rootDirectory, 'dist')
  temporaryDirectories.push(rootDirectory)
  await mkdir(join(directory, 'assets'), { recursive: true })
  await writeFile(join(directory, 'index.html'), indexHtml)
  await writeFile(join(directory, 'assets', 'index.js'), assetContents)
  await Promise.all(
    Object.entries(attributionFiles).map(async ([path, content]) => {
      const filePath = join(directory, path)
      await mkdir(join(filePath, '..'), { recursive: true })
      await writeFile(filePath, content)
    }),
  )
  return rootDirectory
}

function runVerifier(rootDirectory: string) {
  return execFile(process.execPath, [verifierPath], { cwd: rootDirectory })
}

describe('verify:pages', () => {
  it.each([
    [
      'third-party notice',
      {
        'licenses/Apache-2.0.txt': 'Apache License',
        'licenses/decimal.js-MIT.txt': 'MIT License',
      },
      /THIRD_PARTY_NOTICES\.txt/,
    ],
    [
      'Apache license',
      {
        'THIRD_PARTY_NOTICES.txt': 'KLineChart notices',
        'licenses/decimal.js-MIT.txt': 'MIT License',
      },
      /licenses[\\/]Apache-2\.0\.txt/,
    ],
    [
      'decimal.js MIT license',
      {
        'THIRD_PARTY_NOTICES.txt': 'KLineChart notices',
        'licenses/Apache-2.0.txt': 'Apache License',
      },
      /licenses[\\/]decimal\.js-MIT\.txt/,
    ],
  ])('requires the deployed %s', async (_, attributionFiles, diagnostic) => {
    const rootDirectory = await createArtifact(
      '<script src="/crypto_contract_workstation/assets/index.js"></script>',
      '',
      attributionFiles,
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(diagnostic),
    })
  })

  it('accepts repository-based assets with deployed attribution files', async () => {
    const rootDirectory = await createArtifact(
      '<script src="/crypto_contract_workstation/assets/index.js"></script>',
      '',
      requiredAttributionFiles,
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

  it('rejects a correctly prefixed asset URL when the file is missing', async () => {
    const rootDirectory = await createArtifact(
      '<script src="/crypto_contract_workstation/assets/missing.js"></script>',
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /\/crypto_contract_workstation\/assets\/missing\.js.*does not exist/,
      ),
    })
  })

  it('rejects a missing asset URL with a fragment', async () => {
    const rootDirectory = await createArtifact(
      [
        '<script src="/crypto_contract_workstation/assets/index.js"></script>',
        '<script src="/crypto_contract_workstation/assets/missing.js#module"></script>',
      ].join(''),
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /\/crypto_contract_workstation\/assets\/missing\.js#module.*does not exist/,
      ),
    })
  })

  it('rejects a percent-encoded missing JavaScript extension', async () => {
    const rootDirectory = await createArtifact(
      [
        '<script src="/crypto_contract_workstation/assets/index.js"></script>',
        '<script src="/crypto_contract_workstation/assets/missing%2Ejs"></script>',
      ].join(''),
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /\/crypto_contract_workstation\/assets\/missing%2Ejs.*does not exist/,
      ),
    })
  })

  it('rejects decimal character-reference extensions with and without a semicolon', async () => {
    const rootDirectory = await createArtifact(
      [
        '<script src="/crypto_contract_workstation/assets/index.js"></script>',
        '<script src="/crypto_contract_workstation/assets/missing&#46;js"></script>',
        '<script src="/crypto_contract_workstation/assets/also-missing&#46js"></script>',
      ].join(''),
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /missing&#46;js.*does not exist[\s\S]*also-missing&#46js.*does not exist/,
      ),
    })
  })

  it('rejects a hexadecimal character-reference extension', async () => {
    const rootDirectory = await createArtifact(
      [
        '<script src="/crypto_contract_workstation/assets/index.js"></script>',
        '<script src="/crypto_contract_workstation/assets/missing&#x2E;js"></script>',
      ].join(''),
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(/missing&#x2E;js.*does not exist/),
    })
  })

  it('rejects a named character-reference extension', async () => {
    const rootDirectory = await createArtifact(
      [
        '<script src="/crypto_contract_workstation/assets/index.js"></script>',
        '<script src="/crypto_contract_workstation/assets/missing&period;js"></script>',
      ].join(''),
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(/missing&period;js.*does not exist/),
    })
  })

  it('does not recursively decode a numeric ampersand into an external scheme', async () => {
    const rootDirectory = await createArtifact(
      [
        '<script src="/crypto_contract_workstation/assets/index.js"></script>',
        '<script src="https&#38;colon;//cdn.example.test/missing.js"></script>',
      ].join(''),
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /https&#38;colon;\/\/cdn\.example\.test\/missing\.js.*must begin/i,
      ),
    })
  })

  it('does not recursively decode a numeric ampersand into a file extension', async () => {
    const rootDirectory = await createArtifact(
      [
        '<script src="/crypto_contract_workstation/assets/index.js"></script>',
        '<script src="/crypto_contract_workstation/assets/missing&#38;period;js"></script>',
      ].join(''),
    )

    await expect(runVerifier(rootDirectory)).resolves.toMatchObject({
      stdout: expect.stringContaining('verification passed'),
    })
  })

  it('rejects character-reference traversal even when it resolves to an existing asset', async () => {
    const rootDirectory = await createArtifact(
      '<script src="/crypto_contract_workstation/assets/&period;&period;&sol;assets/index.js"></script>',
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(/&period;&period;&sol;.*path traversal/i),
    })
  })

  it('accepts an existing asset with character-reference query delimiters', async () => {
    const rootDirectory = await createArtifact(
      '<script src="/crypto_contract_workstation/assets/index.js&quest;v=1&amp;x=2&num;module"></script>',
    )

    await expect(runVerifier(rootDirectory)).resolves.toMatchObject({
      stdout: expect.stringContaining('verification passed'),
    })
  })

  it('reports an out-of-range numeric character reference with the offending URL', async () => {
    const rootDirectory = await createArtifact(
      '<script src="/crypto_contract_workstation/assets/index&#x110000;js"></script>',
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /Invalid HTML numeric character reference.*index&#x110000;js/i,
      ),
    })
  })

  it('reports a malformed numeric character reference with the offending URL', async () => {
    const rootDirectory = await createArtifact(
      '<script src="/crypto_contract_workstation/assets/index&#xZZ;js"></script>',
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /Malformed HTML numeric character reference.*index&#xZZ;js/i,
      ),
    })
  })

  it('fails closed on an unsupported named character reference', async () => {
    const rootDirectory = await createArtifact(
      '<script src="/crypto_contract_workstation/assets/index&copy;js"></script>',
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /Unsupported HTML named character reference.*index&copy;js/i,
      ),
    })
  })

  it('accepts an existing asset with a query and fragment', async () => {
    const rootDirectory = await createArtifact(
      [
        '<script src="/crypto_contract_workstation/assets/index.js?v=1#module"></script>',
        '<script src="https://cdn.example.test/missing.js"></script>',
        '<script src="//cdn.example.test/missing.js"></script>',
        '<script src="data:text/javascript,console.log(1)"></script>',
      ].join(''),
    )

    await expect(runVerifier(rootDirectory)).resolves.toMatchObject({
      stdout: expect.stringContaining('verification passed'),
    })
  })

  it('rejects raw traversal even when it resolves to an existing asset', async () => {
    const rootDirectory = await createArtifact(
      '<script src="/crypto_contract_workstation/assets/../assets/index.js"></script>',
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(/assets\/\.\.\/assets.*path traversal/i),
    })
  })

  it('rejects percent-encoded traversal even when it resolves to an existing asset', async () => {
    const rootDirectory = await createArtifact(
      '<script src="/crypto_contract_workstation/assets/%2E%2E/assets/index.js"></script>',
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(/%2E%2E.*path traversal/i),
    })
  })

  it('reports malformed percent encoding with the offending URL', async () => {
    const rootDirectory = await createArtifact(
      '<script src="/crypto_contract_workstation/assets/index%ZZ.js"></script>',
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /Malformed percent-encoding.*\/crypto_contract_workstation\/assets\/index%ZZ\.js/i,
      ),
    })
  })

  it('rejects an artifact with local attributes but no JavaScript or CSS', async () => {
    const rootDirectory = await createArtifact(
      '<img src="/crypto_contract_workstation/assets/image.png">',
    )

    await expect(runVerifier(rootDirectory)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'No local JavaScript or CSS asset URLs found in index.html',
      ),
    })
  })

  it('ignores similarly named data attributes', async () => {
    const rootDirectory = await createArtifact(
      [
        '<script src="/crypto_contract_workstation/assets/index.js"></script>',
        '<div data-src="/crypto_contract_workstation/assets/missing.js"></div>',
      ].join(''),
    )

    await expect(runVerifier(rootDirectory)).resolves.toMatchObject({
      stdout: expect.stringContaining('verification passed'),
    })
  })

  it('collects src and href only from actual HTML attributes', async () => {
    const rootDirectory = await createArtifact(
      [
        '<!-- src="/outside/comment.js" -->',
        '<script src="/crypto_contract_workstation/assets/index.js"></script>',
        '<script>const fake = \'<link href="/outside/inline.css">\'</script>',
        '<div title=\'src="/outside/title.js"\'></div>',
        '<div @src="/outside/at.js" foo.src="/outside/dot.js"></div>',
      ].join(''),
    )

    await expect(runVerifier(rootDirectory)).resolves.toMatchObject({
      stdout: expect.stringContaining('verification passed'),
    })
  })
})
