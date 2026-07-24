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

const BASE_URL_PREFERENCE = 'marketData.binanceBaseUrl'

export interface MarketDataRuntime {
  datafeed: BinanceDatafeed
  replayDatafeed: ReplayDatafeed
  service: MarketDataService
  replaySessions: IndexedDbReplaySessionStore
  simulationStates: IndexedDbSimulationStateStore
  backups: WorkstationBackupService
  githubSync: GitHubSyncService
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
  const client = new BinanceRestClient(savedBaseUrl())
  const service = new MarketDataService(client, store)
  const datafeed = new BinanceDatafeed(service)
  const backups = new WorkstationBackupService()
  return {
    datafeed,
    replayDatafeed: new ReplayDatafeed(datafeed, service),
    service,
    replaySessions: new IndexedDbReplaySessionStore(),
    simulationStates: new IndexedDbSimulationStateStore(),
    backups,
    githubSync: new GitHubSyncService(backups),
  }
}

export function saveBaseUrlPreference(baseUrl: string): void {
  try {
    localStorage.setItem(BASE_URL_PREFERENCE, baseUrl)
  } catch {
    // The current session still uses the value when storage is unavailable.
  }
}
