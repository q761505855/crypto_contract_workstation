import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'node:path'

export const PAGES_BASE_PATH = '/crypto_contract_workstation/'

const SECRET_PATTERN = /ghp_|github_pat_|API_KEY|SECRET_KEY/g
const ASSET_URL_PATTERN = /\b(?:src|href)\s*=\s*["']([^"']+\.(?:js|css)(?:[?#][^"']*)?)["']/gi

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name)
      return entry.isDirectory() ? listFiles(entryPath) : [entryPath]
    }),
  )
  return files.flat()
}

export function findSecretLikeValues(content) {
  return [...content.matchAll(SECRET_PATTERN)].map((match) => match[0])
}

export function findLocalAssetUrls(indexHtml) {
  return [...indexHtml.matchAll(ASSET_URL_PATTERN)]
    .map((match) => match[1])
    .filter((url) => !/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(url))
}

export async function verifyPagesArtifact(distDirectory = 'dist') {
  const artifactDirectory = resolve(distDirectory)
  let files

  try {
    files = await listFiles(artifactDirectory)
  } catch (error) {
    throw new Error(
      `Unable to scan Pages artifact at ${artifactDirectory}: ${error.message}`,
    )
  }

  const problems = []
  for (const file of files) {
    const content = await readFile(file, 'utf8')
    for (const value of findSecretLikeValues(content)) {
      problems.push(
        `Secret-like value "${value}" found in ${relative(artifactDirectory, file)}`,
      )
    }
  }

  const indexPath = resolve(artifactDirectory, 'index.html')
  let indexHtml
  try {
    indexHtml = await readFile(indexPath, 'utf8')
  } catch (error) {
    throw new Error(`Unable to read Pages entry file ${indexPath}: ${error.message}`)
  }

  const assetUrls = findLocalAssetUrls(indexHtml)
  const artifactFiles = new Set(files.map((file) => resolve(file)))
  if (assetUrls.length === 0) {
    problems.push('No local JavaScript or CSS asset URLs found in index.html')
  }
  for (const url of assetUrls) {
    if (!url.startsWith(PAGES_BASE_PATH)) {
      problems.push(
        `Asset URL "${url}" must begin with ${PAGES_BASE_PATH}`,
      )
      continue
    }
    const urlPath = url.split(/[?#]/, 1)[0]
    const assetPath = resolve(
      artifactDirectory,
      decodeURIComponent(urlPath.slice(PAGES_BASE_PATH.length)),
    )
    if (!artifactFiles.has(assetPath)) {
      problems.push(`Asset URL "${url}" does not exist inside ${artifactDirectory}`)
    }
  }

  if (problems.length > 0) {
    throw new Error(`GitHub Pages artifact verification failed:\n- ${problems.join('\n- ')}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyPagesArtifact().then(
    () => {
      console.log('GitHub Pages artifact verification passed.')
    },
    (error) => {
      console.error(error.message)
      process.exitCode = 1
    },
  )
}
