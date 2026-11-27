import { LineType, type ActionType, type Chart, type Overlay, type OverlayCreate } from 'klinecharts'
import { drawingIndexAt, drawingTimeAt } from './drawing-coordinates'
import { hasDrawingPoints, isDrawingTool, sameDrawingData, type ChartDrawing, type DrawingStore } from './drawings'
import { VOLUME_PROFILE_TOOL } from './order-flow'
import type { OrderFlowChart } from './order-flow-chart'
import { profileDisplayCenter, type ProfileDisplay } from './order-flow-renderers'
import { nextOpenTime } from '../market-data/intervals'
import { RISK_REWARD_TOOLS, riskRewardMetrics, riskRewardSide, type RiskRewardSide } from './risk-reward'

const GROUP = 'drawing_tools'
const PANE = 'candle_pane'
const DATA_READY = 'onDataReady' as ActionType

interface CoreOverlay extends Overlay {
  forceComplete(): void
  isDrawing(): boolean
}

export interface DrawingSelection {
  id: string
  locked: boolean
  allLocked: boolean
  color: string
  width: number
  pattern: LineType
}

export type DrawingChange =
  | { locked: boolean }
  | { color: string }
  | { width: number }
  | { pattern: LineType }

export interface DrawingDraft {
  name: string
  invalid?: boolean
}

function strokeGroup(name: string): 'line' | 'arc' | 'circle' | 'polygon' | 'rect' {
  if (name === 'circle' || name === 'fibonacciCircle') return 'circle'
  if (name === 'fibonacciSpiral') return 'arc'
  if (['rect', 'parallelogram', 'triangle'].includes(name)) return 'polygon'
  if (name === VOLUME_PROFILE_TOOL) return 'rect'
  return 'line'
}

export class DrawingOverlays {
  private scope: string | null = null
  private unsubscribe?: () => void
  private readonly rendered = new Map<string, ChartDrawing>()
  private grid = ''
  private epoch?: string
  private draft?: string
  private selectedId?: string
  private selection: DrawingSelection | null = null
  private readonly toolStyles = new WeakMap<Overlay, Overlay['styles']>()
  private editing?: { id: string; x?: number; lastX?: number; profilePrice?: number; wholeProfile?: boolean; moved: boolean; preview?: ChartDrawing['points'] }
  private queued = false
  private disposed = false
  private applying = false
  private appearance: Pick<Partial<OverlayCreate>, 'visible' | 'lock' | 'mode'> = {}
  private readonly create: Chart['createOverlay']
  private readonly override: Chart['overrideOverlay']

  constructor(private readonly chart: Chart, private readonly store: DrawingStore, private readonly period: () => string,
    private readonly orderFlow: OrderFlowChart | undefined, private readonly onSelection: (selection: DrawingSelection | null) => void,
    private readonly onDraftChange?: (draft: DrawingDraft | null) => void) {
    this.create = chart.createOverlay
    this.override = chart.overrideOverlay
    // The native toolbar sets the group for its shortcut, but omits it when
    // choosing a tool from a menu. Both paths must get the same group.
    chart.createOverlay = (value, pane) => {
      if (Array.isArray(value) || typeof value === 'string' || (value.groupId !== undefined && value.groupId !== GROUP) ||
          !isDrawingTool(value.name)) return this.create.call(chart, value, pane)
      const scope = this.scope
      if (scope === null || chart.getDataList().length === 0 || (value.name === VOLUME_PROFILE_TOOL && !this.orderFlow?.supported)) return null
      if (this.draft) chart.removeOverlay(this.draft)
      const id = `drawing-${crypto.randomUUID()}`
      const draft = this.create.call(chart, { ...this.appearance, ...value, groupId: GROUP, id, ...this.callbacks(id, scope) }, PANE)
      if (typeof draft === 'string') {
        this.setDraft(draft, value.name)
        const overlay = chart.getOverlayById(draft)
        if (overlay) this.toolStyles.set(overlay, structuredClone(overlay.styles))
        this.select()
      }
      return draft
    }
    chart.overrideOverlay = value => {
      if (!value.id && !value.groupId && !value.name &&
          (value.visible !== undefined || value.lock !== undefined || value.mode !== undefined)) {
        this.appearance = { ...this.appearance, ...value }
        this.override.call(chart, { ...value, groupId: GROUP })
        if (value.lock === false) {
          for (const { id, locked } of this.rendered.values()) {
            if (locked) this.override.call(chart, { id, lock: true })
          }
        }
        if (value.visible === false) {
          this.cancelRiskReward()
          this.select()
        }
        else this.publishSelection()
      } else this.override.call(chart, value)
    }
    this.unsubscribe = store.subscribe(this.queue)
    chart.subscribeAction(DATA_READY, this.dataReady)
  }

  setScope(scope: string | null): void {
    if (this.scope !== scope) {
      this.removeAll()
      this.scope = scope
    }
    this.refresh()
  }

  startVolumeProfile(): boolean {
    return this.chart.createOverlay({ name: VOLUME_PROFILE_TOOL }) !== null
  }

  startRiskReward(side: RiskRewardSide): boolean {
    return this.appearance.visible !== false && this.chart.createOverlay({ name: RISK_REWARD_TOOLS[side] }) !== null
  }

  cancelRiskReward(): void {
    if (this.draft && riskRewardSide(this.chart.getOverlayById(this.draft)?.name)) this.chart.removeOverlay(this.draft)
  }

  changeSelection(id: string, change: DrawingChange): void {
    if (this.selectedId !== id) return
    this.write(this.store.editAppearance(id, this.epoch, drawing => {
      if ('locked' in change) return { locked: change.locked }
      const group = strokeGroup(drawing.name)
      const line = group === 'line' || group === 'arc'
      const stroke = 'color' in change ? { [line ? 'color' : 'borderColor']: change.color }
        : 'width' in change ? { [line ? 'size' : 'borderSize']: change.width }
          : { [line ? 'style' : 'borderStyle']: change.pattern }
      return { styles: { ...drawing.styles, [group]: { ...drawing.styles?.[group], ...stroke } } }
    }))
  }

  deleteSelection(id: string): void {
    if (this.selectedId === id) this.chart.removeOverlay(id)
  }

  private select(id?: string): void {
    this.selectedId = id
    this.publishSelection()
  }

  private publishSelection(): void {
    const id = this.selectedId
    const drawing = id ? this.rendered.get(id) : undefined
    const overlay = id ? this.chart.getOverlayById(id) : null
    let next: DrawingSelection | null = null
    if (drawing && overlay?.visible) {
      const group = strokeGroup(drawing.name)
      const defaults = this.chart.getStyles().overlay
      const status = { id: drawing.id, locked: drawing.locked ?? false, allLocked: this.appearance.lock ?? false }
      if (group === 'line' || group === 'arc') {
        const { color, size, style } = { ...defaults[group], ...overlay.styles?.[group] }
        next = { ...status, color, width: size, pattern: style }
      } else {
        const { borderColor, borderSize, borderStyle } = { ...defaults[group], ...overlay.styles?.[group] }
        next = { ...status, color: borderColor, width: borderSize, pattern: borderStyle }
      }
    }
    if (!sameDrawingData(this.selection, next)) {
      this.selection = next
      this.onSelection(next)
    }
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe?.()
    this.chart.unsubscribeAction(DATA_READY, this.dataReady)
    this.chart.createOverlay = this.create
    this.chart.overrideOverlay = this.override
    this.removeAll()
  }

  private setDraft(id?: string, name?: string): void {
    this.draft = id
    this.onDraftChange?.(name ? { name } : null)
  }

  private removeAll(): void {
    this.applying = true
    try { this.chart.removeOverlay({ groupId: GROUP }) }
    finally { this.applying = false }
    this.rendered.clear()
    this.setDraft()
    this.editing = undefined
    this.select()
    this.grid = ''
  }

  private queue = (): void => {
    if (this.disposed || this.queued) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      if (!this.disposed) this.refresh()
    })
  }

  private gridKey(candles: ReturnType<Chart['getDataList']>, period: string): string {
    return `${period}:${candles.length}:${candles[0]?.timestamp}:${candles.at(-1)?.timestamp}`
  }

  private dataReady = (): void => {
    if (this.gridKey(this.chart.getDataList(), this.period()) !== this.grid) this.queue()
  }

  private refresh(): void {
    const candles = this.chart.getDataList()
    const period = this.period()
    const { local } = this.store.read()
    if (this.epoch !== local.epoch) {
      this.removeAll()
      this.epoch = local.epoch
    }
    const grid = this.gridKey(candles, period)
    const reproject = grid !== this.grid
    this.grid = grid
    const desired = new Map(local.drawings.filter(drawing => drawing.scope === this.scope).map(drawing => [drawing.id, drawing]))
    this.applying = true
    try {
      for (const id of this.rendered.keys()) {
        if (!desired.has(id)) {
          this.chart.removeOverlay(id)
          this.rendered.delete(id)
          if (this.editing?.id === id) this.editing = undefined
        }
      }
      if (candles.length === 0) return
      for (const drawing of desired.values()) {
        const { id, name, scope, styles, locked } = drawing
        if (name === VOLUME_PROFILE_TOOL && !this.orderFlow?.supported) continue
        if (this.editing?.id === id) continue
        const existing = this.chart.getOverlayById(id) as CoreOverlay | null
        const previous = this.rendered.get(id)
        if (existing && !reproject && sameDrawingData(previous, drawing)) continue
        const lock = Boolean(this.appearance.lock || locked)
        const center = name === VOLUME_PROFILE_TOOL ? profileDisplayCenter(existing?.extendData as ProfileDisplay | undefined) : undefined
        const points = drawing.points.map(({ timestamp, value }) => {
          const dataIndex = drawingIndexAt(candles, timestamp, period)
          const coordinates = { dataIndex, value: center ?? value }
          return candles[dataIndex]?.timestamp === timestamp ? { timestamp, ...coordinates } : coordinates
        })
        if (existing) {
          const stylesChanged = !sameDrawingData(previous?.styles, styles)
          if (stylesChanged && this.toolStyles.has(existing)) existing.styles = structuredClone(this.toolStyles.get(existing)!)
          this.override.call(this.chart, { id, points, lock, ...(stylesChanged && { styles }) })
          if (existing.isDrawing()) existing.forceComplete()
        } else {
          // The native open-ended wave uses the chart's single draft slot.
          if (name === 'anyWaves' && this.draft) continue
          const result = this.create.call(this.chart, { id, name, groupId: GROUP, points,
            ...this.appearance, lock, ...this.callbacks(id, scope) }, PANE)
          if (!result) continue
          const overlay = this.chart.getOverlayById(id) as CoreOverlay | null
          if (overlay) this.toolStyles.set(overlay, structuredClone(overlay.styles))
          if (styles) this.override.call(this.chart, { id, styles })
          if (overlay?.isDrawing()) {
            overlay.forceComplete()
            const core = this.chart as Chart & { getChartStore(): { getOverlayStore(): { progressInstanceComplete(): void } } }
            core.getChartStore().getOverlayStore().progressInstanceComplete()
          }
        }
        this.rendered.set(id, drawing)
        if (name === VOLUME_PROFILE_TOOL) this.orderFlow?.setProfile(id, drawing.points)
      }
    } finally {
      this.applying = false
      this.publishSelection()
    }
  }

  private callbacks(id: string, scope: string): Partial<OverlayCreate> {
    return {
      onDrawing: ({ overlay }) => { this.previewProfile(overlay); return false },
      onDrawEnd: ({ overlay }) => {
        if (this.draft === id) this.setDraft()
        if (this.scope === scope) {
          const complete = hasDrawingPoints(overlay.name, overlay.points.length)
          if (!complete || !this.capture(overlay, scope, true)) {
            this.chart.removeOverlay(id)
            if (complete && riskRewardSide(overlay.name)) this.onDraftChange?.({ name: overlay.name, invalid: true })
          }
        }
        this.queue()
        return false
      },
      onClick: ({ overlay }) => {
        if (!(overlay as CoreOverlay).isDrawing() && this.scope === scope) this.select(id)
        return false
      },
      onDeselected: () => {
        if (this.selectedId === id) this.select()
        return false
      },
      onPressedMoveStart: ({ overlay, x, figureKey }) => {
        const profilePrice = overlay.name === VOLUME_PROFILE_TOOL ? profileDisplayCenter(overlay.extendData as ProfileDisplay | undefined) : undefined
        this.editing = { id, x, lastX: x, profilePrice, wholeProfile: overlay.name === VOLUME_PROFILE_TOOL && !figureKey?.includes('point_'), moved: false }
        return false
      },
      onPressedMoving: ({ overlay, x }) => {
        const edit = this.editing
        if (edit?.id === id) {
          if (overlay.name === VOLUME_PROFILE_TOOL && x !== undefined && edit.lastX !== undefined && Math.abs(x - edit.lastX) < 1) return true
          edit.lastX = x
          edit.moved = true
        }
        this.previewProfile(overlay, x)
        return false
      },
      onPressedMoveEnd: ({ overlay, x }) => {
        const edit = this.editing
        if (edit?.id === id) {
          this.editing = undefined
          if (edit.moved && this.scope === scope) {
            const keepTime = x !== undefined && edit.x !== undefined && Math.abs(x - edit.x) < 1
            if (!this.capture(overlay, scope, false, keepTime, edit.preview)) {
              this.grid = ''
              this.queue()
            }
          } else this.queue()
        }
        return false
      },
      onRemoved: () => {
        this.orderFlow?.removeProfile(id)
        if (this.draft === id) this.setDraft()
        if (this.selectedId === id) this.select()
        if (!this.applying && this.scope === scope) this.write(this.store.remove(id, this.epoch))
        this.queue()
        return false
      },
    }
  }

  private previewProfile(overlay: Overlay, x?: number): void {
    if (overlay.name !== VOLUME_PROFILE_TOOL || !this.orderFlow) return
    queueMicrotask(() => {
      if (this.disposed || !this.chart.getOverlayById(overlay.id)) return
      const edit = this.editing?.id === overlay.id ? this.editing : undefined
      if (this.draft !== overlay.id && !edit) return
      const center = profileDisplayCenter(overlay.extendData as ProfileDisplay | undefined) ?? edit?.profilePrice
      if (center !== undefined) for (const point of overlay.points) point.value = center
      const keepTime = x !== undefined && edit?.x !== undefined && Math.abs(x - edit.x) < 1
      const points = this.readPoints(overlay, keepTime, edit?.wholeProfile)
      if (points) {
        if (edit) edit.preview = points
        const candles = this.chart.getDataList()
        const period = this.period()
        for (const [index, { timestamp }] of points.entries()) {
          const point = overlay.points[index]
          point.dataIndex = drawingIndexAt(candles, timestamp, period)
          point.timestamp = candles[point.dataIndex]?.timestamp === timestamp ? timestamp : undefined
        }
        this.orderFlow?.setProfile(overlay.id, points, true)
      }
    })
  }

  private readPoints(overlay: Overlay, keepTime = false, wholeProfile = false): ChartDrawing['points'] | undefined {
    const candles = this.chart.getDataList()
    if (!candles.length || !overlay.points.length) return
    const period = this.period()
    const previous = this.rendered.get(overlay.id)
    const points = overlay.points.map((point, index) => {
      const prior = previous?.points[index]
      const unchangedTime = prior && (keepTime || (typeof point.dataIndex === 'number' &&
        Math.abs(point.dataIndex - drawingIndexAt(candles, prior.timestamp, period)) < 1e-6))
      const timestamp = unchangedTime ? prior.timestamp : point.timestamp ??
        (typeof point.dataIndex === 'number' ? drawingTimeAt(candles, point.dataIndex, period) : undefined)
      // The existing drawing format includes a price. Keep that metadata stable for time-only edits.
      const value = overlay.name === VOLUME_PROFILE_TOOL && prior ? prior.value : point.value
      return { timestamp, value }
    })
    if (points.some(point => !Number.isSafeInteger(point.timestamp) || !Number.isFinite(point.value))) return
    const valid = points as ChartDrawing['points']
    if (overlay.name !== VOLUME_PROFILE_TOOL) return valid
    const first = candles[0].timestamp
    const last = nextOpenTime(candles.at(-1)!.timestamp, period)
    const low = Math.min(...valid.map(point => point.timestamp))
    const high = Math.max(...valid.map(point => point.timestamp))
    const shift = !wholeProfile ? 0 : low < first ? first - low : high > last ? last - high : 0
    return valid.map(point => ({ ...point, timestamp: Math.min(last, Math.max(first, point.timestamp + shift)) }))
  }

  private capture(overlay: Overlay, scope: string, isNew: boolean, keepTime = false, preview?: ChartDrawing['points']): boolean {
    const points = preview ?? this.readPoints(overlay, keepTime)
    if (!points) return false
    const side = riskRewardSide(overlay.name)
    if (side && (overlay.paneId !== PANE || !riskRewardMetrics(side, points))) return false
    const previous = this.rendered.get(overlay.id)
    const drawing = previous ? { ...previous, points } : { id: overlay.id, name: overlay.name, scope, points,
      ...(overlay.styles !== null ? { styles: structuredClone(overlay.styles) } : {}) }
    if (overlay.name === VOLUME_PROFILE_TOOL) this.orderFlow?.setProfile(overlay.id, points)
    this.write(isNew ? this.store.save(drawing, this.epoch) : this.store.edit(drawing, this.epoch, previous), !isNew)
    return true
  }

  private write(write: Promise<void>, reproject = false): void {
    void write.catch(() => window.alert('无法保存绘图，请检查浏览器存储空间后重试。')).finally(() => {
      if (reproject) { this.grid = ''; this.queue() }
    })
  }
}
