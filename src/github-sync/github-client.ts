import { CloudFileHttpError, cloudFileSha256, downloadGitFile, gitBlobSha, githubRawUrl } from './cloud-file-download'

const GITHUB_API_BASE = 'https://api.github.com'
const GITHUB_API_VERSION = '2026-03-10'
const gitSha = /^[a-f0-9]{40}$/i

type FetchLike = typeof fetch

export interface GitHubRepositoryTarget {
  owner: string
  repository: string
  branch: string
  root?: string
}

export interface GitHubSnapshot { commitSha: string; treeSha: string }
export interface GitHubReadOptions { ref?: string; signal?: AbortSignal }

export interface GitHubRepositoryInfo {
  fullName: string
  private: boolean
  defaultBranch: string
  canPush: boolean
}

export interface GitHubFile {
  path: string
  sha: string
  bytes: Uint8Array
}

interface PublicFileRead { ref: string; file?: GitHubFile | null; expected?: { sha: string; size: number } }
interface PublicTreeEntry { path: string; type?: string; mode?: string; sha?: string; size?: number }
interface PublicTree { entries: Map<string, PublicTreeEntry>; complete: boolean }

export class GitHubConflictError extends Error {
  constructor(
    readonly path: string,
    message = '远端文件已变化，已停止覆盖',
  ) {
    super(message)
    this.name = 'GitHubConflictError'
  }
}

function validateSegment(value: string, field: string): string {
  const trimmed = value.trim()
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error(`${field} 格式无效`)
  }
  return trimmed
}

function encodePath(path: string): string {
  const segments = path.split('/')
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === '.' || segment === '..' || /[\\%\x00-\x1f]/.test(segment),
    )
  ) {
    throw new Error('GitHub 文件路径无效')
  }
  return segments.map(encodeURIComponent).join('/')
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function responseError(status: number, context: 'repository' | 'file'): Error {
  if (status === 401) {
    return new Error('GitHub Token 无效或已过期')
  }
  if (status === 403) {
    return new Error('GitHub Token 权限不足，或已达到 API 频率限制')
  }
  if (status === 404) {
    return new Error(
      context === 'repository'
        ? 'GitHub 仓库不存在，或 Token 无权访问该仓库'
        : 'GitHub 远端文件不存在',
    )
  }
  return new Error(`GitHub API 请求失败（HTTP ${status}）`)
}

export class GitHubContentsClient {
  private readonly target: GitHubRepositoryTarget
  readonly #token: string
  private readonly publicTrees = new Map<string, Promise<PublicTree>>()
  private pendingReadHead?: Promise<string>

  constructor(
    target: GitHubRepositoryTarget,
    token: string = '',
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.#token = token
    this.target = {
      owner: validateSegment(target.owner, 'GitHub 用户或组织'),
      repository: validateSegment(target.repository, 'GitHub 仓库名'),
      branch: validateSegment(target.branch || 'main', 'GitHub 分支'),
      ...(target.root ? { root: target.root } : {}),
    }
    if (this.target.root) encodePath(this.target.root)
  }

  getTarget(): GitHubRepositoryTarget {
    return { ...this.target }
  }

  canWrite(): boolean { return this.#token.trim().length > 0 }

  async dispatchRepositoryEvent(owner: string, repository: string, eventType: string, signal?: AbortSignal): Promise<void> {
    this.requireToken()
    const repo = `${validateSegment(owner, 'GitHub 用户或组织')}/${validateSegment(repository, 'GitHub 仓库名')}`
    await this.request(`/repos/${repo}/dispatches`, { method: 'POST', body: JSON.stringify({ event_type: eventType }), signal }, 'repository')
  }

  async testConnection(): Promise<GitHubRepositoryInfo> {
    const payload = await this.request(
      `/repos/${encodeURIComponent(this.target.owner)}/${encodeURIComponent(
        this.target.repository,
      )}`,
      { method: 'GET' },
      'repository',
    )
    const item = payload as {
      full_name?: unknown
      private?: unknown
      default_branch?: unknown
      permissions?: { push?: unknown }
    }
    if (
      typeof item.full_name !== 'string' ||
      typeof item.private !== 'boolean' ||
      typeof item.default_branch !== 'string'
    ) {
      throw new Error('GitHub 仓库响应格式无效')
    }
    return {
      fullName: item.full_name,
      private: item.private,
      defaultBranch: item.default_branch,
      canPush: item.permissions?.push === true,
    }
  }

  async getFile(path: string, options: GitHubReadOptions = {}): Promise<GitHubFile | null> {
    const publicRead = await this.readPublicFile(path, options)
    if (publicRead?.file !== undefined) return publicRead.file
    const encodedPath = this.scopedPath(path)
    const ref = publicRead?.ref ?? options.ref ?? this.target.branch
    let response: Response
    try {
      response = await this.fetcher.call(
        globalThis,
        `${GITHUB_API_BASE}/repos/${encodeURIComponent(
          this.target.owner,
        )}/${encodeURIComponent(
          this.target.repository,
        )}/contents/${encodedPath}?ref=${encodeURIComponent(
          ref,
        )}`,
        {
          method: 'GET',
          cache: 'no-store',
          headers: this.headers(),
          signal: options.signal,
        },
      )
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new Error('无法连接 GitHub API，请检查网络')
    }
    if (response.status === 404 && !publicRead?.expected) return null
    if (!response.ok) {
      throw responseError(response.status, 'file')
    }
    const payload = (await response.json()) as {
      type?: unknown
      path?: unknown
      sha?: unknown
      encoding?: unknown
      content?: unknown
      size?: unknown
    }
    if (
      payload.type !== 'file' ||
      typeof payload.path !== 'string' ||
      typeof payload.sha !== 'string' ||
      (payload.encoding !== 'none' && payload.encoding !== 'base64')
    ) {
      throw new Error(`GitHub 文件 ${path} 响应格式无效`)
    }
    let bytes: Uint8Array
    if (payload.encoding === 'none' || (typeof payload.size === 'number' && payload.size > 1_048_576)) {
      const raw = await this.fetcher.call(globalThis,
        `${GITHUB_API_BASE}${this.repoPath()}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
        { method: 'GET', cache: 'no-store', headers: { ...this.headers(), Accept: 'application/vnd.github.raw+json' }, signal: options.signal })
      if (!raw.ok) throw responseError(raw.status, 'file')
      bytes = new Uint8Array(await raw.arrayBuffer())
    } else {
      if (typeof payload.content !== 'string') throw new Error(`GitHub 文件 ${path} 响应格式无效`)
      bytes = base64ToBytes(payload.content)
    }
    const expected = publicRead?.expected
    if (expected && (payload.sha !== expected.sha || bytes.byteLength !== expected.size || await gitBlobSha(bytes) !== expected.sha)) {
      throw new Error(`GitHub 文件 ${path} 内容校验失败`)
    }
    options.signal?.throwIfAborted()
    return {
      path,
      sha: payload.sha,
      bytes,
    }
  }

  async getPublicFile(path: string, options: GitHubReadOptions = {}): Promise<{ ref: string; bytes: Uint8Array } | null> {
    const read = await this.readPublicFile(path, options)
    if (read?.file === null) return null
    if (read?.file) return { ref: read.ref, bytes: read.file.bytes }
    if (read?.expected) throw new Error(`GitHub 文件 ${path} 下载或校验失败`)
    const ref = read?.ref ?? options.ref ?? this.target.branch
    try {
      const bytes = await downloadGitFile(this.rawUrl(path, ref), this.fetcher, { signal: options.signal })
      return { ref, bytes: new Uint8Array(bytes) }
    } catch (error) {
      if (error instanceof CloudFileHttpError && error.status === 404) return null
      throw error
    }
  }

  getPublicVerifiedFile(path: string, ref: string, { bytes, sha256 }: { bytes: number; sha256: string }): Promise<ArrayBuffer> {
    return downloadGitFile(this.rawUrl(path, ref), this.fetcher, {
      integrity: { bytes, validate: async buffer => await cloudFileSha256(buffer) === sha256 },
    })
  }

  private rawUrl(path: string, ref: string): string {
    return githubRawUrl(this.target.owner, this.target.repository, ref, this.scopedPath(path))
  }

  /** The anonymous tree identifies public files and pins their Git blob hashes. */
  private async readPublicFile(path: string, options: GitHubReadOptions): Promise<PublicFileRead | undefined> {
    this.scopedPath(path)
    const scoped = this.target.root ? `${this.target.root}/${path}` : path
    const { signal } = options
    let ref: string | undefined
    let expected: PublicFileRead['expected']
    try {
      signal?.throwIfAborted()
      const commit = options.ref ?? await this.currentReadHead()
      if (!gitSha.test(commit)) return
      ref = commit
      const tree = await this.publicTree(commit)
      signal?.throwIfAborted()
      const entry = tree.entries.get(scoped)
      if (!entry) return tree.complete ? { ref, file: null } : { ref }
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755') ||
          typeof entry.sha !== 'string' || !gitSha.test(entry.sha) || typeof entry.size !== 'number' ||
          !Number.isSafeInteger(entry.size) || entry.size < 0) return { ref }
      const { sha, size } = entry
      expected = { sha, size }
      const bytes = await downloadGitFile(this.rawUrl(path, commit), this.fetcher, {
        integrity: { bytes: size, validate: async buffer => await gitBlobSha(buffer) === sha },
        signal, mirrorTimeout: size < 1_048_576 ? 4_000 : 15_000,
      })
      return { ref, file: { path, sha, bytes: new Uint8Array(bytes) } }
    } catch {
      signal?.throwIfAborted()
      return ref ? { ref, expected } : undefined
    }
  }

  private currentReadHead(): Promise<string> {
    if (!this.pendingReadHead) {
      this.pendingReadHead = this.branchHead(AbortSignal.timeout(5_000)).finally(() => { this.pendingReadHead = undefined })
    }
    return this.pendingReadHead
  }

  private publicTree(ref: string): Promise<PublicTree> {
    const cached = this.publicTrees.get(ref)
    if (cached) return cached
    const pending = (async () => {
      const response = await this.fetcher.call(globalThis, `${GITHUB_API_BASE}${this.repoPath()}/git/trees/${ref}?recursive=1`, {
        credentials: 'omit', signal: AbortSignal.timeout(6_000),
      })
      if (!response.ok) throw responseError(response.status, 'repository')
      const payload: { tree?: PublicTreeEntry[]; truncated?: boolean } = await response.json()
      if (!Array.isArray(payload.tree)) throw new Error('GitHub 文件索引无效')
      const entries = new Map<string, PublicTreeEntry>()
      const prefix = this.target.root ? `${this.target.root}/` : ''
      for (const entry of payload.tree) {
        if (typeof entry?.path === 'string' && entry.path.startsWith(prefix)) entries.set(entry.path, entry)
      }
      return { entries, complete: payload.truncated === false }
    })()
    this.publicTrees.set(ref, pending)
    if (this.publicTrees.size > 4) this.publicTrees.delete(this.publicTrees.keys().next().value!)
    void pending.catch(() => { if (this.publicTrees.get(ref) === pending) this.publicTrees.delete(ref) })
    return pending
  }

  async putFile(
    path: string,
    bytes: Uint8Array,
    message: string,
    expectedSha?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const encodedPath = this.scopedPath(path)
    this.requireToken()
    const body: Record<string, unknown> = {
      message,
      content: bytesToBase64(bytes),
      branch: this.target.branch,
    }
    if (expectedSha !== undefined) {
      body.sha = expectedSha
    }
    let response: Response
    try {
      response = await this.fetcher.call(
        globalThis,
        `${GITHUB_API_BASE}/repos/${encodeURIComponent(
          this.target.owner,
        )}/${encodeURIComponent(
          this.target.repository,
        )}/contents/${encodedPath}`,
        {
          method: 'PUT',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal,
        },
      )
    } catch (error) {
      if (signal?.aborted) throw error
      throw new Error('无法连接 GitHub API，请检查网络')
    }
    if (response.status === 409 || response.status === 422) {
      throw new GitHubConflictError(path)
    }
    if (!response.ok) {
      throw responseError(response.status, 'file')
    }
    const payload = (await response.json()) as {
      content?: { sha?: unknown }
    }
    if (typeof payload.content?.sha !== 'string') {
      throw new Error(`GitHub 文件 ${path} 上传响应格式无效`)
    }
    return payload.content.sha
  }

  private async branchHead(signal?: AbortSignal): Promise<string> {
    const ref = await this.request(`${this.repoPath()}/git/ref/heads/${encodeURIComponent(this.target.branch)}`, { method: 'GET', signal }, 'file') as { object?: { sha?: unknown } }
    if (typeof ref.object?.sha !== 'string') throw new Error('GitHub 分支响应格式无效')
    return ref.object.sha
  }

  async getSnapshot(options: { signal?: AbortSignal } = {}): Promise<GitHubSnapshot> {
    const sha = await this.branchHead(options.signal)
    const commit = await this.request(`${this.repoPath()}/git/commits/${encodeURIComponent(sha)}`, { method: 'GET', signal: options.signal }, 'file') as { tree?: { sha?: unknown } }
    if (typeof commit.tree?.sha !== 'string') throw new Error('GitHub 提交响应格式无效')
    return { commitSha: sha, treeSha: commit.tree.sha }
  }

  async commitFiles(files: readonly { path: string; bytes: Uint8Array }[], message: string, snapshot: GitHubSnapshot): Promise<void> {
    this.requireToken()
    const paths = files.map(file => { this.scopedPath(file.path); return this.target.root ? `${this.target.root}/${file.path}` : file.path })
    const tree: { path: string; mode: string; type: string; sha: string }[] = []
    const readSha = (value: unknown): string => {
      const sha = (value as { sha?: unknown })?.sha
      if (typeof sha !== 'string') throw new Error('GitHub Git 响应格式无效')
      return sha
    }
    for (const [index, file] of files.entries()) {
      const sha = readSha(await this.request(`${this.repoPath()}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: bytesToBase64(file.bytes), encoding: 'base64' }) }, 'file'))
      tree.push({ path: paths[index], mode: '100644', type: 'blob', sha })
    }
    const treeSha = readSha(await this.request(`${this.repoPath()}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: snapshot.treeSha, tree }) }, 'file'))
    const sha = readSha(await this.request(`${this.repoPath()}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: treeSha, parents: [snapshot.commitSha] }) }, 'file'))
    await this.request(`${this.repoPath()}/git/refs/heads/${encodeURIComponent(this.target.branch)}`, { method: 'PATCH', body: JSON.stringify({ sha, force: false }) }, 'file')
  }

  private repoPath(): string { return `/repos/${encodeURIComponent(this.target.owner)}/${encodeURIComponent(this.target.repository)}` }

  private scopedPath(path: string): string {
    encodePath(path)
    return encodePath(this.target.root ? `${this.target.root}/${path}` : path)
  }

  private requireToken(): void { if (!this.#token.trim()) throw new Error('请输入 GitHub Token') }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      ...(this.#token.trim() ? { Authorization: `Bearer ${this.#token}` } : {}),
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    context: 'repository' | 'file',
  ): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetcher.call(globalThis, `${GITHUB_API_BASE}${path}`, {
        ...init,
        // GitHub serves refs with max-age=60. Reusing our previous head makes
        // the next atomic upload branch from stale history and fail with 422.
        cache: 'no-store',
        headers: {
          ...this.headers(),
          ...init.headers,
        },
      })
    } catch (error) {
      if (init.signal?.aborted) throw error
      throw new Error('无法连接 GitHub API，请检查网络')
    }
    if (response.status === 409 || response.status === 422) throw new GitHubConflictError(path)
    if (!response.ok) {
      throw responseError(response.status, context)
    }
    return response.status === 204 ? undefined : response.json()
  }
}
