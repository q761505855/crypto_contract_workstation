import { CTraderClient } from './ctrader-client'
import { CTraderAccountSelection } from './ctrader-account-selection'
import { loadCTraderConnection } from './ctrader-connection'
import { CTraderDatafeed } from './ctrader-datafeed'
import { CTraderMarketService } from './ctrader-market'
import { CTraderReplayDatafeed } from '../replay/ctrader-replay-datafeed'
import { CTraderReplayTicks } from '../replay/ctrader-replay-ticks'
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
import { OkxMarketService } from './okx/market'
import { OkxLocalMarket } from './okx/local-market'
import { okxLocalFiles } from './okx/local-files'
import type { PriceSource } from './price-source-preferences'

export interface MarketDataRuntime {
  accountSelection: CTraderAccountSelection
  datafeed: CTraderDatafeed
  replayDatafeed: CTraderReplayDatafeed
  replayTicks: CTraderReplayTicks
  service: CTraderMarketService | OkxMarketService | OkxLocalMarket
  forPriceSource(source: PriceSource): MarketDataRuntime
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
  const connection = new CTraderClient(loadCTraderConnection, undefined, accountSelection.choose, accountSelection.selected)
  const service = new CTraderMarketService(connection)
  const datafeed = new CTraderDatafeed(service)
  const replayTicks = new CTraderReplayTicks(service)
  const defaultGitHubClient = new GitHubContentsClient(defaultStorageTarget(), cloudToken)
  const drawings = new DrawingStore()
  const backups = new WorkstationBackupService(CTRADER_DATABASE_NAME, ctraderStorage, Date.now, drawings, { includeMarketHistory: false })

  const runtime: MarketDataRuntime = {
    accountSelection,
    datafeed,
    replayDatafeed: new CTraderReplayDatafeed(datafeed, service, replayTicks),
    replayTicks,
    service,
    replaySessions: new IndexedDbReplaySessionStore(CTRADER_DATABASE_NAME),
    simulationStates: new IndexedDbSimulationStateStore(CTRADER_DATABASE_NAME),
    backups,
    githubSync: new GitHubSyncService(backups, Date.now, { scope: 'ctrader' }),
    defaultGitHubClient,
    drawings,
    drawingSync: new DrawingAutoSync(drawings, defaultGitHubClient),
    forPriceSource: source => {
      if (source === 'ctrader') return runtime
      okx ??= new OkxMarketService()
      const market = source === 'okx-local' ? new OkxLocalMarket(okxLocalFiles, okx) : okx
      const live = new CTraderDatafeed(market)
      const ticks = new CTraderReplayTicks(market)
      return { ...runtime, service: market, datafeed: live, replayTicks: ticks,
        replayDatafeed: new CTraderReplayDatafeed(live, market, ticks) }
    },
    disposeMarketConnection: () => { service.dispose(); okx?.dispose() },
  }
  let okx: OkxMarketService | undefined
  return runtime
}
