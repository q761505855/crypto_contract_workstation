import type { BrowserContext } from '@playwright/test'
import { PUBLISHED_CLOUD_CONNECTION_URL } from '../src/github-sync/default-storage'

export const mockCloudConnection = {
  schemaVersion: 1,
  project: 'crypto-contract-workstation',
  token: 'e2e-mock-storage-token',
}

export async function installCloudConnectionFixture(context: BrowserContext) {
  await context.route(PUBLISHED_CLOUD_CONNECTION_URL, route => route.fulfill({
    headers: { 'access-control-allow-origin': '*' },
    json: mockCloudConnection,
  }))
}
