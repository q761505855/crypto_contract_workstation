import { DomPosition, type ActionType, type Chart, type Indicator, type KLineData } from 'klinecharts'
import { alignOpenTime, CTRADER_TIMEFRAMES, nextOpenTime } from '../market-data/intervals'
import { BYBIT_DAY_MS, type BybitTrade } from '../market-data/bybit/trades'
import type { CombinedBybitSource, TradeRange } from '../market-data/bybit/combined-source'
import { BIG_TRADES, DEFAULT_BIG_TRADE_NOTIONAL, VolumeProfileAccumulator } from './order-flow'
import { CANDLE_PANE, tradeBubbleOffset, tradeBubblePrice, tradeBubbleRadius, type BubbleDisplay, type ProfileDisplay } from './order-flow-renderers'
import { OrderFlowBars, tradeBubbles, type TradeBar } from './order-flow-bars'
import { ReplayOrderFlow } from './order-flow-replay'
import type { DrawingPoint } from './drawings'

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
}

const notional = (trade: BybitTrade) => trade.price * trade.size
const errorText = (error: unknown) => error instanceof Error ? error.message : '读取逐笔成交失败'

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

  constructor(private readonly chart: Chart, private readonly feed: CombinedBybitSource, private readonly timeframe: () => string,
    private readonly hasCurrentCandles: () => boolean = () => true) {
    this.createIndicator = chart.createIndicator
    this.overrideIndicator = chart.overrideIndicator
    this.removeIndicator = chart.removeIndicator
    chart.createIndicator = (...args) => {
      const result = this.createIndicator.apply(chart, args)
      this.schedule()
      return result
    }
    chart.overrideIndicator = (...args) => {
      this.overrideIndicator.apply(chart, args)
      this.schedule()
    }
    chart.removeIndicator = (...args) => {
      this.removeIndicator.apply(chart, args)
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

  refresh(reset = false, affected?: TradeRange): void {
    if (reset) {
      if (affected) {
        if (this.flowOperation && !affected.replaceArchive && this.flowSource === this.feed.archiveCacheKey) {
          // REST and live updates must not restart an in-flight archive scan.
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
      accumulator: new VolumeProfileAccumulator(low, high),
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
      request.accumulator = new VolumeProfileAccumulator(request.low, request.high)
    }
  }

  private cancelFlow(): void {
    this.flowOperation?.abort()
    this.flowOperation = undefined
    this.flowPending = false
    this.flowInvalidations.length = 0
    this.updating = undefined
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
      void this.updateBubbles()
    }, 150)
  }

  private showProfile(id: string, display: ProfileDisplay): void {
    this.chart.overrideOverlay({ id, extendData: display })
  }

  private async updateProfile(id: string, request: ProfileRequest): Promise<void> {
    if (!this.supported || !this.hasCurrentCandles()) return
    const untilUs = Math.min(this.feed.tradeCursorUs, request.range.untilUs)
    if (untilUs < request.cursor) {
      request.operation?.abort()
      request.operation = undefined
      request.accumulator = new VolumeProfileAccumulator(request.low, request.high)
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
      const complete = await this.feed.visitTrades({ fromUs, untilUs }, trade => {
        const price = project(trade)
        if (price !== undefined && trade.timeUs >= request.cursor) request.accumulator.add(trade, price)
      }, operation.signal)
      operation.signal.throwIfAborted()
      request.cursor = untilUs
      request.complete &&= complete
      const profile = request.accumulator.profile()
      this.showProfile(id, { profile, message: request.complete ? (profile ? undefined : '选区暂无成交') : '选区的逐笔成交不完整' })
      if (Math.min(this.feed.tradeCursorUs, request.range.untilUs) > request.cursor) this.schedule()
    } catch (error) {
      // A retry must reprocess any partial range that was already accumulated.
      if (!operation.signal.aborted) {
        request.cursor = request.range.fromUs
        request.accumulator = new VolumeProfileAccumulator(request.low, request.high)
        request.complete = true
        this.showProfile(id, { message: errorText(error) })
      }
    } finally {
      if (request.operation === operation) request.operation = undefined
    }
  }

  private showBubbles(display: BubbleDisplay): void {
    const indicator = this.chart.getIndicatorByPaneId(CANDLE_PANE, BIG_TRADES) as Indicator | null | undefined
    if (!indicator) return
    const previous = indicator.extendData as BubbleDisplay | undefined
    let count = 0
    let sameBars = previous?.bars?.size === display.bars?.size
    for (const [start, bar] of display.bars ?? []) {
      for (const { from, until } of bar.pointRanges) count += until - from
      sameBars &&= previous?.bars?.get(start) === bar
    }
    if (sameBars && count === this.displayedBubbleCount &&
        previous?.message === display.message && previous?.projectToCandle === display.projectToCandle &&
        previous?.timeframe === display.timeframe && previous?.updating === display.updating) return
    this.displayedBubbleCount = count
    this.overrideIndicator.call(this.chart, { name: BIG_TRADES, extendData: display }, CANDLE_PANE)
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

  private displayFlow(timeframe: string, read: (start: number, until: number) => TradeBar | undefined, message?: string): void {
    const cursor = this.feed.tradeCursorUs
    const bars = new Map<number, TradeBar>()
    const volumes = new Map<number, number>()
    let partial = false
    for (const { timestamp } of this.visibleCandles()) {
      const target = Math.min(cursor, nextOpenTime(timestamp, timeframe) * 1000)
      if (target <= timestamp * 1000) break
      const bar = read(timestamp, target)
      if (!bar) continue
      bars.set(timestamp, bar)
      if (bar.firstPrice !== undefined) volumes.set(timestamp, bar.volume)
      partial ||= !bar.complete
    }
    const previous = this.displayedVolumes
    const volumeChanged = previous?.size !== volumes.size || [...volumes].some(([start, volume]) => previous?.get(start) !== volume)
    this.showVolume(volumeChanged ? volumes : previous)
    this.showBubbles({ bars, timeframe, updating: this.updating, projectToCandle: this.feed.mapping?.relation === 'etf',
      message: message ?? (this.updating ? '正在计算大单气泡…' : partial ? '逐笔成交尚未补齐 · 可在顶部下载日档' : undefined) })
  }

  private async updateBubbles(): Promise<void> {
    const indicator = this.chart.getIndicatorByPaneId(CANDLE_PANE, BIG_TRADES) as Indicator | null | undefined
    const visible = this.visibleCandles()
    if (!this.supported) {
      this.showVolume()
      if (indicator?.visible) this.showBubbles({ message: '此品种暂无成交量' })
      this.hideTooltip()
      return
    }
    const showVolume = this.showVolume(this.displayedVolumes)
    if ((!indicator?.visible && !showVolume) || !visible.length) return
    const timeframe = this.timeframe()
    const minimum = Number(indicator?.calcParams[0] ?? DEFAULT_BIG_TRADE_NOTIONAL)
    const source = this.feed.archiveCacheKey
    const key = JSON.stringify([source, minimum])
    const replaying = this.feed.replaying
    if ((replaying ? this.replayFlow : this.flow)?.key !== key) {
      this.cancelFlow()
      this.flowSource = source
      const legacyKeys = CTRADER_TIMEFRAMES.map(period => JSON.stringify([source, period, minimum]))
      this.replayFlow = replaying ? new ReplayOrderFlow(key, minimum, legacyKeys) : undefined
      this.flow = replaying ? undefined : new OrderFlowBars(key, minimum)
    }
    const flow = this.flow
    const replay = this.replayFlow
    const cursor = this.feed.tradeCursorUs
    const read = (start: number, until: number) => replay?.read(start, until, this.feed) ?? flow?.read(start, until)
    if (this.flowOperation) {
      this.flowPending = true
      return
    }
    this.displayFlow(timeframe, read)
    const operation = new AbortController()
    this.flowOperation = operation
    const update = (range?: TradeRange) => {
      if (operation.signal.aborted) return
      this.updating = range
      if (this.hasCurrentCandles()) this.displayFlow(this.timeframe(), read)
    }
    try {
      if (replay) {
        const days = new Set(this.feed.downloadedDays)
        const end = Math.min(cursor / 1000, nextOpenTime(visible.at(-1)!.timestamp, timeframe))
        this.feed.requestRecentHours(visible[0].timestamp, end)
        const firstDay = Math.floor(visible[0].timestamp / BYBIT_DAY_MS) * BYBIT_DAY_MS
        const lastDay = Math.ceil(end / BYBIT_DAY_MS - 1) * BYBIT_DAY_MS
        for (let day = lastDay; day >= firstDay; day -= BYBIT_DAY_MS) days.add(day)
        await replay.prepare(days, this.feed, operation.signal, update)
      } else {
        await flow?.load(visible.map(bar => bar.timestamp), timeframe, cursor, this.feed, operation.signal, update)
      }
    } catch (error) {
      if (!operation.signal.aborted) {
        this.updating = undefined
        if (this.hasCurrentCandles()) this.displayFlow(this.timeframe(), read, errorText(error))
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
    const indicator = this.chart.getIndicatorByPaneId(CANDLE_PANE, BIG_TRADES) as Indicator | null | undefined
    const display = indicator?.extendData as BubbleDisplay | undefined
    if (!indicator?.visible || !display?.bars?.size || !display.timeframe) { this.hideTooltip(); return }
    const { left, top, width } = this.pane.getBoundingClientRect()
    const cursorX = event.clientX - left
    const cursorY = event.clientY - top
    let nearest: BybitTrade | undefined
    let nearestDistance = Infinity
    const converted = this.chart.convertFromPixel([{ x: cursorX }], { paneId: CANDLE_PANE })
    const indexAtPointer = (Array.isArray(converted) ? converted[0] : converted)?.dataIndex
    if (indexAtPointer === undefined) { this.hideTooltip(); return }
    const candles = this.chart.getDataList()
    const margin = Math.ceil(23 / this.chart.getBarSpace()) + 1
    for (let index = Math.max(0, indexAtPointer - margin); index < Math.min(candles.length, indexAtPointer + margin + 1); index++) {
      const candle = candles[index]
      const bar = display.bars.get(candle.timestamp)
      if (!bar?.firstPrice) continue
      const end = nextOpenTime(candle.timestamp, display.timeframe)
      for (const bubble of tradeBubbles(bar)) {
        const { trade } = bubble
        const offset = tradeBubbleOffset(bubble, candle.timestamp, end)
        const price = tradeBubblePrice(trade, bar, candle.open, display.projectToCandle)
        const point = this.chart.convertToPixel({ dataIndex: index + offset, value: price }, { paneId: CANDLE_PANE }) as { x?: number; y?: number }
        const distance = Math.hypot((point.x ?? Infinity) - cursorX, (point.y ?? Infinity) - cursorY)
        const radius = tradeBubbleRadius(trade, Number(indicator.calcParams[0]))
        if (distance < radius + 3 && distance < nearestDistance) { nearestDistance = distance; nearest = trade }
      }
    }
    if (!nearest) { this.hideTooltip(); return }
    this.tooltip.textContent = `${nearest.venue ?? 'Bybit'} ${nearest.side === 'buy' ? '主动买入' : '主动卖出'} · ${nearest.size} @ ${nearest.price} · ${notional(nearest).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} USDT`
    this.tooltip.style.left = `${Math.max(4, Math.min(width - 260, cursorX + 12))}px`
    this.tooltip.style.top = `${Math.max(4, cursorY - 30)}px`
    this.tooltip.hidden = false
  }
}
