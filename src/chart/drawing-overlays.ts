import type { ActionType, Chart, Overlay, OverlayCreate } from 'klinecharts'
import { drawingIndexAt, drawingTimeAt } from './drawing-coordinates'
import { hasDrawingPoints, isDrawingTool, sameDrawingData, type ChartDrawing, type DrawingStore } from './drawings'
import { VOLUME_PROFILE_TOOL } from './order-flow'
import type { OrderFlowChart } from './order-flow-chart'

const GROUP = 'drawing_tools'
const PANE = 'candle_pane'
const DATA_READY = 'onDataReady' as ActionType

interface CoreOverlay extends Overlay {
  forceComplete(): void
  isDrawing(): boolean
}

export class DrawingOverlays {
  private scope: string | null = null
  private unsubscribe?: () => void
  private readonly rendered = new Map<string, ChartDrawing>()
  private grid = ''
  private epoch?: string
  private draft?: string
  private editing?: { id: string; x?: number; moved: boolean }
  private queued = false
  private disposed = false
  private applying = false
  private appearance: Pick<Partial<OverlayCreate>, 'visible' | 'lock' | 'mode'> = {}
  private readonly create: Chart['createOverlay']
  private readonly override: Chart['overrideOverlay']

  constructor(private readonly chart: Chart, private readonly store: DrawingStore, private readonly period: () => string,
    private readonly orderFlow?: OrderFlowChart) {
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
      if (typeof draft === 'string') this.draft = draft
      return draft
    }
    chart.overrideOverlay = value => {
      if (!value.id && !value.groupId && !value.name &&
          (value.visible !== undefined || value.lock !== undefined || value.mode !== undefined)) {
        this.appearance = { ...this.appearance, ...value }
        this.override.call(chart, { ...value, groupId: GROUP })
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

  dispose(): void {
    this.disposed = true
    this.unsubscribe?.()
    this.chart.unsubscribeAction(DATA_READY, this.dataReady)
    this.chart.createOverlay = this.create
    this.chart.overrideOverlay = this.override
    this.removeAll()
  }

  private removeAll(): void {
    this.applying = true
    try { this.chart.removeOverlay({ groupId: GROUP }) }
    finally { this.applying = false }
    this.rendered.clear()
    this.draft = this.editing = undefined
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
        const { id, name, scope, styles } = drawing
        if (name === VOLUME_PROFILE_TOOL && !this.orderFlow?.supported) continue
        if (this.editing?.id === id) continue
        const existing = this.chart.getOverlayById(id) as CoreOverlay | null
        if (existing && !reproject && sameDrawingData(this.rendered.get(id), drawing)) continue
        const points = drawing.points.map(({ timestamp, value }) => {
          const dataIndex = drawingIndexAt(candles, timestamp, period)
          return candles[dataIndex]?.timestamp === timestamp ? { timestamp, dataIndex, value } : { dataIndex, value }
        })
        if (existing) {
          this.override.call(this.chart, { id, points, styles })
          if (existing.isDrawing()) existing.forceComplete()
        } else {
          // The native open-ended wave uses the chart's single draft slot.
          if (name === 'anyWaves' && this.draft) continue
          const result = this.create.call(this.chart, { id, name, styles, groupId: GROUP, points,
            ...this.appearance, ...this.callbacks(id, scope) }, PANE)
          if (!result) continue
          const overlay = this.chart.getOverlayById(id) as CoreOverlay | null
          if (overlay?.isDrawing()) {
            overlay.forceComplete()
            const core = this.chart as Chart & { getChartStore(): { getOverlayStore(): { progressInstanceComplete(): void } } }
            core.getChartStore().getOverlayStore().progressInstanceComplete()
          }
        }
        this.rendered.set(id, drawing)
        if (name === VOLUME_PROFILE_TOOL) this.orderFlow?.setProfile(id, drawing.points)
      }
    } finally { this.applying = false }
  }

  private callbacks(id: string, scope: string): Partial<OverlayCreate> {
    return {
      onDrawing: ({ overlay }) => { this.previewProfile(overlay); return false },
      onDrawEnd: ({ overlay }) => {
        if (this.draft === id) this.draft = undefined
        if (this.scope === scope) {
          if (hasDrawingPoints(overlay.name, overlay.points.length)) this.capture(overlay, scope, true)
          else this.chart.removeOverlay(id)
        }
        this.queue()
        return false
      },
      onPressedMoveStart: ({ x }) => { this.editing = { id, x, moved: false }; return false },
      onPressedMoving: ({ overlay }) => {
        if (this.editing?.id === id) this.editing.moved = true
        this.previewProfile(overlay)
        return false
      },
      onPressedMoveEnd: ({ overlay, x }) => {
        const edit = this.editing
        if (edit?.id === id) {
          this.editing = undefined
          if (edit.moved && this.scope === scope) {
            const keepTime = x !== undefined && edit.x !== undefined && Math.abs(x - edit.x) < 1
            this.capture(overlay, scope, false, keepTime)
          } else this.queue()
        }
        return false
      },
      onRemoved: () => {
        this.orderFlow?.removeProfile(id)
        if (this.draft === id) this.draft = undefined
        if (!this.applying && this.scope === scope) this.write(this.store.remove(id, this.epoch))
        this.queue()
        return false
      },
    }
  }

  private previewProfile(overlay: Overlay): void {
    if (overlay.name !== VOLUME_PROFILE_TOOL || !this.orderFlow) return
    queueMicrotask(() => {
      if (this.disposed || !this.chart.getOverlayById(overlay.id)) return
      if (this.draft !== overlay.id && this.editing?.id !== overlay.id) return
      const points = this.readPoints(overlay)
      if (points) this.orderFlow?.setProfile(overlay.id, points)
    })
  }

  private readPoints(overlay: Overlay, keepTime = false): ChartDrawing['points'] | undefined {
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
      return { timestamp, value: point.value }
    })
    if (points.some(point => !Number.isSafeInteger(point.timestamp) || !Number.isFinite(point.value))) return
    return points as ChartDrawing['points']
  }

  private capture(overlay: Overlay, scope: string, isNew: boolean, keepTime = false): void {
    const points = this.readPoints(overlay, keepTime)
    if (!points) return
    const previous = this.rendered.get(overlay.id)
    const drawing = { id: overlay.id, name: overlay.name, scope, points,
      ...(overlay.styles !== null ? { styles: overlay.styles } : {}) }
    if (overlay.name === VOLUME_PROFILE_TOOL) this.orderFlow?.setProfile(overlay.id, points)
    this.write(isNew ? this.store.save(drawing, this.epoch) : this.store.edit(drawing, this.epoch, previous), !isNew)
  }

  private write(write: Promise<void>, reproject = false): void {
    void write.catch(() => window.alert('无法保存绘图，请检查浏览器存储空间后重试。')).finally(() => {
      if (reproject) { this.grid = ''; this.queue() }
    })
  }
}
