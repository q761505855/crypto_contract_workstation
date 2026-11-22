import { DomPosition, type ActionType, type Chart, type Indicator, type KLineData } from 'klinecharts'
import { alignOpenTime, nextOpenTime } from '../market-data/intervals'
import type { BybitTrade } from '../market-data/bybit/trades'
import type { CombinedBybitSource, TradeRange } from '../market-data/bybit/combined-source'
import { BIG_TRADES, DEFAULT_BIG_TRADE_NOTIONAL, VolumeProfileAccumulator } from './order-flow'
import { CANDLE_PANE, tradeBubbleRadius, type BubbleDisplay, type ProfileDisplay } from './order-flow-renderers'
import type { DrawingPoint } from './drawings'

const dataReady = 'onDataReady' as ActionType
const visibleRangeChange = 'onVisibleRangeChange' as ActionType
const maxBubbles = 360
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

interface BubbleRequest {
  fromUs: number
  cursor: number
  minimum: number
  trades: BybitTrade[]
  timeframe: string
  chartStart: number
  operation?: AbortController
  complete: boolean
  volumes: Map<number, number>
  barPrices: Map<number, number>
  showBubbles: boolean
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
  private bubbles?: BubbleRequest
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

  refresh(reset = false): void {
    if (reset) {
      this.invalidateCoverage()
      this.showBubbles({ points: [] })
      this.showVolume()
    }
    this.schedule()
  }

  setProfile(id: string, points: readonly DrawingPoint[], preview = false): void {
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
    const cache = preview ? undefined : 'selection'
    if (existing?.low === low && existing.high === high && existing.range.fromUs === fromUs &&
        existing.range.untilUs === untilUs && existing.range.cache === cache) return
    this.removeProfile(id)
    this.profiles.set(id, {
      range: { fromUs, untilUs, cache }, low, high, cursor: fromUs, complete: true,
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
    this.bubbles?.operation?.abort()
    for (const id of this.profiles.keys()) this.removeProfile(id)
  }

  private invalidateCoverage(): void {
    this.bubbles?.operation?.abort()
    this.bubbles = undefined
    for (const request of this.profiles.values()) {
      request.operation?.abort()
      request.operation = undefined
      request.cursor = request.range.fromUs
      request.complete = true
      request.prices?.clear()
      request.accumulator = new VolumeProfileAccumulator(request.low, request.high)
    }
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
      const complete = await this.feed.visitTrades({ fromUs, untilUs, cache: request.range.cache }, trade => {
        const price = project(trade)
        if (price !== undefined && trade.timeUs >= request.cursor) request.accumulator.add(trade, price)
      }, operation.signal)
      operation.signal.throwIfAborted()
      request.cursor = untilUs
      request.complete &&= complete
      const profile = request.accumulator.profile()
      this.showProfile(id, { profile, message: request.complete ? (profile ? undefined : '选区暂无成交') : this.feed.status || '选区有缺失的 Bybit 成交' })
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
    this.overrideIndicator.call(this.chart, { name: BIG_TRADES, extendData: display }, CANDLE_PANE)
  }

  private projectPrices(candles: readonly KLineData[], timeframe: string, anchors: Map<number, number>) {
    const useEtfScale = this.feed.mapping?.relation === 'etf'
    const inputs = new Map(candles.map(bar => [bar.timestamp, bar.open]))
    return (trade: BybitTrade, start = alignOpenTime(Math.floor(trade.timeUs / 1000), timeframe, 'floor')): number | undefined => {
      if (!useEtfScale) return trade.price
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
        const shortName = symbol ? (name === 'VOL' ? this.feed.status || 'Bybit 成交量' : `${native.shortName} · Bybit`) : native.shortName
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

  private async updateBubbles(): Promise<void> {
    const indicator = this.chart.getIndicatorByPaneId(CANDLE_PANE, BIG_TRADES) as Indicator | null | undefined
    const candles = this.chart.getDataList()
    const { from, to } = this.chart.getVisibleRange()
    const first = candles[Math.max(0, from)]
    const last = candles[Math.min(candles.length, to) - 1]
    const showBubbles = !!indicator?.visible
    const showVolume = this.showVolume(this.bubbles?.volumes)
    if (!this.supported || (!showBubbles && !showVolume) || !first || !last) {
      if (!this.supported && showBubbles) this.showBubbles({ points: [], message: '此品种暂无 Bybit 成交量' })
      this.bubbles?.operation?.abort()
      this.bubbles = undefined
      this.hideTooltip()
      return
    }
    const timeframe = this.timeframe()
    const fromUs = first.timestamp * 1000
    const untilUs = Math.min(this.feed.tradeCursorUs, nextOpenTime(last.timestamp, timeframe) * 1000)
    const minimum = Number(indicator?.calcParams[0] ?? DEFAULT_BIG_TRADE_NOTIONAL)
    const chartStart = candles[0].timestamp
    let request = this.bubbles
    if (!request || request.minimum !== minimum || request.fromUs !== fromUs || request.cursor > untilUs ||
        request.timeframe !== timeframe || request.chartStart !== chartStart || request.showBubbles !== showBubbles) {
      request?.operation?.abort()
      request = { fromUs, cursor: fromUs, minimum, trades: [], complete: true, timeframe, chartStart,
        volumes: new Map(), barPrices: new Map(), showBubbles }
      this.bubbles = request
      this.showBubbles({ points: [], message: '读取可见成交…' })
    }
    if (request.operation || request.cursor >= untilUs) return
    const operation = new AbortController()
    request.operation = operation
    const current = request
    const candlesByTime = new Map(candles.map((candle, index) => [candle.timestamp, index]))
    const strongest = [...current.trades]
    const volumes = new Map(current.volumes)
    const project = this.projectPrices(candles, timeframe, current.barPrices)
    function reduceBubbles() { strongest.sort((a, b) => notional(b) - notional(a)); strongest.length = Math.min(strongest.length, maxBubbles) }
    try {
      const complete = await this.feed.visitTrades({ fromUs: current.cursor, untilUs, cache: 'viewport' }, trade => {
        const bar = alignOpenTime(Math.floor(trade.timeUs / 1000), timeframe, 'floor')
        if (!candlesByTime.has(bar)) return
        volumes.set(bar, (volumes.get(bar) ?? 0) + trade.size)
        project(trade, bar)
        if (showBubbles && notional(trade) >= minimum) {
          strongest.push(trade)
          if (strongest.length >= maxBubbles * 4) reduceBubbles()
        }
      }, operation.signal)
      operation.signal.throwIfAborted()
      if (this.bubbles !== current || this.chart.getDataList()[0]?.timestamp !== chartStart) return
      reduceBubbles()
      current.trades = strongest
      current.volumes = volumes
      this.showVolume(volumes)
      current.complete &&= complete
      current.cursor = untilUs
      const points: BubbleDisplay['points'] = []
      for (const trade of strongest.reverse()) {
        const timestamp = trade.timeUs / 1000
        const barStart = alignOpenTime(timestamp, timeframe, 'floor')
        const index = candlesByTime.get(barStart)
        const price = project(trade, barStart)
        if (index !== undefined && price !== undefined) {
          const offset = (timestamp - barStart) / (nextOpenTime(barStart, timeframe) - barStart) - 0.5
          points.push({ index, offset, trade, price })
        }
      }
      this.showBubbles({ points, message: current.complete ? undefined : this.feed.status || '部分 Bybit 逐笔成交尚未补齐' })
      if (this.feed.tradeCursorUs > untilUs && untilUs < nextOpenTime(last.timestamp, timeframe) * 1000) this.schedule()
    } catch (error) {
      if (!operation.signal.aborted) this.showBubbles({ points: [], message: errorText(error) })
    } finally { if (current.operation === operation) current.operation = undefined }
  }

  private hideTooltip = () => { if (this.tooltip) this.tooltip.hidden = true }

  private hover = (event: PointerEvent): void => {
    if (!this.pane || !this.tooltip) return
    const indicator = this.chart.getIndicatorByPaneId(CANDLE_PANE, BIG_TRADES) as Indicator | null | undefined
    const points = (indicator?.extendData as BubbleDisplay | undefined)?.points
    if (!indicator?.visible || !points?.length) { this.hideTooltip(); return }
    const { left, top, width } = this.pane.getBoundingClientRect()
    const cursorX = event.clientX - left
    const cursorY = event.clientY - top
    let nearest: BybitTrade | undefined
    let nearestDistance = Infinity
    // Project only the small set of rendered circles.
    for (const { index, offset, trade, price } of points) {
      const point = this.chart.convertToPixel({ dataIndex: index + offset, value: price }, { paneId: CANDLE_PANE }) as { x?: number; y?: number }
      const distance = Math.hypot((point.x ?? Infinity) - cursorX, (point.y ?? Infinity) - cursorY)
      const radius = tradeBubbleRadius(trade, Number(indicator.calcParams[0]))
      if (distance < radius + 3 && distance < nearestDistance) { nearestDistance = distance; nearest = trade }
    }
    if (!nearest) { this.hideTooltip(); return }
    this.tooltip.textContent = `Bybit ${nearest.side === 'buy' ? '主动买入' : '主动卖出'} · ${nearest.size} @ ${nearest.price} · ${notional(nearest).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} USDT`
    this.tooltip.style.left = `${Math.max(4, Math.min(width - 260, cursorX + 12))}px`
    this.tooltip.style.top = `${Math.max(4, cursorY - 30)}px`
    this.tooltip.hidden = false
  }
}
