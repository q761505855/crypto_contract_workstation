import { CTraderClient } from './ctrader-client'
import { CTraderAccountSelection } from './ctrader-account-selection'
import { loadCTraderConnection } from './ctrader-connection'
import { CTraderDatafeed } from './ctrader-datafeed'
import { CTraderMarketService } from './ctrader-market'
import { CTraderReplayDatafeed } from '../replay/ctrader-replay-datafeed'
import { CTRADER_DATABASE_NAME, ctraderStorage } from '../storage/ctrader-storage'
import { IndexedDbReplaySessionStore } from '../storage/replay-session-store'
import { IndexedDbSimulationStateStore } from '../storage/simulation-state-store'
import { WorkstationBackupService } from '../storage/backup-service'
import { GitHubSyncService } from '../github-sync/sync-service'
import { defaultStorageTarget } from '../github-sync/default-storage'
import { GitHubContentsClient } from '../github-sync/github-client'
import type { ConfigAutoSync } from '../github-sync/config-auto-sync'
import { DrawingStore } from '../chart/drawings'
import { DrawingAutoSync } from '../github-sync/drawing-auto-sync'

export interface MarketDataRuntime {
  accountSelection: CTraderAccountSelection
  datafeed: CTraderDatafeed
  replayDatafeed: CTraderReplayDatafeed
  service: CTraderMarketService
  replaySessions: IndexedDbReplaySessionStore
  simulationStates: IndexedDbSimulationStateStore
  backups: WorkstationBackupService
  githubSync: GitHubSyncService
  defaultGitHubClient: GitHubContentsClient
  configSync?: ConfigAutoSync
  drawings: DrawingStore
  drawingSync: DrawingAutoSync
  disposeMarketConnection(): void
}

export function createMarketDataRuntime(cloudToken?: string): MarketDataRuntime {
  const accountSelection = new CTraderAccountSelection()
  const connection = new CTraderClient(loadCTraderConnection, undefined, accountSelection.choose)
  const service = new CTraderMarketService(connection)
  const datafeed = new CTraderDatafeed(service)
  const defaultGitHubClient = new GitHubContentsClient(defaultStorageTarget(), cloudToken)
  const drawings = new DrawingStore()
  const backups = new WorkstationBackupService(CTRADER_DATABASE_NAME, ctraderStorage, Date.now, drawings, { includeMarketHistory: false })

  return {
    accountSelection,
    datafeed,
    replayDatafeed: new CTraderReplayDatafeed(datafeed, service),
    service,
    replaySessions: new IndexedDbReplaySessionStore(CTRADER_DATABASE_NAME),
    simulationStates: new IndexedDbSimulationStateStore(CTRADER_DATABASE_NAME),
    backups,
    githubSync: new GitHubSyncService(backups, Date.now, { scope: 'ctrader' }),
    defaultGitHubClient,
    drawings,
    drawingSync: new DrawingAutoSync(drawings, defaultGitHubClient),
    disposeMarketConnection: () => service.dispose(),
  }
}
