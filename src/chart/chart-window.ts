import type { Period, SymbolInfo } from '@klinecharts/pro'
import type { MarketDataRuntime } from '../market-data/runtime'
import { ctraderReplayChartNeedsReload, type CTraderReplayDatafeed } from '../replay/ctrader-replay-datafeed'
import { compareReplayPositions, replayVisibleUntil, type ReplayContext } from '../replay/models'
import type { CTraderDatafeed } from '../market-data/ctrader-datafeed'
import { readChartWindowSize, saveChartWindowSize, type ChartWindowSize } from './chart-window-preferences'
import type { SimulationOverlayState } from './pro-chart-adapter'
import { drawingScope } from './drawings'

const CONNECT_EVENT = 'workstation:connect-chart-window'
export const CHART_WINDOW_QUERY = 'chart-window'

interface HostChartState {
  symbol: SymbolInfo
  period: Period
  liveEnabled: boolean
  replay: ReplayContext | null
  simulationOverlays: SimulationOverlayState
  configRevision: number
  dataRevision?: number
}

interface ChartWindowSnapshot {
  symbol: SymbolInfo
  visibleUntil: number | null
  simulationOverlays: SimulationOverlayState
  chartRevision: number
  configRevision: number
  drawingScope: string | null
  dataRevision?: number
}

export interface ChartWindowConnection {
  datafeed: CTraderReplayDatafeed
  liveDatafeed: CTraderDatafeed
  initialPeriod: Period
  localArchives?: boolean
  setPeriod(period: Period): void
  saveDefaultSize(size: ChartWindowSize): void
  subscribe(listener: () => void): () => void
  getSnapshot(): ChartWindowSnapshot | null
  close(): void
}

interface ConnectRequest {
  peer: Window
  period?: Period
  connection?: ChartWindowConnection
}

export function openChartWindow(): Window | null {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set(CHART_WINDOW_QUERY, '1')
  const { width, height } = readChartWindowSize()
  return window.open(url.href, '_blank', `popup,width=${width},height=${height}`)
}

export function connectChartWindow(peer: Window, period?: Period): ChartWindowConnection | undefined {
  const opener = peer.opener as Window | null
  if (!opener || opener.closed) return
  const request: ConnectRequest = { peer, period }
  try {
    if (opener.location.origin === peer.location.origin) {
      opener.dispatchEvent(new CustomEvent(CONNECT_EVENT, { detail: request }))
    }
  } catch {
    // The opener can navigate to another origin between checks.
  }
  return request.connection
}

export class ChartWindowHost {
  private state: HostChartState | null = null
  private readonly views = new Set<ChartWindowConnection & { update(state: HostChartState): void }>()

  constructor(private readonly runtime: MarketDataRuntime) {}

  listen(): () => void {
    const connect = (event: Event) => {
      const request = (event as CustomEvent<ConnectRequest>).detail
      if (this.state === null || !request?.peer || request.peer.closed || request.peer.opener !== window) return
      this.attach(request, this.state)
    }
    const disconnect = () => {
      for (const view of this.views) view.close()
    }
    window.addEventListener(CONNECT_EVENT, connect)
    window.addEventListener('pagehide', disconnect)
    return () => {
      window.removeEventListener(CONNECT_EVENT, connect)
      window.removeEventListener('pagehide', disconnect)
      disconnect()
    }
  }

  publish(state: HostChartState): void {
    this.state = state
    for (const view of this.views) view.update(state)
  }

  private attach(request: ConnectRequest, initial: HostChartState): void {
    const liveDatafeed = this.runtime.datafeed.createChartView()
    const datafeed = this.runtime.replayDatafeed.createChartView(liveDatafeed)
    const listeners = new Set<() => void>()
    const initialPeriod = request.period ?? initial.period
    let period = initialPeriod
    let replay: ReplayContext | null = null
    let snapshot: ChartWindowSnapshot | null = null
    let closed = false
    const notify = () => {
      for (const listener of listeners) listener()
    }
    const view = {
      initialPeriod,
      datafeed,
      liveDatafeed,
      localArchives: this.runtime.service.source === 'okx-local',
      setPeriod(next: Period) { period = next },
      saveDefaultSize(size: ChartWindowSize) { saveChartWindowSize(size) },
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      update: (state: HostChartState) => {
        if (request.peer.closed) { view.close(); return }
        const next = state.replay
        const visibleUntil = next === null ? null : replayVisibleUntil(next)
        const reload = snapshot !== null && (
          snapshot.symbol.ticker !== state.symbol.ticker ||
          snapshot.dataRevision !== state.dataRevision ||
          (replay === null) !== (next === null) ||
          (replay !== null && next !== null && (
            replay.sessionId !== next.sessionId || compareReplayPositions(next, replay) < 0 ||
            ctraderReplayChartNeedsReload(replay, next, period.text)
          ))
        )
        if (!state.liveEnabled) liveDatafeed.setLiveEnabled(false)
        if (reload) datafeed.dispose()
        datafeed.setReplayContext(next, reload)
        if (state.liveEnabled) liveDatafeed.setLiveEnabled(true)
        replay = next
        const chartRevision = (snapshot?.chartRevision ?? 0) + Number(reload)
        if (snapshot?.symbol === state.symbol &&
            snapshot.visibleUntil === visibleUntil && snapshot.chartRevision === chartRevision &&
            snapshot.configRevision === state.configRevision && snapshot.simulationOverlays === state.simulationOverlays) return
        snapshot = { symbol: state.symbol, visibleUntil, simulationOverlays: state.simulationOverlays,
          chartRevision, configRevision: state.configRevision, dataRevision: state.dataRevision,
          drawingScope: drawingScope(next === null ? 'live' : 'history', state.symbol.ticker, next?.sessionId ?? null, state.symbol.exchange) }
        notify()
      },
      close: () => {
        if (closed) return
        closed = true
        this.views.delete(view)
        liveDatafeed.setLiveEnabled(false)
        datafeed.dispose()
        snapshot = null
        notify()
        listeners.clear()
      },
    }
    this.views.add(view)
    view.update(initial)
    request.connection = view
  }
}
