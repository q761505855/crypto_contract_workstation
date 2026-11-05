import { BinanceDatafeed } from './binance-datafeed'
import { MarketDataService } from './market-data-service'
import {
  BinanceRestClient,
  DEFAULT_BASE_URL,
} from './rest-client'
import { IndexedDbMarketDataStore } from '../storage/market-data-store'
import { IndexedDbReplaySessionStore } from '../storage/replay-session-store'
import { IndexedDbSimulationStateStore } from '../storage/simulation-state-store'
import { ReplayDatafeed } from '../replay/replay-datafeed'
import { WorkstationBackupService } from '../storage/backup-service'
import { GitHubSyncService } from '../github-sync/sync-service'
import { BinanceRequestGuard, createBrowserRequestGuard } from './request-guard'
import { BinanceArchiveClient } from './archive-client'
import { createDefaultGitHubClient, defaultStorageTarget } from '../github-sync/default-storage'
import { GitHubContentsClient } from '../github-sync/github-client'
import { GitHubHistoryStore } from '../github-sync/history-store'

const BASE_URL_PREFERENCE = 'marketData.binanceBaseUrl'

export interface MarketDataRuntime {
  requestGuard: BinanceRequestGuard
  datafeed: BinanceDatafeed
  replayDatafeed: ReplayDatafeed
  service: MarketDataService
  replaySessions: IndexedDbReplaySessionStore
  simulationStates: IndexedDbSimulationStateStore
  backups: WorkstationBackupService
  githubSync: GitHubSyncService
  defaultGitHubClient?: GitHubContentsClient
}

function savedBaseUrl(): string {
  try {
    return localStorage.getItem(BASE_URL_PREFERENCE) ?? DEFAULT_BASE_URL
  } catch {
    return DEFAULT_BASE_URL
  }
}

export function createMarketDataRuntime(): MarketDataRuntime {
  const store = new IndexedDbMarketDataStore()
  const requestGuard = createBrowserRequestGuard()
  const client = new BinanceRestClient(savedBaseUrl(), fetch, Date.now, undefined, requestGuard)
  const defaultGitHubClient = createDefaultGitHubClient() ?? new GitHubContentsClient(defaultStorageTarget())
  const service = new MarketDataService(client, store, {
    archives: new BinanceArchiveClient(),
    cloud: new GitHubHistoryStore(defaultGitHubClient),
    pendingStorage: localStorage,
  })
  const datafeed = new BinanceDatafeed(service)
  const backups = new WorkstationBackupService()
  return {
    requestGuard,
    datafeed,
    replayDatafeed: new ReplayDatafeed(datafeed, service),
    service,
    replaySessions: new IndexedDbReplaySessionStore(),
    simulationStates: new IndexedDbSimulationStateStore(),
    backups,
    githubSync: new GitHubSyncService(backups),
    defaultGitHubClient,
  }
}

export function saveBaseUrlPreference(baseUrl: string): void {
  try {
    localStorage.setItem(BASE_URL_PREFERENCE, baseUrl)
  } catch {
    // The current session still uses the value when storage is unavailable.
  }
}
