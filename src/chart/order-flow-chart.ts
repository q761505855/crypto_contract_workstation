import { DomPosition, type ActionType, type Chart, type Indicator, type KLineData } from 'klinecharts'
import { alignOpenTime, CTRADER_TIMEFRAMES, nextOpenTime } from '../market-data/intervals'
import type { BybitTrade } from '../market-data/bybit/trades'
import { BYBIT_DAY_MS } from '../market-data/bybit/trades'
import type { CombinedBybitSource, TradeRange } from '../market-data/bybit/combined-source'
import { BIG_TRADES, DEFAULT_BIG_TRADE_NOTIONAL, VolumeProfileAccumulator, bigTradeMode, type BigTradeMode } from './order-flow'
import { CANDLE_PANE, filteredTradeBubbles, tradeBubbleOffset, tradeBubblePrice, tradeBubbleRadius, type BubbleDisplay, type ProfileDisplay } from './order-flow-renderers'
import { OrderFlowBars, type TradeBar, type TradeBubble } from './order-flow-bars'
import { ReplayOrderFlow } from './order-flow-replay'
import type { DrawingPoint } from './drawings'
import { CVD, FOOTPRINT, bubblePreferenceDefaults, orderFlowSettings, withoutBubbleDefaults, type OrderFlowPreferences } from './order-flow-preferences'
import { calculateFootprint, cumulativeVolumeDelta, type FootprintRow } from './order-flow-metrics'
import type { CvdDisplay, FootprintDisplay } from './order-flow-indicators'

const dataReady = 'onDataReady' as ActionType
const visibleRangeChange = 'onVisibleRangeChange' as ActionType
const volumeIndicators = new Set(['VOL', 'AVP', 'OBV', 'PVT', 'VR', 'EMV'])

interface ProfileRequest {
  range: TradeRange
  low: number
  high: number
  cursor: number
  accumulator: VolumeProfileAccumulator
  prices?: Map<number, number>
  complete: boolean
  operation?: AbortController
  message?: string
}

const notional = (trade: BybitTrade) => trade.price * trade.size
const errorText = (error: unknown) => error instanceof Error ? error.message : '读取逐笔成交失败'
const unavailable = '此品种暂无逐笔成交'
const missingHistory = '历史逐笔可通过「下载成交数据」载入'

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
  private settings: OrderFlowPreferences | undefined
  private footprintSettings = orderFlowSettings('footprint')
  private bubbleSettings = orderFlowSettings('bubbles')
  private profileSettings = orderFlowSettings('profile')
  private cvdSettings = orderFlowSettings('cvd')
  private footprintRows = new WeakMap<TradeBar, { open: number; precision: number; projected: boolean; targetRows: number; rows: FootprintRow[] }>()
  private previousBarSpace?: number

  constructor(private readonly chart: Chart, private readonly feed: CombinedBybitSource, private readonly timeframe: () => string,
    private readonly hasCurrentCandles: () => boolean = () => true, private readonly nativePriceVolume = false) {
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

  private bubbleIndicator(): Indicator | undefined {
    return (this.chart.getIndicatorByPaneId(CANDLE_PANE, BIG_TRADES) as Indicator | null) ?? undefined
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
    const oldProfile = this.profileSettings
    const oldFootprint = this.footprintSettings
    this.settings = preferences
    this.profileSettings = orderFlowSettings('profile', preferences)
    this.footprintSettings = orderFlowSettings('footprint', preferences)
    this.bubbleSettings = orderFlowSettings('bubbles', preferences)
    this.cvdSettings = orderFlowSettings('cvd', preferences)
    this.footprintRows = new WeakMap()
    if (oldProfile.rows !== this.profileSettings.rows) {
      this.invalidateProfiles()
      for (const id of this.profiles.keys()) this.showProfile(id, { message: '读取区间成交…' })
    } else {
      for (const [id, request] of this.profiles) {
        this.showProfile(id, { profile: request.accumulator.profile(this.profileSettings.valueArea), message: request.message })
      }
    }
    if (this.previousBarSpace !== undefined && oldFootprint.columnWidth !== this.footprintSettings.columnWidth) {
      this.setFootprintBarSpace(this.footprintSettings.columnWidth)
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
      }
      if (affected?.replaceArchive || !this.replayFlow || !this.feed.replaying || this.flowSource !== this.feed.archiveCacheKey) this.cancelFlow()
      this.invalidateProfiles(affected)
    }
    this.schedule()
  }

  setProfile(id: string, points: readonly DrawingPoint[]): void {
    const [first, last] = points
    if (!first || !last) return
    const low = Math.min(first.value, last.value)
    const high = Math.max(first.value, last.value)
    if (low >= high) {
      this.removeProfile(id)
      this.showProfile(id, {})
      return
    }
    const fromUs = Math.min(first.timestamp, last.timestamp) * 1000
    const untilUs = (Math.max(first.timestamp, last.timestamp) + 1) * 1000
    const existing = this.profiles.get(id)
    if (existing?.low === low && existing.high === high && existing.range.fromUs === fromUs &&
        existing.range.untilUs === untilUs) return
    this.removeProfile(id)
    this.profiles.set(id, {
      range: { fromUs, untilUs }, low, high, cursor: fromUs, complete: true,
      accumulator: new VolumeProfileAccumulator(low, high, this.profileSettings.rows),
    })
    this.showProfile(id, { message: '读取区间成交…' })
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
      if (affected && (request.range.fromUs >= affected.untilUs || request.range.untilUs <= affected.fromUs)) continue
      request.operation?.abort()
      request.operation = undefined
      request.cursor = request.range.fromUs
      request.complete = true
      request.prices?.clear()
      request.accumulator = new VolumeProfileAccumulator(request.low, request.high, this.profileSettings.rows)
    }
  }

  private cancelFlow(): void {
    this.flowOperation?.abort()
    this.flowOperation = undefined
    this.cancelFlowPaint()
    this.flowPending = false
    this.flowInvalidations.length = 0
    this.updating = undefined
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
    this.chart.overrideOverlay({ id, extendData: { ...display, settings: this.profileSettings } })
  }

  private async updateProfile(id: string, request: ProfileRequest): Promise<void> {
    if (!this.supported || !this.hasCurrentCandles()) return
    const untilUs = Math.min(this.feed.tradeCursorUs, request.range.untilUs)
    if (untilUs < request.cursor) {
      request.operation?.abort()
      request.operation = undefined
      request.accumulator = new VolumeProfileAccumulator(request.low, request.high, this.profileSettings.rows)
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
    const operation = new AbortController()
    request.operation = operation
    try {
      const timeframe = this.timeframe()
      const fromUs = request.cursor === request.range.fromUs && this.feed.mapping?.relation === 'etf'
        ? alignOpenTime(request.cursor / 1000, timeframe, 'floor') * 1000 : request.cursor
      const project = this.projectPrices(this.chart.getDataList(), timeframe, request.prices ??= new Map())
      const accumulator = request.accumulator
      const complete = await this.feed.visitTrades({ fromUs, untilUs }, trade => {
        const price = project(trade)
        if (price !== undefined && trade.timeUs >= request.cursor) accumulator.add(trade, price)
      }, operation.signal)
      operation.signal.throwIfAborted()
      request.cursor = untilUs
      request.complete &&= complete
      const profile = request.accumulator.profile(this.profileSettings.valueArea)
      this.showProfile(id, { profile, message: request.complete ? (profile ? undefined : '选区暂无成交') : '选区的逐笔成交不完整' })
      if (Math.min(this.feed.tradeCursorUs, request.range.untilUs) > request.cursor) this.schedule()
    } catch (error) {
      // A retry must reprocess any partial range that was already accumulated.
      if (!operation.signal.aborted) {
        request.cursor = request.range.fromUs
        request.accumulator = new VolumeProfileAccumulator(request.low, request.high, this.profileSettings.rows)
        request.complete = true
        this.showProfile(id, { message: errorText(error) })
      }
    } finally {
      if (request.operation === operation) request.operation = undefined
    }
  }

  private showBubbles(display: BubbleDisplay): void {
    const indicator = this.bubbleIndicator()
    if (!indicator) return
    const previous = indicator.extendData as BubbleDisplay | undefined
    let count = 0
    let sameBars = previous?.bars?.size === display.bars?.size
    for (const [start, bar] of display.bars ?? []) {
      for (const { from, until } of bar.pointRanges) count += until - from
      sameBars &&= previous?.bars?.get(start) === bar
    }
    if (sameBars && count === this.displayedBubbleCount && previous?.settings === display.settings &&
        previous?.message === display.message && previous?.projectToCandle === display.projectToCandle &&
        previous?.timeframe === display.timeframe && previous?.updating === display.updating && previous?.mode === display.mode) return
    if (previous?.mode !== display.mode) this.hideTooltip()
    this.displayedBubbleCount = count
    this.overrideIndicator.call(this.chart, { name: BIG_TRADES, extendData: display }, CANDLE_PANE)
  }

  private footprint(): Indicator | undefined {
    return this.chart.getIndicatorByPaneId(CANDLE_PANE, FOOTPRINT) as Indicator | undefined
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
    if (previous?.settings === this.footprintSettings && previous?.message === message && sameValues(previous.rows, rows)) return
    const display: FootprintDisplay = { rows, message, settings: this.footprintSettings }
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

  private syncFootprintSpacing(enabled: boolean): void {
    if (enabled && this.previousBarSpace === undefined) {
      this.previousBarSpace = this.chart.getBarSpace()
      this.chart.setStyles({ candle: { footprint: true } })
      this.setFootprintBarSpace(this.footprintSettings.columnWidth)
    } else if (!enabled && this.previousBarSpace !== undefined) {
      this.setFootprintBarSpace(this.previousBarSpace)
      this.previousBarSpace = undefined
      this.chart.setStyles({ candle: { footprint: false } })
    }
  }

  private setFootprintBarSpace(width: number): void {
    const offset = this.chart.getOffsetRightDistance()
    const liveEdge = this.chart.getVisibleRange().to === this.chart.getDataList().length
    this.chart.setBarSpace(width)
    if (liveEdge) {
      const paneWidth = this.chart.getSize(CANDLE_PANE, DomPosition.Main)?.width ?? Infinity
      this.chart.setOffsetRightDistance(Math.min(paneWidth / 3, Math.max(offset, width / 2 - 6)))
    }
  }

  private projectPrices(candles: readonly KLineData[], timeframe: string, anchors: Map<number, number>) {
    const useEtfScale = this.feed.mapping?.relation === 'etf'
    const inputs = new Map(candles.map(bar => [bar.timestamp, bar.open]))
    return (trade: BybitTrade, start = alignOpenTime(Math.floor(trade.timeUs / 1000), timeframe, 'floor')): number | undefined => {
      if (!useEtfScale || trade.venue === 'OKX') return trade.price
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

  private cvdCandles(dayOf?: (timestamp: number) => number): KLineData[] {
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

  private displayFlow(timeframe: string, mode: BigTradeMode, read: (start: number, until: number) => TradeBar | undefined, message?: string): void {
    const cursor = this.feed.tradeCursorUs
    const bars = new Map<number, TradeBar>()
    const volumes = new Map<number, number>()
    const footprints = new Map<number, FootprintRow[]>()
    const footprintEnabled = this.footprint()?.visible
    const projected = this.feed.mapping?.relation === 'etf'
    const precision = this.chart.getPriceVolumePrecision().price
    const readCurrent = (timestamp: number) => {
      const target = Math.min(cursor, nextOpenTime(timestamp, timeframe) * 1000)
      return target > timestamp * 1000 ? read(timestamp, target) : undefined
    }
    let partial = false
    const visible = this.visibleCandles()
    for (const { timestamp, open, high, low } of visible) {
      const bar = readCurrent(timestamp)
      if (!bar) continue
      bars.set(timestamp, bar)
      if (bar.firstPrice !== undefined) volumes.set(timestamp, bar.volume)
      partial ||= !bar.complete
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
          const rows = calculateFootprint(bar, settings, precision, trade => tradeBubblePrice(trade, bar, open, projected), targetRows)
          cached = { open, precision, projected, targetRows, rows }
          this.footprintRows.set(bar, cached)
        }
        footprints.set(timestamp, cached.rows)
      }
    }
    const previous = this.displayedVolumes
    const volumeChanged = previous?.size !== volumes.size || [...volumes].some(([start, volume]) => previous?.get(start) !== volume)
    this.showVolume(volumeChanged ? volumes : previous)
    const status = message ?? (this.updating ? '正在计算逐笔成交…' : partial ? missingHistory : undefined)
    this.showBubbles({ bars, timeframe, mode, updating: this.updating, projectToCandle: projected, message: status, settings: this.bubbleSettings })
    if (footprintEnabled) this.showFootprint(footprints, status)
    if (this.cvd()?.[1].visible) {
      const until = (timestamp: number) => Math.min(cursor, nextOpenTime(timestamp, timeframe) * 1000)
      const dayOf = this.cvdDay(timeframe, cursor)
      let missingPrefix = false
      const values = cumulativeVolumeDelta(this.cvdCandles(dayOf), timestamp => {
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
    const cvd = this.cvd()?.[1].visible
    this.syncFootprintSpacing(this.supported && !!footprint)
    if (!this.supported) {
      this.showVolume()
      if (indicator?.visible) this.showBubbles({ message: '此品种暂无成交量' })
      this.showFootprint(undefined, unavailable)
      this.showCvd(undefined, unavailable)
      this.hideTooltip()
      return
    }
    const showVolume = this.showVolume(this.displayedVolumes)
    const visible = this.visibleCandles()
    if ((!indicator?.visible && !showVolume && !footprint && !cvd) || !visible.length) return
    const timeframe = this.timeframe()
    const mode = bigTradeMode(indicator?.styles)
    const minimum = Number(indicator?.calcParams[0] ?? DEFAULT_BIG_TRADE_NOTIONAL)
    const sampleMinimum = mode === 'aggregate' || footprint || cvd ? 0 : minimum
    const source = this.feed.archiveCacheKey
    const key = JSON.stringify([source, sampleMinimum])
    const replaying = this.feed.replaying
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
    this.displayFlow(timeframe, mode, read)
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
        if (!operation.signal.aborted && this.hasCurrentCandles()) this.displayFlow(this.timeframe(), mode, read)
      })
    }
    try {
      if (replay) {
        await replay.prepare(this.feed.downloadedDays, this.feed, operation.signal, update)
      } else {
        const candles = cvd ? this.cvdCandles(this.cvdDay(timeframe, cursor)) : visible
        await flow?.load(candles.map(bar => bar.timestamp), timeframe, cursor, this.feed, operation.signal, update)
      }
    } catch (error) {
      if (!operation.signal.aborted) {
        this.cancelFlowPaint()
        this.updating = undefined
        if (this.hasCurrentCandles()) this.displayFlow(this.timeframe(), mode, read, errorText(error))
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
    if (!indicator?.visible || !display?.bars?.size || !display.timeframe || display.mode !== mode) { this.hideTooltip(); return }
    const minimum = Number(indicator.calcParams[0])
    const settings = display.settings ?? this.bubbleSettings
    const { left, top, width } = this.pane.getBoundingClientRect()
    const cursorX = event.clientX - left
    const cursorY = event.clientY - top
    let nearest: TradeBubble | undefined
    let nearestDistance = Infinity
    const converted = this.chart.convertFromPixel([{ x: cursorX }], { paneId: CANDLE_PANE })
    const indexAtPointer = (Array.isArray(converted) ? converted[0] : converted)?.dataIndex
    if (indexAtPointer === undefined) { this.hideTooltip(); return }
    const candles = this.chart.getDataList()
    const margin = Math.ceil((settings.maxRadius + 3) / this.chart.getBarSpace()) + 1
    for (let index = Math.max(0, indexAtPointer - margin); index < Math.min(candles.length, indexAtPointer + margin + 1); index++) {
      const candle = candles[index]
      const bar = display.bars.get(candle.timestamp)
      if (!bar?.firstPrice) continue
      const end = nextOpenTime(candle.timestamp, display.timeframe)
      for (const bubble of filteredTradeBubbles(bar, mode, minimum, settings.maxNotional)) {
        const { trade } = bubble
        const offset = tradeBubbleOffset(bubble, candle.timestamp, end)
        const price = tradeBubblePrice(trade, bar, candle.open, display.projectToCandle)
        const point = this.chart.convertToPixel({ dataIndex: index + offset, value: price }, { paneId: CANDLE_PANE }) as { x?: number; y?: number }
        const dx = Math.abs((point.x ?? Infinity) - cursorX)
        const dy = Math.abs((point.y ?? Infinity) - cursorY)
        const distance = settings.marker === 'square' ? Math.max(dx, dy) : settings.marker === 'diamond' ? dx + dy : Math.hypot(dx, dy)
        const radius = tradeBubbleRadius(trade, minimum, settings)
        if (distance < radius + 3 && distance < nearestDistance) { nearestDistance = distance; nearest = bubble }
      }
    }
    if (!nearest) { this.hideTooltip(); return }
    const { trade, count } = nearest
    const aggregation = mode === 'aggregate' ? ` · ${count ?? 1} 笔` : ''
    this.tooltip.textContent = `${trade.venue ?? 'Bybit'} ${trade.side === 'buy' ? '主动买入' : '主动卖出'}${aggregation} · ${trade.size} @ ${trade.price} · ${notional(trade).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} USDT`
    this.tooltip.style.left = `${Math.max(4, Math.min(width - 260, cursorX + 12))}px`
    this.tooltip.style.top = `${Math.max(4, cursorY - 30)}px`
    this.tooltip.hidden = false
  }
}
