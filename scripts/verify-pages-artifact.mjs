import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

export const PAGES_BASE_PATH = '/crypto_contract_workstation/'

const SECRET_PATTERN = /ghp_|github_pat_|API_KEY|SECRET_KEY/g
const EXTERNAL_URL_PATTERN = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i
const REQUIRED_ATTRIBUTION_FILES = Object.freeze([
  'THIRD_PARTY_NOTICES.txt',
  'licenses/Apache-2.0.txt',
])
const HTML_NAMED_CHARACTER_REFERENCES = Object.freeze({
  amp: '&',
  apos: "'",
  bsol: '\\',
  colon: ':',
  gt: '>',
  lt: '<',
  num: '#',
  percnt: '%',
  period: '.',
  quest: '?',
  quot: '"',
  sol: '/',
})
const RAW_TEXT_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
])

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

function decodeHtmlCharacterReferences(value) {
  const originalUrl = value
  return value.replace(
    /&#(?:[xX][^\s&;]*|[^\s&;]*);?|&[A-Za-z][A-Za-z\d]*;/g,
    (reference) => {
      if (!reference.startsWith('&#')) {
        const name = reference.slice(1, -1)
        if (
          !Object.prototype.hasOwnProperty.call(
            HTML_NAMED_CHARACTER_REFERENCES,
            name,
          )
        ) {
          throw new Error(
            `Unsupported HTML named character reference "${reference}" in asset URL "${originalUrl}"`,
          )
        }
        return HTML_NAMED_CHARACTER_REFERENCES[name]
      }

      const numericReference =
        /^&#(?:[xX]([\dA-Fa-f]+)|(\d+))(;?)([\s\S]*)$/.exec(reference)
      if (!numericReference) {
        throw new Error(
          `Malformed HTML numeric character reference "${reference}" in asset URL "${originalUrl}"`,
        )
      }
      const [, hexadecimalDigits, decimalDigits, , suffix] = numericReference
      const codePoint = Number.parseInt(
        hexadecimalDigits ?? decimalDigits,
        hexadecimalDigits === undefined ? 10 : 16,
      )
      if (
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        throw new Error(
          `Invalid HTML numeric character reference "${reference}" in asset URL "${originalUrl}": code point is not a valid Unicode scalar value`,
        )
      }
      return `${String.fromCodePoint(codePoint)}${suffix}`
    },
  )
}

function findTagEnd(html, start) {
  let quote = ''
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]
    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  return -1
}

function findRawTextEnd(lowerHtml, tagName, start) {
  const prefix = `</${tagName}`
  let index = lowerHtml.indexOf(prefix, start)
  while (index !== -1) {
    const delimiter = lowerHtml[index + prefix.length]
    if (delimiter === '>' || /\s/.test(delimiter ?? '')) return index
    index = lowerHtml.indexOf(prefix, index + prefix.length)
  }
  return -1
}

function findAssetUrlsInTag(tagSource) {
  const urls = []
  let index = 0
  while (index < tagSource.length && !/[\s/>]/.test(tagSource[index])) index += 1
  while (index < tagSource.length) {
    while (/\s/.test(tagSource[index] ?? '')) index += 1
    if (index >= tagSource.length || tagSource[index] === '/') break
    const nameStart = index
    while (index < tagSource.length && !/[\s=/>]/.test(tagSource[index])) {
      index += 1
    }
    const name = tagSource.slice(nameStart, index).toLowerCase()
    while (/\s/.test(tagSource[index] ?? '')) index += 1
    let value
    if (tagSource[index] === '=') {
      index += 1
      while (/\s/.test(tagSource[index] ?? '')) index += 1
      const quote = tagSource[index]
      if (quote === '"' || quote === "'") {
        index += 1
        const valueStart = index
        while (index < tagSource.length && tagSource[index] !== quote) index += 1
        value = tagSource.slice(valueStart, index)
        if (tagSource[index] === quote) index += 1
      } else {
        const valueStart = index
        while (index < tagSource.length && !/\s/.test(tagSource[index])) index += 1
        value = tagSource.slice(valueStart, index)
      }
    }
    if ((name === 'src' || name === 'href') && value !== undefined) {
      urls.push(value)
    }
  }
  return urls
}

export function findAssetUrls(indexHtml) {
  const urls = []
  const lowerHtml = indexHtml.toLowerCase()
  let index = 0
  while (index < indexHtml.length) {
    const tagStart = indexHtml.indexOf('<', index)
    if (tagStart === -1) break
    if (indexHtml.startsWith('<!--', tagStart)) {
      const commentEnd = indexHtml.indexOf('-->', tagStart + 4)
      index = commentEnd === -1 ? indexHtml.length : commentEnd + 3
      continue
    }
    const marker = indexHtml[tagStart + 1]
    const tagEnd = findTagEnd(indexHtml, tagStart + 1)
    if (tagEnd === -1) break
    if (marker === '/' || marker === '!' || marker === '?') {
      index = tagEnd + 1
      continue
    }
    const tagSource = indexHtml.slice(tagStart + 1, tagEnd)
    const tagName = /^\s*([^\s/>]+)/.exec(tagSource)?.[1]?.toLowerCase()
    if (!tagName) {
      index = tagEnd + 1
      continue
    }
    urls.push(...findAssetUrlsInTag(tagSource))
    index = tagEnd + 1
    if (RAW_TEXT_ELEMENTS.has(tagName)) {
      const rawTextEnd = findRawTextEnd(lowerHtml, tagName, index)
      if (rawTextEnd === -1) break
      const closingTagEnd = findTagEnd(indexHtml, rawTextEnd + 2)
      index = closingTagEnd === -1 ? indexHtml.length : closingTagEnd + 1
    }
  }
  return urls
}

export function findLocalAssetUrls(indexHtml) {
  return findAssetUrls(indexHtml).filter(
    (url) => !EXTERNAL_URL_PATTERN.test(url),
  )
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
  const artifactFiles = new Set(files.map((file) => resolve(file)))
  for (const requiredFile of REQUIRED_ATTRIBUTION_FILES) {
    if (!artifactFiles.has(resolve(artifactDirectory, requiredFile))) {
      problems.push(`Required attribution file "${requiredFile}" is missing`)
    }
  }
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

  const assetUrls = findAssetUrls(indexHtml)
  let localAssetCount = 0
  for (const url of assetUrls) {
    let decodedUrl
    try {
      decodedUrl = decodeHtmlCharacterReferences(url)
    } catch (error) {
      problems.push(error.message)
      continue
    }
    if (EXTERNAL_URL_PATTERN.test(decodedUrl)) continue

    const encodedPath = decodedUrl.split(/[?#]/, 1)[0]
    let decodedPath
    try {
      decodedPath = decodeURIComponent(encodedPath)
    } catch {
      problems.push(`Malformed percent-encoding in local asset URL "${url}"`)
      continue
    }
    if (!['.js', '.css'].includes(extname(decodedPath).toLowerCase())) {
      continue
    }
    localAssetCount += 1
    if (!decodedPath.startsWith(PAGES_BASE_PATH)) {
      problems.push(
        `Asset URL "${url}" must begin with ${PAGES_BASE_PATH}`,
      )
      continue
    }
    if (decodedPath.split(/[\\/]/).includes('..')) {
      problems.push(`Asset URL "${url}" contains path traversal`)
      continue
    }
    const assetPath = resolve(
      artifactDirectory,
      decodedPath.slice(PAGES_BASE_PATH.length),
    )
    const relativeAssetPath = relative(artifactDirectory, assetPath)
    if (
      relativeAssetPath === '..' ||
      relativeAssetPath.startsWith(`..${sep}`) ||
      isAbsolute(relativeAssetPath)
    ) {
      problems.push(`Asset URL "${url}" resolves outside ${artifactDirectory}`)
      continue
    }
    if (!artifactFiles.has(assetPath)) {
      problems.push(`Asset URL "${url}" does not exist inside ${artifactDirectory}`)
    }
  }
  if (localAssetCount === 0) {
    problems.push('No local JavaScript or CSS asset URLs found in index.html')
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
