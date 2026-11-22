const rawOrigin = 'https://raw.githubusercontent.com'
const mirrorOrigin = 'https://testingcf.jsdelivr.net'
const mirrorLimitBytes = 20_000_000

export class CloudFileHttpError extends Error {
  constructor(readonly status: number) { super(`云端文件下载失败（HTTP ${status}）`) }
}

export function githubRawUrl(owner: string, repository: string, ref: string, encodedPath: string): string {
  return `${rawOrigin}/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${encodeURIComponent(ref)}/${encodedPath}`
}

async function digestHex(algorithm: string, buffer: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest(algorithm, buffer)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export const cloudFileSha256 = (buffer: ArrayBuffer): Promise<string> => digestHex('SHA-256', buffer)

export async function gitBlobSha(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const input = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const header = new TextEncoder().encode(`blob ${input.byteLength}\0`)
  const gitObject = new Uint8Array(header.length + input.byteLength)
  gitObject.set(header)
  gitObject.set(input, header.length)
  return digestHex('SHA-1', gitObject.buffer)
}

interface DownloadOptions {
  integrity?: { bytes: number; validate: (bytes: ArrayBuffer) => Promise<boolean> }
  signal?: AbortSignal
  mirrorTimeout?: number
  rawTimeout?: number
}

/** Read verified public Git bytes from the mirror first. Without a hash, read fresh bytes from GitHub. */
export async function downloadGitFile(raw: string, fetcher: typeof fetch,
  { integrity, signal, mirrorTimeout = 15_000, rawTimeout = 45_000 }: DownloadOptions): Promise<ArrayBuffer> {
  const read = async (url: string, timeout: number) => {
    signal?.throwIfAborted()
    const deadline = AbortSignal.timeout(timeout)
    const response = await fetcher.call(globalThis, url, {
      credentials: 'omit', cache: integrity ? 'default' : 'no-store',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    })
    if (!response.ok) throw new CloudFileHttpError(response.status)
    const buffer = await response.arrayBuffer()
    if (integrity && (buffer.byteLength !== integrity.bytes || !await integrity.validate(buffer))) {
      throw new Error('云端文件内容校验失败')
    }
    signal?.throwIfAborted()
    return buffer
  }
  const source = new URL(raw)
  if (source.origin === rawOrigin && integrity && integrity.bytes < mirrorLimitBytes) {
    const [owner, repository, ref, ...file] = source.pathname.slice(1).split('/')
    const mirror = `${mirrorOrigin}/gh/${owner}/${repository}@${ref}/${file.join('/')}`
    try { return await read(mirror, mirrorTimeout) }
    catch { signal?.throwIfAborted() }
  }
  return read(raw, rawTimeout)
}
