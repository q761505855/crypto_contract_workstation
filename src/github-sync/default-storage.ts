/// <reference types="vite/client" />
import { GitHubContentsClient, type GitHubRepositoryTarget } from './github-client'

function buildValue(name: string): string {
  const env = import.meta.env
  const value = env?.[name]
  return typeof value === 'string' ? value.trim() : ''
}

export function defaultStorageTarget(): GitHubRepositoryTarget {
  return {
    owner: buildValue('VITE_GITHUB_OWNER') || 'q761505855',
    repository: buildValue('VITE_GITHUB_REPOSITORY') || 'personal-cloud-storage',
    branch: buildValue('VITE_GITHUB_BRANCH') || 'main',
    root: buildValue('VITE_GITHUB_STORAGE_ROOT') || 'projects/crypto-contract-workstation',
  }
}

export const PUBLISHED_CLOUD_CONNECTION_URL = 'https://q761505855.github.io/crypto_contract_workstation/cloud-connection.json'

/** New checkouts reuse the connection published by Pages, without committing a PAT. */
export async function resolveDefaultGitHubToken(fetcher: typeof fetch = fetch): Promise<string> {
  const configuredToken = buildValue('VITE_GITHUB_TOKEN')
  if (configuredToken) return configuredToken
  try {
    const response = await fetcher(PUBLISHED_CLOUD_CONNECTION_URL, {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return ''
    const value: unknown = await response.json()
    if (value === null || typeof value !== 'object') return ''
    const connection = value as { schemaVersion?: unknown; project?: unknown; token?: unknown }
    if (connection.schemaVersion !== 1 || connection.project !== 'crypto-contract-workstation' || typeof connection.token !== 'string') return ''
    const token = connection.token.trim()
    return token.length <= 4096 && /^\S+$/.test(token) ? token : ''
  } catch {
    // Offline or older deployments keep public read access and local operation.
    return ''
  }
}

export function createDefaultGitHubClient(resolvedToken?: string): GitHubContentsClient | null {
  const token = resolvedToken?.trim() ?? buildValue('VITE_GITHUB_TOKEN')
  return token ? new GitHubContentsClient(defaultStorageTarget(), token) : null
}
