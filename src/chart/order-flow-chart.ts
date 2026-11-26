import { DomPosition, type ActionType, type Chart, type Indicator, type KLineData } from 'klinecharts'
import { alignOpenTime, CTRADER_TIMEFRAMES, nextOpenTime } from '../market-data/intervals'
import type { BybitTrade } from '../market-data/bybit/trades'
import { BYBIT_DAY_MS } from '../market-data/bybit/trades'
import { DATABENTO_CHART_PRICE_PRECISION, DATABENTO_PRICE_PRECISION } from '../market-data/models'
import type { CombinedBybitSource, TradeRange } from '../market-data/bybit/combined-source'
import { BIG_TRADES, DEFAULT_BIG_TRADE_NOTIONAL, VolumeProfileLevels, bigTradeMode, bigTradeThresholdUnits,
  volumeProfileBounds, volumeProfileCenter, volumeProfilePrices, type BigTradeMode, type VolumeProfile, type VolumeProfileBounds } from './order-flow'
import { CANDLE_PANE, tradeBubbleOffset, tradeBubbleRadius, type BubbleDisplay, type ProfileDisplay } from './order-flow-renderers'
import { selectVisibleTradeBubbles, type DisplayedTradeBubble } from './order-flow-bubbles'
import { OrderFlowBars, tradeBubblePrice, type TradeBar } from './order-flow-bars'
import { ReplayOrderFlow } from './order-flow-replay'
import type { DrawingPoint } from './drawings'
import { drawingIndexAt } from './drawing-coordinates'
import { CANDLE_VOLUME_PROFILE, CVD, FOOTPRINT, VISIBLE_VOLUME_PROFILE, VWAP, bigTradeThreshold, bubblePreferenceDefaults, orderFlowSettings, withoutBubbleDefaults, type OrderFlowPreferences } from './order-flow-preferences'
import { calculateFootprint, cumulativeVolumeDelta, dailyTradeVwap, tradeBarProfileLevels, tradeDay, visibleVolumeProfile, type FootprintRow } from './order-flow-metrics'
import { CandleWorkerResults, orderFlowWorkers, parallelBubbles, parallelFootprint, WORKER_TRADE_THRESHOLD } from './order-flow-workers'
import { runOrderFlowTask, type TradeColumns } from './order-flow-worker-tasks'
import type { CandleProfileDisplay, CvdDisplay, FootprintDisplay, VisibleProfileDisplay, VwapDisplay } from './order-flow-indicators'

const dataReady = 'onDataReady' as ActionType
const visibleRangeChange = 'onVisibleRangeChange' as ActionType
const volumeIndicators = new Set(['VOL', 'AVP', 'OBV', 'PVT', 'VR', 'EMV'])
const profileDragPauseMs = 120

interface ProfileRequest {
  range: TradeRange
  cursor: number
  levels: VolumeProfileLevels
  prices?: Map<number, number>
  complete: boolean
  operation?: AbortController
  pendingUntil?: number
  message?: string
  previewUntil?: number
}

const notional = (trade: BybitTrade) => trade.price * trade.size
const errorText = (error: unknown) => error instanceof Error ? error.message : '读取逐笔成交失败'
const unavailable = '此品种暂无逐笔成交'

function sameValues<T>(a: ReadonlyMap<number, T> | undefined, b: ReadonlyMap<number, T> | undefined): boolean {
  return a === b || (a?.size === b?.size && !!a && !!b && [...a].every(([key, value]) => b.get(key) === value))
}

function bybitVolumeCalc(native: Indicator['calc'], volumes?: ReadonlyMap<number, number>): Indicator['calc'] {
  return async (data, indicator) => {
    const result: Record<string, number>[] = data.map(() => ({}))
    for (let index = 0; index < data.length;) {
      if (!volumes?.has(data[index].timestamp)) { index++; continue }
      const start = index
      const series: KLineData[] = []
      while (index < data.length) {
        const candle = data[index]
        const volume = volumes.get(candle.timestamp)
        if (volume === undefined) break
        series.push({ ...candle, volume })
        index++
      }
      const rows = await native(series, indicator)
      for (let offset = 0; offset < rows.length; offset++) result[start + offset] = rows[offset]
    }
    return result
  }
}

export class OrderFlowChart {
  private readonly profiles = new Map<string, ProfileRequest>()
  private flow?: OrderFlowBars
  private replayFlow?: ReplayOrderFlow
  private flowSource?: string
  private updating?: TradeRange
  private flowOperation?: AbortController
  private flowPaint?: number
  private flowPending = false
  private readonly flowInvalidations: TradeRange[] = []
  private timer?: number
  private readonly resize: () => void
  private readonly createIndicator: Chart['createIndicator']
  private readonly overrideIndicator: Chart['overrideIndicator']
  private readonly removeIndicator: Chart['removeIndicator']
  private readonly pane: HTMLElement | null
  private readonly tooltip?: HTMLDivElement
  private pendingFrame?: number
  private readonly nativeVolume = new Map<Indicator, { calc: Indicator['calc']; shortName: string; precision: number }>()
  private displayedVolumes?: Map<number, number>
  private volumeSymbol?: string
  private displayedBubbleCount = 0
  private displayedBubbleVersion = 0
  private settings: OrderFlowPreferences | undefined
  private footprintSettings = orderFlowSettings('footprint')
  private bubbleSettings = orderFlowSettings('bubbles')
  private profileSettings = orderFlowSettings('profile')
  private candleProfileSettings = orderFlowSettings('candleProfile')
  private visibleProfileSettings = orderFlowSettings('visibleProfile')
  private cvdSettings = orderFlowSettings('cvd')
  private footprintRows = new WeakMap<TradeBar, { open: number; precision: number; projected: boolean; targetRows: number; rows: FootprintRow[] }>()
  private candleProfiles = new WeakMap<VolumeProfileLevels, VolumeProfile | undefined>()
  private readonly footprintWorkers = new CandleWorkerResults<FootprintRow[]>(() => this.schedule())
  private readonly bubbleWorkers = new CandleWorkerResults<DisplayedTradeBubble[]>(() => this.schedule())
  private previousBarSpace?: number
  private orderFlowBarSpace?: number
  private reserveOrderFlowSpaceOnRight = false

  constructor(private readonly chart: Chart, private readonly feed: CombinedBybitSource, private readonly timeframe: () => string,
    private readonly hasCurrentCandles: () => boolean = () => true, private readonly nativePriceVolume = false,
    private readonly getLotSize: () => number | undefined = () => undefined) {
    this.createIndicator = chart.createIndicator
    this.overrideIndicator = chart.overrideIndicator
    this.removeIndicator = chart.removeIndicator
    chart.createIndicator = (...args) => {
      const result = this.createIndicator.apply(chart, args)
      const name = typeof args[0] === 'string' ? args[0] : args[0].name
      if (result && name === BIG_TRADES) this.applyBubblePreferences()
      this.schedule()
      return result
    }
    chart.overrideIndicator = (...args) => {
      this.overrideIndicator.apply(chart, args)
      this.schedule()
    }
    chart.removeIndicator = (...args) => {
      const [pane, name] = args
      const bubble = (!pane || pane === CANDLE_PANE) && (!name || name === BIG_TRADES) ? this.bubbleIndicator() : undefined
      this.removeIndicator.apply(chart, args)
      if (bubble && !this.bubbleIndicator()) this.settings = this.withBubblePreferences(bubble)
      this.schedule()
    }
    this.resize = this.schedule.bind(this)
    chart.subscribeAction(dataReady, this.resize)
    chart.subscribeAction(visibleRangeChange, this.resize)
    this.pane = chart.getDom(CANDLE_PANE, DomPosition.Main)
    if (this.pane) {
      this.tooltip = document.createElement('div')
      this.tooltip.className = 'bybit-trade-tooltip'
      this.tooltip.hidden = true
      this.pane.append(this.tooltip)
      this.pane.addEventListener('pointermove', this.hover)
      this.pane.addEventListener('pointerdown', this.hover)
      this.pane.addEventListener('pointerleave', this.hideTooltip)
    }
    this.schedule()
  }

  get supported(): boolean { return !!this.feed.mapping }

  get preferences(): OrderFlowPreferences | undefined {
    return this.bubbleIndicator() ? withoutBubbleDefaults(this.settings) : this.settings
  }

  private mainIndicator(name: string): Indicator | undefined {
    return (this.chart.getIndicatorByPaneId(CANDLE_PANE, name) as Indicator | null) ?? undefined
  }

  private bubbleIndicator(): Indicator | undefined {
    return this.mainIndicator(BIG_TRADES)
  }

  private withBubblePreferences(bubble: Indicator): OrderFlowPreferences {
    return { ...this.settings, bubbles: { ...this.settings?.bubbles, ...bubblePreferenceDefaults(bubble.calcParams, bubble.styles) } }
  }

  applyBubblePreferences(): void {
    const bubble = this.bubbleIndicator()
    const saved = this.settings?.bubbles
    if (!saved || !bubble) return
    const legacy = bubblePreferenceDefaults(bubble.calcParams, bubble.styles)
    if (!Object.keys(legacy).some(key => Object.hasOwn(saved, key))) return
    const { mode, minNotional, buyFillColor, sellFillColor, buyOutlineColor, sellOutlineColor } = { ...legacy, ...saved }
    this.overrideIndicator.call(this.chart, {
      name: BIG_TRADES, calcParams: [minNotional],
      styles: { bubbleMode: mode, bubbleColors: [buyFillColor, sellFillColor, buyOutlineColor, sellOutlineColor].map(color => ({ color })) },
    }, CANDLE_PANE)
  }

  setPreferences(preferences: OrderFlowPreferences | undefined): void {
    const candleProfile = orderFlowSettings('candleProfile', preferences)
    if (candleProfile.rows !== this.candleProfileSettings.rows || candleProfile.valueArea !== this.candleProfileSettings.valueArea) {
      this.candleProfiles = new WeakMap()
    }
    this.settings = preferences
    this.profileSettings = orderFlowSettings('profile', preferences)
    this.candleProfileSettings = candleProfile
    this.visibleProfileSettings = orderFlowSettings('visibleProfile', preferences)
    this.footprintSettings = orderFlowSettings('footprint', preferences)
    this.bubbleSettings = orderFlowSettings('bubbles', preferences)
    this.cvdSettings = orderFlowSettings('cvd', preferences)
    this.footprintRows = new WeakMap()
    this.footprintWorkers.clear()
    this.bubbleWorkers.clear()
    for (const [id, request] of this.profiles) {
      this.showProfile(id, { profile: request.levels.profile(this.profileSettings.rows, this.profileSettings.valueArea), message: request.message })
    }
    this.hideTooltip()
    this.schedule()
  }

  refresh(reset = false, affected?: TradeRange): void {
    if (affected?.historyPage) {
      if (this.flowSource === this.feed.archiveCacheKey) {
        this.flow?.acceptHistory(affected, this.feed)
        this.replayFlow?.acceptHistory(affected, this.feed)
      }
      if (affected.fromUs < this.feed.tradeCursorUs) this.invalidateProfiles(affected)
      this.schedule()
      return
    }
    if (reset) {
      if (affected) {
        if (this.flowOperation && !affected.replaceArchive && this.flowSource === this.feed.archiveCacheKey) {
          // Live updates must not restart an in-flight history scan.
          const overlapping = this.flowInvalidations.find(range => range.fromUs <= affected.untilUs && range.untilUs >= affected.fromUs)
          if (overlapping) {
            overlapping.fromUs = Math.min(overlapping.fromUs, affected.fromUs)
            overlapping.untilUs = Math.max(overlapping.untilUs, affected.untilUs)
          } else this.flowInvalidations.push({ ...affected })
          this.flowPending = true
          this.invalidateProfiles(affected)
          return
        }
        this.invalidateFlow(affected)
        if (affected.replaceArchive) for (const range of this.flowInvalidations.splice(0)) this.invalidateFlow(range)
      }
      else {
        this.showBubbles({})
        this.showVolume()
        this.showFootprint()
        this.showCvd()
        this.showCandleProfile()
        this.showVisibleProfile()
        this.showVwap()
      }
      if (affected?.replaceArchive || !this.replayFlow || !this.feed.replaying || this.flowSource !== this.feed.archiveCacheKey) this.cancelFlow()
      this.invalidateProfiles(affected)
    }
    this.schedule()
  }

  setProfile(id: string, points: readonly DrawingPoint[], preview = false): void {
    const [first, last] = points
    if (!first || !last) return
    const fromUs = Math.min(first.timestamp, last.timestamp) * 1000
    const untilUs = (Math.max(first.timestamp, last.timestamp) + 1) * 1000
    const existing = this.profiles.get(id)
    if (existing?.range.fromUs === fromUs && existing.range.untilUs === untilUs) {
      if (preview || existing.previewUntil === undefined) return
      existing.previewUntil = undefined
    } else {
      this.removeProfile(id)
      this.profiles.set(id, {
        range: { fromUs, untilUs }, cursor: fromUs, complete: true, levels: new VolumeProfileLevels(),
        previewUntil: preview ? performance.now() + profileDragPauseMs : undefined,
      })
      this.showProfile(id, { message: '读取区间成交…' })
    }
    if (this.pendingFrame === undefined) {
      this.pendingFrame = requestAnimationFrame(() => {
        this.pendingFrame = undefined
        for (const [profileId, request] of this.profiles) void this.updateProfile(profileId, request)
      })
    }
  }

  removeProfile(id: string): void {
    this.profiles.get(id)?.operation?.abort()
    this.profiles.delete(id)
  }

  dispose(): void {
    this.chart.unsubscribeAction(dataReady, this.resize)
    this.chart.unsubscribeAction(visibleRangeChange, this.resize)
    this.chart.createIndicator = this.createIndicator
    this.chart.overrideIndicator = this.overrideIndicator
    this.chart.removeIndicator = this.removeIndicator
    this.pane?.removeEventListener('pointermove', this.hover)
    this.pane?.removeEventListener('pointerdown', this.hover)
    this.pane?.removeEventListener('pointerleave', this.hideTooltip)
    this.tooltip?.remove()
    clearTimeout(this.timer)
    if (this.pendingFrame !== undefined) cancelAnimationFrame(this.pendingFrame)
    this.cancelFlow()
    for (const id of this.profiles.keys()) this.removeProfile(id)
  }

  private invalidateProfiles(affected?: TradeRange): void {
    for (const request of this.profiles.values()) {
      const processedUntil = request.pendingUntil ?? request.cursor
      if (affected && (request.range.fromUs >= affected.untilUs || processedUntil <= affected.fromUs)) continue
      request.operation?.abort()
      request.operation = undefined
      request.pendingUntil = undefined
      request.cursor = request.range.fromUs
      request.complete = true
      request.prices?.clear()
      request.levels = new VolumeProfileLevels()
    }
  }

  private cancelFlow(): void {
    this.flowOperation?.abort()
    this.flowOperation = undefined
    this.cancelFlowPaint()
    this.flowPending = false
    this.flowInvalidations.length = 0
    this.updating = undefined
    this.footprintWorkers.retain(new Set())
    this.bubbleWorkers.retain(new Set())
  }

  private cancelFlowPaint(): void {
    if (this.flowPaint === undefined) return
    cancelAnimationFrame(this.flowPaint)
    this.flowPaint = undefined
  }

  private invalidateFlow(affected: TradeRange): void {
    this.flow?.invalidate(affected)
    this.replayFlow?.invalidate(affected)
  }

  private schedule(): void {
    if (this.timer !== undefined) return
    this.timer = window.setTimeout(() => {
      this.timer = undefined
      if (!this.hasCurrentCandles()) return
      for (const [id, request] of this.profiles) void this.updateProfile(id, request)
      void this.updateFlow()
    }, 150)
  }

  private showProfile(id: string, display: ProfileDisplay): void {
    const request = this.profiles.get(id)
    if (request) request.message = display.message
    const bounds = display.bounds ?? volumeProfileBounds(display.profile) ?? (request && this.profileCandleBounds(request.range))
    const center = volumeProfileCenter(display.profile, bounds)
    const overlay = this.chart.getOverlayById(id)
    if (center !== undefined && overlay) {
      // Updating only the price keeps the native time handles and drawing step.
      for (const point of overlay.points) point.value = center
    }
    this.chart.overrideOverlay({ id, extendData: { ...display, bounds, settings: this.profileSettings } })
  }

  private *profileCandles(fromUs: number, untilUs: number) {
    const candles = this.chart.getDataList()
    if (!candles.length || untilUs <= fromUs) return
    const period = this.timeframe()
    const first = Math.max(0, Math.floor(drawingIndexAt(candles, fromUs / 1000, period)))
    for (let index = first; index < candles.length; index++) {
      const candle = candles[index]
      const start = candle.timestamp * 1000
      if (start >= untilUs) break
      const end = nextOpenTime(candle.timestamp, period) * 1000
      if (end > fromUs) yield { candle, start, end }
    }
  }

  private profileCandleBounds(range: TradeRange): VolumeProfileBounds | undefined {
    if (!this.hasCurrentCandles()) return
    let low = Infinity
    let high = -Infinity
    for (const { candle } of this.profileCandles(range.fromUs, Math.min(range.untilUs, this.feed.tradeCursorUs))) {
      low = Math.min(low, candle.low)
      high = Math.max(high, candle.high)
    }
    if (low <= high) return { low, high }
  }

  private cachedProfileLevels(fromUs: number, untilUs: number): VolumeProfileLevels | undefined {
    const flow = this.feed.replaying && !this.feed.localArchive ? this.replayFlow : this.flow
    if (flow?.key !== JSON.stringify([this.feed.archiveCacheKey, 0]) ||
        this.flowInvalidations.some(range => range.fromUs < untilUs && range.untilUs > fromUs)) return
    const projected = this.feed.mapping?.relation === 'etf'
    const cursor = this.feed.tradeCursorUs
    const slices: { bar: TradeBar; open: number; start: number; end: number }[] = []
    let coveredUntil = fromUs
    for (const { candle, start, end } of this.profileCandles(fromUs, untilUs)) {
      if (start > coveredUntil) return
      const bar = flow.read(candle.timestamp, Math.min(end, cursor), this.feed)
      if (!bar.complete) return
      slices.push({ bar, open: candle.open, start, end: bar.cursor })
      coveredUntil = bar.cursor
    }
    if (coveredUntil < untilUs) return
    const levels = new VolumeProfileLevels()
    for (const { bar, open, start, end } of slices) {
      const full = start >= fromUs && end <= untilUs
      levels.merge(full ? tradeBarProfileLevels(bar, open, projected)
        : tradeBarProfileLevels(bar, open, projected, Math.max(start, fromUs), Math.min(end, untilUs)))
    }
    return levels
  }

  private finishProfile(id: string, request: ProfileRequest, untilUs: number, complete: boolean): void {
    request.cursor = untilUs
    request.complete &&= complete
    const profile = request.levels.profile(this.profileSettings.rows, this.profileSettings.valueArea)
    this.showProfile(id, { profile, message: request.complete ? (profile ? undefined : '选区暂无成交') : '选区的逐笔成交不完整' })
    if (Math.min(this.feed.tradeCursorUs, request.range.untilUs) > untilUs) this.schedule()
  }

  private async updateProfile(id: string, request: ProfileRequest): Promise<void> {
    if (!this.supported || !this.hasCurrentCandles()) return
    const untilUs = Math.min(this.feed.tradeCursorUs, request.range.untilUs)
    if (untilUs < request.cursor) {
      request.operation?.abort()
      request.operation = undefined
      request.pendingUntil = undefined
      request.levels = new VolumeProfileLevels()
      request.cursor = request.range.fromUs
      request.complete = true
      request.prices?.clear()
      this.showProfile(id, {})
    }
    if (untilUs <= request.cursor) {
      if (untilUs <= request.range.fromUs) this.showProfile(id, { message: '等待回放进入选区' })
      return
    }
    if (request.operation) return
    const cached = this.cachedProfileLevels(request.cursor, untilUs)
    if (cached) {
      request.levels.merge(cached)
      this.finishProfile(id, request, untilUs, true)
      return
    }
    if (request.previewUntil !== undefined && performance.now() < request.previewUntil) {
      this.schedule()
      return
    }
    const operation = new AbortController()
    request.operation = operation
    request.pendingUntil = untilUs
    try {
      const timeframe = this.timeframe()
      const start = alignOpenTime(request.cursor / 1000, timeframe, 'floor')
      const fromUs = this.feed.mapping?.relation === 'etf' && !request.prices?.has(start) ? start * 1000 : request.cursor
      const levels = request.levels
      const parallel = await this.calculateProfile(request, timeframe, fromUs, untilUs, operation.signal)
      let complete: boolean
      if (parallel) {
        operation.signal.throwIfAborted()
        levels.merge(parallel.levels)
        complete = parallel.complete
      } else {
        const project = this.projectPrices(this.chart.getDataList(), timeframe, request.prices ??= new Map())
        let nextPreview = performance.now() + 120
        complete = await this.feed.visitTrades({ fromUs, untilUs }, trade => {
          const price = project(trade)
          if (price !== undefined && trade.timeUs >= request.cursor) levels.add(price, trade.side === 'buy' ? trade.size : -trade.size)
        }, operation.signal, coverage => {
          if (operation.signal.aborted || coverage.untilUs >= untilUs || performance.now() < nextPreview) return
          const profile = levels.profile(this.profileSettings.rows, this.profileSettings.valueArea)
          if (profile) this.showProfile(id, { profile, bounds: this.profileCandleBounds(request.range), message: '正在计算区间成交…' })
          nextPreview = performance.now() + 120
        })
      }
      operation.signal.throwIfAborted()
      this.finishProfile(id, request, untilUs, complete)
    } catch (error) {
      // A retry must reprocess any partial range that was already accumulated.
      if (!operation.signal.aborted) {
        request.cursor = request.range.fromUs
        request.levels = new VolumeProfileLevels()
        request.complete = true
        request.prices?.clear()
        this.showProfile(id, { message: errorText(error) })
      }
    } finally {
      if (request.operation === operation) {
        request.operation = undefined
        request.pendingUntil = undefined
      }
    }
  }

  private async calculateProfile(request: ProfileRequest, timeframe: string, fromUs: number, untilUs: number, signal: AbortSignal) {
    const local = this.feed.localArchive
    const symbol = this.feed.mapping?.symbol
    if (!symbol || !orderFlowWorkers.available) return
    const levels = new VolumeProfileLevels()
    const pending: Promise<TradeColumns>[] = []
    const controller = new AbortController()
    const batchSignal = AbortSignal.any([signal, controller.signal])
    const merge = async () => {
      const result = await pending.shift()!
      batchSignal.throwIfAborted()
      levels.addPacked(result)
    }
    const submit = async (values: TradeColumns) => {
      const job = orderFlowWorkers.run(() => ({ kind: 'profile', values }), batchSignal, true)
      void job.catch(() => undefined)
      pending.push(job)
      if (pending.length >= orderFlowWorkers.parallelism) await merge()
    }
    try {
      let complete: boolean
      let anchors: Map<number, number> | undefined
      if (local) complete = await local.visitPriceSizes(symbol, fromUs, untilUs, submit, batchSignal)
      else {
        anchors = new Map(request.prices)
        const project = this.projectPrices(this.chart.getDataList(), timeframe, anchors)
        let values = new Float64Array(32_768 * 2)
        let write = 0
        complete = await this.feed.visitTrades({ fromUs, untilUs }, trade => {
          const price = project(trade)
          if (price === undefined || trade.timeUs < request.cursor) return
          values[write++] = price
          values[write++] = trade.side === 'buy' ? trade.size : -trade.size
          if (write < values.length) return
          const batch = values
          values = new Float64Array(batch.length)
          write = 0
          return submit(batch)
        }, batchSignal)
        if (write >= WORKER_TRADE_THRESHOLD * 2) await submit(values.subarray(0, write))
        else if (write > 0) levels.addPacked(runOrderFlowTask({ kind: 'profile', values: values.subarray(0, write) }))
      }
      while (pending.length) await merge()
      batchSignal.throwIfAborted()
      if (anchors) request.prices = anchors
      return { levels, complete }
    } catch {
      signal.throwIfAborted()
      // The exact main-thread calculation remains available if a worker fails.
    } finally {
      controller.abort()
    }
  }

  private showBubbles(display: BubbleDisplay): void {
    const indicator = this.bubbleIndicator()
    const activeBars = indicator?.visible && display.mode ? display.bars : undefined
    this.bubbleWorkers.retain(new Set(activeBars?.values()))
    if (!indicator) return
    const previous = indicator.extendData as BubbleDisplay | undefined
    let count = 0
    let sameBars = previous?.bars?.size === display.bars?.size
    for (const [start, bar] of display.bars ?? []) {
      for (const { from, until } of bar.pointRanges) count += until - from
      sameBars &&= previous?.bars?.get(start) === bar
    }
    const minimumNotional = Number(indicator.calcParams[0])
    const workerVersion = this.bubbleWorkers.version
    const sameSelection = sameBars && count === this.displayedBubbleCount && previous?.settings === display.settings &&
        workerVersion === this.displayedBubbleVersion &&
        previous?.projectToCandle === display.projectToCandle && previous?.minimumNotional === minimumNotional &&
        previous?.contractValue === display.contractValue && previous?.lotSize === display.lotSize &&
        previous?.timeframe === display.timeframe && previous?.mode === display.mode
    let points: BubbleDisplay['points']
    if (activeBars && display.mode) {
      const mode = display.mode
      const { contractValue, lotSize, projectToCandle } = display
      const filter = { contractValue, lotSize, projectToCandle, ...bigTradeThreshold(this.bubbleSettings, minimumNotional) }
      const limit = this.bubbleSettings.maxBubbles
      const key = JSON.stringify([mode, filter, limit])
      points = (sameSelection && previous?.points) || selectVisibleTradeBubbles(activeBars, mode, filter, limit, bar => {
        const result = this.bubbleWorkers.get(bar, key, signal => parallelBubbles(bar, { mode, filter, limit }, signal))
        return result === null ? [] : result
      })
    }
    if (sameSelection && previous?.points === points && previous?.message === display.message && previous?.updating === display.updating) return
    if (previous?.points !== points) this.hideTooltip()
    this.displayedBubbleCount = count
    this.displayedBubbleVersion = workerVersion
    this.overrideIndicator.call(this.chart, { name: BIG_TRADES, extendData: { ...display, points, minimumNotional } }, CANDLE_PANE)
  }

  private footprint(): Indicator | undefined {
    return this.mainIndicator(FOOTPRINT)
  }

  private cvd(): [string, Indicator] | undefined {
    const panes = this.chart.getIndicatorByPaneId()
    if (!(panes instanceof Map)) return
    for (const [pane, indicators] of panes) {
      const indicator = (indicators as Map<string, Indicator>).get(CVD)
      if (indicator) return [pane, indicator]
    }
  }

  private showFootprint(rows?: FootprintDisplay['rows'], message?: string): void {
    const indicator = this.footprint()
    if (!indicator?.visible) return
    const previous = indicator.extendData as FootprintDisplay | undefined
    const shareCandleSpace = !!this.mainIndicator(CANDLE_VOLUME_PROFILE)?.visible
    if (previous?.settings === this.footprintSettings && previous.message === message &&
        previous.shareCandleSpace === shareCandleSpace && sameValues(previous.rows, rows)) return
    const display: FootprintDisplay = { rows, message, settings: this.footprintSettings, shareCandleSpace }
    this.overrideIndicator.call(this.chart, { name: FOOTPRINT, extendData: display }, CANDLE_PANE)
  }

  private showCvd(values?: CvdDisplay['values'], message?: string): void {
    const item = this.cvd()
    if (!item?.[1].visible) return
    const [pane, indicator] = item
    const previous = indicator.extendData as CvdDisplay | undefined
    if (previous?.settings === this.cvdSettings && previous?.message === message && sameValues(previous.values, values)) return
    const display: CvdDisplay = { values, message, settings: this.cvdSettings }
    this.overrideIndicator.call(this.chart, { name: CVD, extendData: display }, pane)
  }

  private readonly profileAxisInset = () => this.chart.getStyles().yAxis.inside
    ? this.chart.getSize(CANDLE_PANE, DomPosition.YAxis)?.width ?? 0 : 0

  private showCandleProfile(profiles?: CandleProfileDisplay['profiles'], message?: string): void {
    const indicator = this.mainIndicator(CANDLE_VOLUME_PROFILE)
    if (!indicator?.visible) return
    const precision = this.chart.getPriceVolumePrecision().price
    const previous = indicator.extendData as CandleProfileDisplay | undefined
    if (previous?.settings === this.candleProfileSettings && previous.precision === precision &&
        previous.message === message && sameValues(previous.profiles, profiles)) return
    const display: CandleProfileDisplay = { profiles, message, precision, settings: this.candleProfileSettings }
    this.overrideIndicator.call(this.chart, { name: CANDLE_VOLUME_PROFILE, extendData: display }, CANDLE_PANE)
  }

  private showVisibleProfile(rows?: VisibleProfileDisplay['rows'], message?: string): void {
    const indicator = this.mainIndicator(VISIBLE_VOLUME_PROFILE)
    if (!indicator) return
    const previous = indicator.extendData as VisibleProfileDisplay | undefined
    if (previous?.settings === this.visibleProfileSettings && previous.message === message && previous.rows?.length === rows?.length &&
        (rows?.every((row, index) => {
          const prior = previous?.rows?.[index]
          return prior?.low === row.low && prior.high === row.high && prior.buy === row.buy && prior.sell === row.sell
        }) ?? true)) return
    const display: VisibleProfileDisplay = {
      rows, message, axisInset: this.profileAxisInset, settings: this.visibleProfileSettings,
      prices: rows && volumeProfilePrices(rows, this.visibleProfileSettings.valueArea),
      precision: this.chart.getPriceVolumePrecision().price,
    }
    this.overrideIndicator.call(this.chart, { name: VISIBLE_VOLUME_PROFILE, extendData: display }, CANDLE_PANE)
  }

  private showVwap(values?: VwapDisplay['values'], message?: string): void {
    const indicator = this.mainIndicator(VWAP)
    if (!indicator) return
    const precision = this.chart.getPriceVolumePrecision().price
    const previous = indicator.extendData as VwapDisplay | undefined
    if (previous?.message === message && previous?.precision === precision && previous.values?.size === values?.size &&
        [...values ?? []].every(([timestamp, point]) => {
          const prior = previous.values?.get(timestamp)
          return prior?.price === point.price && prior.day === point.day
        })) return
    const display: VwapDisplay = { values, message, precision }
    this.overrideIndicator.call(this.chart, { name: VWAP, extendData: display }, CANDLE_PANE)
  }

  private syncOrderFlowSpacing(width: number | undefined, reserveRight: boolean): void {
    if (width === this.orderFlowBarSpace && reserveRight === this.reserveOrderFlowSpaceOnRight) return
    this.orderFlowBarSpace = width
    this.reserveOrderFlowSpaceOnRight = reserveRight
    if (width !== undefined) {
      if (this.previousBarSpace === undefined) {
        this.previousBarSpace = this.chart.getBarSpace()
        this.chart.setStyles({ candle: { footprint: true } })
      }
      this.setOrderFlowBarSpace(width, reserveRight)
    } else if (this.previousBarSpace !== undefined) {
      this.setOrderFlowBarSpace(this.previousBarSpace)
      this.previousBarSpace = undefined
      this.chart.setStyles({ candle: { footprint: false } })
    }
  }

  private setOrderFlowBarSpace(width: number, reserveRight = false): void {
    const offset = this.chart.getOffsetRightDistance()
    const liveEdge = this.chart.getVisibleRange().to === this.chart.getDataList().length
    this.chart.setBarSpace(width)
    if (liveEdge) {
      const paneWidth = this.chart.getSize(CANDLE_PANE, DomPosition.Main)?.width ?? Infinity
      this.chart.setOffsetRightDistance(reserveRight ? Math.min(paneWidth / 3, Math.max(offset, width / 2 - 6)) : offset)
    }
  }

  private projectPrices(candles: readonly KLineData[], timeframe: string, anchors: Map<number, number>) {
    if (this.feed.mapping?.relation !== 'etf') return (trade: BybitTrade) => trade.price
    const inputs = new Map(candles.map(bar => [bar.timestamp, bar.open]))
    return (trade: BybitTrade): number | undefined => {
      if (trade.venue) return trade.price
      const start = alignOpenTime(Math.floor(trade.timeUs / 1000), timeframe, 'floor')
      const open = inputs.get(start)
      if (open === undefined) return
      if (!anchors.has(start)) anchors.set(start, open / trade.price)
      return trade.price * anchors.get(start)!
    }
  }

  private showVolume(values?: Map<number, number>): boolean {
    if (this.nativePriceVolume) return false
    const panes = this.chart.getIndicatorByPaneId()
    if (!(panes instanceof Map)) return false
    const symbol = this.feed.mapping?.symbol
    const changed = values !== this.displayedVolumes || symbol !== this.volumeSymbol
    this.displayedVolumes = values
    this.volumeSymbol = symbol
    let visible = false
    const current = new Set<Indicator>()
    for (const [pane, indicators] of panes) {
      if (!(indicators instanceof Map)) continue
      for (const [name, indicator] of indicators as Map<string, Indicator>) {
        if (!volumeIndicators.has(name)) continue
        current.add(indicator)
        visible ||= indicator.visible
        if (!this.nativeVolume.has(indicator)) this.nativeVolume.set(indicator,
          { calc: indicator.calc, shortName: name === 'VOL' ? '报价量' : indicator.shortName, precision: indicator.precision })
        const native = this.nativeVolume.get(indicator)!
        const source = this.feed.mapping?.okx ? (this.feed.mapping.bybit ? 'OKX / Bybit' : 'OKX') : 'Bybit'
        const shortName = symbol ? (name === 'VOL' ? `${source} 成交量` : `${native.shortName} · ${source}`) : native.shortName
        if (changed || indicator.shortName !== shortName) {
          const calc = symbol ? bybitVolumeCalc(native.calc, values) : native.calc
          this.overrideIndicator.call(this.chart, { name, calc, precision: symbol && name === 'VOL' ? 3 : native.precision,
            shortName }, pane)
        }
      }
    }
    for (const indicator of this.nativeVolume.keys()) if (!current.has(indicator)) this.nativeVolume.delete(indicator)
    return visible
  }

  private visibleCandles(): KLineData[] {
    const candles = this.chart.getDataList()
    const { from, to } = this.chart.getVisibleRange()
    return candles.slice(Math.max(0, from), Math.max(0, to))
  }

  private flowCandles(dayOf?: (timestamp: number) => number): KLineData[] {
    const candles = this.chart.getDataList()
    const { from, to } = this.chart.getVisibleRange()
    let start = dayOf ? Math.max(0, Math.min(candles.length, from)) : 0
    if (dayOf && candles[start]) {
      const day = dayOf(candles[start].timestamp)
      while (start > 0 && dayOf(candles[start - 1].timestamp) === day) start--
    }
    return candles.slice(start, Math.min(candles.length, to + 1))
  }

  private cvdDay(timeframe: string, cursor: number): ((timestamp: number) => number) | undefined {
    if (this.cvdSettings.reset !== 'daily') return
    return timestamp => Math.floor((Math.min(cursor, nextOpenTime(timestamp, timeframe) * 1000) - 1) / (BYBIT_DAY_MS * 1000))
  }

  private vwapDay(timeframe: string, cursor: number): (timestamp: number) => number {
    return timestamp => tradeDay(Math.min(cursor, nextOpenTime(timestamp, timeframe) * 1000))
  }

  private displayFlow(timeframe: string, mode: BigTradeMode, read: (start: number, until: number) => TradeBar | undefined,
    allTrades: boolean, message?: string): void {
    const cursor = this.feed.tradeCursorUs
    const bars = new Map<number, TradeBar>()
    const volumes = new Map<number, number>()
    const footprints = new Map<number, FootprintRow[]>()
    const candleProfiles = new Map<number, VolumeProfile>()
    const footprintEnabled = this.footprint()?.visible
    const candleProfileEnabled = allTrades && this.mainIndicator(CANDLE_VOLUME_PROFILE)?.visible
    const profileEnabled = allTrades && this.mainIndicator(VISIBLE_VOLUME_PROFILE)?.visible
    const projected = this.feed.mapping?.relation === 'etf'
    const cme = this.feed.localArchive?.source === 'databento-cme'
    const precision = cme ? DATABENTO_PRICE_PRECISION : this.chart.getPriceVolumePrecision().price
    const readCurrent = (timestamp: number) => {
      const target = Math.min(cursor, nextOpenTime(timestamp, timeframe) * 1000)
      return target > timestamp * 1000 ? read(timestamp, target) : undefined
    }
    let partial = false
    let footprintPending = false
    const visible = this.visibleCandles()
    for (const { timestamp, open, high, low } of visible) {
      const bar = readCurrent(timestamp)
      if (!bar) continue
      bars.set(timestamp, bar)
      if (bar.firstPrice !== undefined) volumes.set(timestamp, bar.volume)
      partial ||= !bar.complete
      if (candleProfileEnabled && bar.firstPrice !== undefined) {
        const levels = tradeBarProfileLevels(bar, open, projected)
        if (!this.candleProfiles.has(levels)) {
          const { rows, valueArea } = this.candleProfileSettings
          this.candleProfiles.set(levels, levels.profile(rows, valueArea))
        }
        const profile = this.candleProfiles.get(levels)
        if (profile) candleProfiles.set(timestamp, profile)
      }
      if (footprintEnabled && bar.firstPrice !== undefined) {
        const settings = this.footprintSettings
        let targetRows = settings.targetRows
        if (settings.grouping === 'auto' && settings.showText) {
          const [top, bottom] = this.chart.convertToPixel([{ value: high }, { value: low }], { paneId: CANDLE_PANE }) as { y?: number }[]
          if (top.y !== undefined && bottom.y !== undefined) {
            targetRows = Math.max(1, Math.min(targetRows, Math.floor(Math.abs(top.y - bottom.y) / (settings.fontSize + 2))))
          }
        }
        let cached = this.footprintRows.get(bar)
        if (!cached || cached.open !== open || cached.precision !== precision || cached.projected !== projected || cached.targetRows !== targetRows) {
          const key = JSON.stringify([open, precision, projected, targetRows])
          const computed = this.footprintWorkers.get(bar, key, signal => parallelFootprint(bar,
            { open, firstBybitPrice: bar.firstBybitPrice, projected, precision, settings }, targetRows, signal))
          if (computed === null) { footprintPending = true; continue }
          const rows = computed ?? calculateFootprint(bar, settings, precision, trade => tradeBubblePrice(trade, bar, open, projected), targetRows)
          cached = { open, precision, projected, targetRows, rows }
          this.footprintRows.set(bar, cached)
        }
        footprints.set(timestamp, cached.rows)
      }
    }
    this.footprintWorkers.retain(new Set(footprintEnabled ? bars.values() : undefined))
    const previous = this.displayedVolumes
    const volumeChanged = previous?.size !== volumes.size || [...volumes].some(([start, volume]) => previous?.get(start) !== volume)
    this.showVolume(volumeChanged ? volumes : previous)
    const missingHistory = cme ? '请通过「按锚点加载」补齐本地逐笔日档'
      : this.feed.localArchive ? '请通过「下载成交数据」补齐本地逐笔归档' : '历史逐笔可通过「下载成交数据」载入'
    const status = message ?? (this.updating ? '正在计算逐笔成交…' : partial ? missingHistory : undefined)
    const unit = this.bubbleSettings.thresholdUnit
    const contractValue = this.feed.mapping?.okx?.contractValue
    const lotSize = unit === 'lots' ? this.getLotSize() : undefined
    const unitMessage = cme && unit === 'notional' ? 'CME 日档仅含成交张数，请选择张数阈值'
      : unit === 'contracts' && !contractValue && !cme ? '此品种暂无 OKX 合约张数'
      : unit === 'lots' && !lotSize ? '此品种暂无可用于换算手数的 cTrader 规格'
        : unit === 'lots' && projected && !contractValue ? 'ETF 代理成交无法换算为当前品种手数' : undefined
    this.showBubbles({ bars: unit === 'notional' || allTrades ? bars : undefined, timeframe, mode,
      updating: this.updating, projectToCandle: projected, contractValue, lotSize, message: unitMessage ?? status, settings: this.bubbleSettings })
    if (footprintEnabled) this.showFootprint(footprints, status ?? (footprintPending ? '正在计算足迹…' : undefined))
    if (candleProfileEnabled) {
      this.showCandleProfile(candleProfiles, status ?? (candleProfiles.size ? undefined : '可见 K 线暂无成交'))
    }
    if (profileEnabled) {
      const pricedBars = visible.flatMap(({ timestamp, open }) => {
        const bar = bars.get(timestamp)
        return bar ? [{ bar, open }] : []
      })
      const rows = visibleVolumeProfile(pricedBars, projected, precision, this.visibleProfileSettings.rows)
      this.showVisibleProfile(rows, status ?? (rows.length ? undefined : '可见范围暂无成交'))
    }
    if (allTrades && this.mainIndicator(VWAP)?.visible) {
      const { values, partial: incompleteVwap } = dailyTradeVwap(this.flowCandles(this.vwapDay(timeframe, cursor)), timeframe, cursor, read, projected)
      this.showVwap(values, message ?? (this.updating ? '正在计算逐笔成交…' : incompleteVwap ? missingHistory : undefined))
    }
    if (this.cvd()?.[1].visible) {
      const until = (timestamp: number) => Math.min(cursor, nextOpenTime(timestamp, timeframe) * 1000)
      const dayOf = this.cvdDay(timeframe, cursor)
      let missingPrefix = false
      const values = cumulativeVolumeDelta(this.flowCandles(dayOf), timestamp => {
        const end = until(timestamp)
        if (end <= timestamp * 1000) return
        const from = dayOf ? Math.max(timestamp, dayOf(timestamp) * BYBIT_DAY_MS) : timestamp
        const bar = read(from, end)
        if (!bar?.complete) missingPrefix = true
        return bar
      }, !!dayOf, dayOf)
      this.showCvd(values, message ?? (this.updating ? '正在计算逐笔成交…' : missingPrefix ? missingHistory : undefined))
    }
  }

  private async updateFlow(): Promise<void> {
    const indicator = this.bubbleIndicator()
    const footprint = this.footprint()?.visible
    const candleProfile = this.mainIndicator(CANDLE_VOLUME_PROFILE)?.visible
    const cvd = this.cvd()?.[1].visible
    const profile = this.mainIndicator(VISIBLE_VOLUME_PROFILE)?.visible
    const vwap = this.mainIndicator(VWAP)?.visible
    const profileSpacing = Math.max(footprint ? this.footprintSettings.columnWidth : 0, candleProfile ? this.candleProfileSettings.columnWidth : 0)
    this.syncOrderFlowSpacing(this.supported && profileSpacing ? profileSpacing : undefined, this.supported && !!footprint && !candleProfile)
    if (!indicator?.visible) this.bubbleWorkers.retain(new Set())
    if (!footprint) this.footprintWorkers.retain(new Set())
    if (!this.supported) {
      this.showVolume()
      if (indicator?.visible) this.showBubbles({ message: '此品种暂无成交量' })
      this.showFootprint(undefined, unavailable)
      this.showCvd(undefined, unavailable)
      this.showCandleProfile(undefined, unavailable)
      this.showVisibleProfile(undefined, unavailable)
      this.showVwap(undefined, unavailable)
      this.hideTooltip()
      return
    }
    const showVolume = this.showVolume(this.displayedVolumes)
    const visible = this.visibleCandles()
    if (!visible.length) {
      this.bubbleWorkers.retain(new Set())
      this.footprintWorkers.retain(new Set())
      this.showCandleProfile()
      this.showVisibleProfile()
      this.showVwap()
      return
    }
    if (!indicator?.visible && !showVolume && !footprint && !cvd && !profile && !candleProfile && !vwap) return
    const timeframe = this.timeframe()
    const mode = bigTradeMode(indicator?.styles)
    const minimum = Number(indicator?.calcParams[0] ?? DEFAULT_BIG_TRADE_NOTIONAL)
    const quantityThreshold = indicator?.visible && this.bubbleSettings.thresholdUnit !== 'notional'
    const sampleMinimum = mode === 'aggregate' || footprint || cvd || profile || candleProfile || vwap || quantityThreshold ? 0 : minimum
    const source = this.feed.archiveCacheKey
    const key = JSON.stringify([source, sampleMinimum])
    const replaying = this.feed.replaying && !this.feed.localArchive
    if ((replaying ? this.replayFlow : this.flow)?.key !== key) {
      this.cancelFlow()
      this.flowSource = source
      const legacyKeys = CTRADER_TIMEFRAMES.map(period => JSON.stringify([source, period, sampleMinimum]))
      this.replayFlow = replaying ? new ReplayOrderFlow(key, sampleMinimum, legacyKeys) : undefined
      this.flow = replaying ? undefined : new OrderFlowBars(key, sampleMinimum)
    }
    const flow = this.flow
    const replay = this.replayFlow
    const cursor = this.feed.tradeCursorUs
    const read = (start: number, until: number) => replay?.read(start, until, this.feed) ?? flow?.read(start, until, this.feed)
    this.displayFlow(timeframe, mode, read, sampleMinimum === 0)
    if (this.flowOperation) {
      this.flowPending = true
      return
    }
    const operation = new AbortController()
    this.flowOperation = operation
    const update = (range?: TradeRange) => {
      if (operation.signal.aborted) return
      this.updating = range
      if (this.flowPaint !== undefined) return
      this.flowPaint = requestAnimationFrame(() => {
        this.flowPaint = undefined
        if (!operation.signal.aborted && this.hasCurrentCandles()) this.displayFlow(this.timeframe(), mode, read, sampleMinimum === 0)
      })
    }
    try {
      if (replay) {
        await replay.prepare(this.feed.downloadedDays, this.feed, operation.signal, update)
      } else {
        const candles = cvd ? this.flowCandles(this.cvdDay(timeframe, cursor)) : vwap ? this.flowCandles(this.vwapDay(timeframe, cursor)) : visible
        await flow?.load(candles.map(bar => bar.timestamp), timeframe, cursor, this.feed, operation.signal, update)
      }
    } catch (error) {
      if (!operation.signal.aborted) {
        this.cancelFlowPaint()
        this.updating = undefined
        if (this.hasCurrentCandles()) this.displayFlow(this.timeframe(), mode, read, sampleMinimum === 0, errorText(error))
      }
    } finally {
      if (this.flowOperation === operation) {
        this.updating = undefined
        this.flowOperation = undefined
        for (const range of this.flowInvalidations.splice(0)) this.invalidateFlow(range)
        if (this.flowPending) {
          this.flowPending = false
          this.schedule()
        }
      }
    }
  }

  private hideTooltip = () => { if (this.tooltip) this.tooltip.hidden = true }

  private hover = (event: PointerEvent): void => {
    if (!this.pane || !this.tooltip) return
    const indicator = this.bubbleIndicator()
    const display = indicator?.extendData as BubbleDisplay | undefined
    const mode = bigTradeMode(indicator?.styles)
    if (!indicator?.visible || !display?.points?.size || !display.timeframe || display.mode !== mode) { this.hideTooltip(); return }
    const minimum = Number(indicator.calcParams[0])
    const settings = display.settings ?? this.bubbleSettings
    const threshold = bigTradeThreshold(settings, minimum)
    const { left, top, width, height } = this.pane.getBoundingClientRect()
    const cursorX = event.clientX - left
    const cursorY = event.clientY - top
    let nearest: DisplayedTradeBubble | undefined
    let nearestDistance = Infinity
    const converted = this.chart.convertFromPixel([{ x: cursorX }], { paneId: CANDLE_PANE })
    const indexAtPointer = (Array.isArray(converted) ? converted[0] : converted)?.dataIndex
    if (indexAtPointer === undefined) { this.hideTooltip(); return }
    const candles = this.chart.getDataList()
    const largestRadius = settings.sizeByVolume ? settings.maxRadius : settings.fixedRadius
    const margin = Math.ceil((largestRadius + 3) / this.chart.getBarSpace()) + 1
    for (let index = Math.max(0, indexAtPointer - margin); index < Math.min(candles.length, indexAtPointer + margin + 1); index++) {
      const candle = candles[index]
      const points = display.points.get(candle.timestamp)
      const bar = display.bars?.get(candle.timestamp)
      if (!points || !bar) continue
      const end = nextOpenTime(candle.timestamp, display.timeframe)
      for (const bubble of points) {
        const { trade } = bubble
        const offset = tradeBubbleOffset(bubble, candle.timestamp, end)
        const price = tradeBubblePrice(trade, bar, candle.open, display.projectToCandle)
        const point = this.chart.convertToPixel({ dataIndex: index + offset, value: price }, { paneId: CANDLE_PANE }) as { x?: number; y?: number }
        const dx = Math.abs((point.x ?? Infinity) - cursorX)
        const dy = Math.abs((point.y ?? Infinity) - cursorY)
        const distance = settings.marker === 'square' ? Math.max(dx, dy) : settings.marker === 'diamond' ? dx + dy : Math.hypot(dx, dy)
        const radius = tradeBubbleRadius(bubble.amount, threshold, settings)
        if (point.y === undefined || point.y + radius < 0 || point.y - radius > height) continue
        if (distance < radius + 3 && distance < nearestDistance) { nearestDistance = distance; nearest = bubble }
      }
    }
    if (!nearest) { this.hideTooltip(); return }
    const { trade, count, amount } = nearest
    const aggregation = mode === 'aggregate' ? ` · ${count ?? 1} 笔` : ''
    const quantity = threshold.unit === 'contracts' || threshold.unit === 'lots'
      ? `${amount.toLocaleString('zh-CN', { maximumSignificantDigits: 10 })} ${bigTradeThresholdUnits[threshold.unit]} · ` : ''
    const suffix = trade.venue === 'CME' ? '' : ` · ${notional(trade).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} USDT`
    const price = trade.venue === 'CME' ? trade.price.toFixed(DATABENTO_CHART_PRICE_PRECISION) : trade.price
    this.tooltip.textContent = `${trade.venue ?? 'Bybit'} ${trade.side === 'buy' ? '主动买入' : '主动卖出'}${aggregation} · ${quantity}${trade.size} @ ${price}${suffix}`
    this.tooltip.style.left = `${Math.max(4, Math.min(width - 260, cursorX + 12))}px`
    this.tooltip.style.top = `${Math.max(4, cursorY - 30)}px`
    this.tooltip.hidden = false
  }
}
