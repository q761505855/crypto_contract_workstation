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

export function createDefaultGitHubClient(): GitHubContentsClient | null {
  const token = buildValue('VITE_GITHUB_TOKEN')
  return token ? new GitHubContentsClient(defaultStorageTarget(), token) : null
}
