import type { OverlayCreate } from 'klinecharts'

import { browserStorageKey, ctraderStorage } from '../storage/ctrader-storage'
import { VOLUME_PROFILE_TOOL } from './order-flow'
import { RISK_REWARD_TOOLS, riskRewardMetrics, riskRewardSide } from './risk-reward'

export const DRAWING_STORAGE_KEY = 'chart.drawings.v1'
const DRAWINGS_CHANGED = 'workstation:drawings-changed'
const fixedPoints: Readonly<Record<string, number>> = Object.freeze({
  horizontalStraightLine: 1, verticalStraightLine: 1, priceLine: 1,
  horizontalRayLine: 2, horizontalSegment: 2, verticalRayLine: 2, verticalSegment: 2,
  straightLine: 2, rayLine: 2, segment: 2, arrow: 2, circle: 2, rect: 2,
  [VOLUME_PROFILE_TOOL]: 2,
  [RISK_REWARD_TOOLS.long]: 3, [RISK_REWARD_TOOLS.short]: 3,
  priceChannelLine: 3, parallelStraightLine: 3, parallelogram: 3, triangle: 3,
  fibonacciLine: 2, fibonacciSegment: 2, fibonacciCircle: 2, fibonacciSpiral: 2,
  fibonacciSpeedResistanceFan: 2, fibonacciExtension: 3, gannBox: 2,
  abcd: 4, xabcd: 5, threeWaves: 4, fiveWaves: 6, eightWaves: 9,
})

export interface DrawingPoint { timestamp: number; value: number }
export interface ChartDrawing {
  id: string
  scope: string
  name: string
  points: DrawingPoint[]
  styles?: NonNullable<OverlayCreate['styles']>
  locked?: boolean
}
type DrawingAppearance = Pick<ChartDrawing, 'styles' | 'locked'>
export interface DrawingArchive { epoch: string; drawings: ChartDrawing[] }
interface DrawingState { local: DrawingArchive; base: DrawingArchive; cloudBytes: number | null }
type DrawingStorage = Pick<Storage, 'getItem' | 'setItem'>

export const EMPTY_DRAWINGS: DrawingArchive = { epoch: 'initial', drawings: [] }

export function drawingScope(mode: 'live' | 'history', symbol: string, session: string | null, exchange?: string): string {
  if (mode === 'history' && session) return `replay:${session}`
  if (exchange === 'OKX') return `live:OKX:${symbol.toUpperCase()}`
  if (exchange === 'CME') return `live:CME:${symbol.toUpperCase()}`
  return exchange === 'CTRADER' ? `live:CTRADER:${symbol.toUpperCase()}` : `live:${symbol.toUpperCase()}`
}

export function isDrawingTool(name: string): boolean {
  return name === 'anyWaves' || Object.hasOwn(fixedPoints, name)
}

export function hasDrawingPoints(name: string, count: number): boolean {
  return name === 'anyWaves' ? count > 0 : count === fixedPoints[name]
}

function invalid(): never { throw new Error('绘图存档格式无效') }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const styleGroups = ['point', 'line', 'rect', 'polygon', 'circle', 'arc', 'text', 'rectText']
const textStyles = ['color', 'borderColor', 'activeColor', 'activeBorderColor', 'backgroundColor', 'family']
const sizeStyles = ['size', 'borderSize', 'radius', 'activeBorderSize', 'activeRadius', 'borderRadius',
  'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom']

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function styleValue(key: string, value: unknown): boolean {
  if (textStyles.includes(key)) return typeof value === 'string' && value.length <= 500
  if (sizeStyles.includes(key)) return nonnegative(value)
  if (key === 'weight') return nonnegative(value) || (typeof value === 'string' && value.length <= 100)
  if (key === 'smooth') return typeof value === 'boolean' || (nonnegative(value) && value <= 1)
  if (key === 'style') return ['solid', 'dashed', 'stroke', 'fill', 'stroke_fill'].some(style => style === value)
  if (key === 'borderStyle') return value === 'solid' || value === 'dashed'
  if (key === 'dashedValue' || key === 'borderDashedValue') return Array.isArray(value) && value.length <= 100 && value.every(nonnegative)
  return false
}

export function validateDrawings(value: unknown): ChartDrawing[] {
  if (!Array.isArray(value)) invalid()
  const seen = new Set<string>()
  return value.map((row: unknown) => {
    if (!object(row) || typeof row.id !== 'string' || !/^drawing-[\w-]{1,92}$/.test(row.id) || seen.has(row.id) ||
        typeof row.scope !== 'string' || !/^(live|replay):[^\x00-\x1f]{1,200}$/.test(row.scope) ||
        typeof row.name !== 'string' || !isDrawingTool(row.name) ||
        !Array.isArray(row.points) ||
        !hasDrawingPoints(row.name, row.points.length)) invalid()
    seen.add(row.id)
    const points = row.points.map((point: unknown) => {
      if (!object(point) || typeof point.timestamp !== 'number' || !Number.isSafeInteger(point.timestamp) ||
          Math.abs(point.timestamp) > 8.64e15 || typeof point.value !== 'number' || !Number.isFinite(point.value)) invalid()
      return { timestamp: point.timestamp, value: point.value }
    })
    const { id, scope, name, styles, locked } = row
    const side = riskRewardSide(name)
    if (side && !riskRewardMetrics(side, points)) invalid()
    if (locked !== undefined && typeof locked !== 'boolean') invalid()
    if (styles !== undefined && (!object(styles) || !Object.entries(styles).every(([group, entries]) => styleGroups.includes(group) &&
      object(entries) && Object.entries(entries).every(([key, value]) => styleValue(key, value))))) invalid()
    return { id, scope, name, points, ...(styles !== undefined && { styles: styles as ChartDrawing['styles'] }),
      ...(locked !== undefined && { locked }) }
  }).sort((a, b) => a.id.localeCompare(b.id))
}

export function validateDrawingArchive(value: unknown): DrawingArchive {
  if (!object(value) || typeof value.epoch !== 'string' || !/^[\w-]{1,100}$/.test(value.epoch)) invalid()
  return { epoch: value.epoch, drawings: validateDrawings(value.drawings) }
}

export function sameDrawingData(left: unknown, right: unknown): boolean {
  const stable = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
    object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
  return left === right || stable(left) === stable(right)
}

export function mergeDrawings(base: DrawingArchive, local: DrawingArchive, remote: DrawingArchive, resolution?: 'local' | 'remote'): {
  archive: DrawingArchive; conflicts: string[]
} {
  // A clear or full restore supersedes edits from the previous archive.
  if (local.epoch !== base.epoch) return { archive: local, conflicts: [] }
  if (remote.epoch !== base.epoch) return { archive: remote, conflicts: [] }
  const byId = (archive: DrawingArchive) => new Map(archive.drawings.map(drawing => [drawing.id, drawing]))
  const before = byId(base)
  const here = byId(local)
  const there = byId(remote)
  const ids = [...new Set([...here.keys(), ...there.keys()])].sort((a, b) => a.localeCompare(b))
  const conflicts: string[] = []
  const drawings = ids.flatMap(id => {
    const localDrawing = here.get(id)
    const remoteDrawing = there.get(id)
    let result = localDrawing
    if (!sameDrawingData(localDrawing, remoteDrawing)) {
      if (sameDrawingData(localDrawing, before.get(id))) result = remoteDrawing
      else if (!sameDrawingData(remoteDrawing, before.get(id))) {
        conflicts.push(id)
        if (resolution === 'remote') result = remoteDrawing
      }
    }
    return result ? [result] : []
  })
  return { archive: { epoch: base.epoch, drawings }, conflicts }
}

export class DrawingStore {
  constructor(private readonly storage: DrawingStorage = ctraderStorage) {}

  snapshot = (): string | null => this.storage.getItem(DRAWING_STORAGE_KEY)
  scopedKey = (key: string): string => browserStorageKey(this.storage, key)

  read(raw = this.snapshot()): DrawingState {
    try {
      if (raw !== null) {
        const state = JSON.parse(raw)
        const cloudBytes = state.cloudBytes
        if (cloudBytes !== null && (!Number.isSafeInteger(cloudBytes) || cloudBytes < 0)) invalid()
        const local = validateDrawingArchive(state.local)
        const base = state.base === undefined ? local : validateDrawingArchive(state.base)
        return { local, base, cloudBytes }
      }
    } catch { /* Keep charts usable if this device's cache is damaged. */ }
    return { local: EMPTY_DRAWINGS, base: EMPTY_DRAWINGS, cloudBytes: null }
  }

  forScope(scope: string | null): ChartDrawing[] {
    return this.read().local.drawings.filter(drawing => drawing.scope === scope)
  }

  save(drawing: ChartDrawing, epoch?: string): Promise<void> {
    return this.updateDrawing(drawing, false, epoch)
  }

  // Only edits to a still-present record are accepted after another window removes it.
  edit(drawing: ChartDrawing, epoch?: string, before?: ChartDrawing): Promise<void> {
    return this.updateDrawing(drawing, true, epoch, before)
  }

  editAppearance(id: string, epoch: string | undefined, change: (drawing: ChartDrawing) => DrawingAppearance): Promise<void> {
    return this.update(state => {
      if (epoch !== undefined && epoch !== state.local.epoch) return
      const current = state.local.drawings.find(drawing => drawing.id === id)
      if (!current) return
      const next = { ...current, ...change(current) }
      if (sameDrawingData(current, next)) return
      const drawings = validateDrawings(state.local.drawings.map(drawing => drawing.id === id ? next : drawing))
      return { ...state, local: { ...state.local, drawings } }
    })
  }

  private updateDrawing(drawing: ChartDrawing, edit: boolean, epoch?: string, before?: ChartDrawing): Promise<void> {
    return this.update(state => {
      if (epoch !== undefined && epoch !== state.local.epoch) return
      const previous = state.local.drawings.find(row => row.id === drawing.id)
      if (edit && previous === undefined) return
      const next = previous && before && previous.points.length === before.points.length ? {
        ...previous,
        points: drawing.points.map(({ timestamp, value }, index) => ({
          timestamp: timestamp === before.points[index]?.timestamp ? previous.points[index].timestamp : timestamp,
          value: value === before.points[index]?.value ? previous.points[index].value : value,
        })),
        styles: sameDrawingData(drawing.styles, before.styles) ? previous.styles : drawing.styles,
        locked: drawing.locked === before.locked ? previous.locked : drawing.locked,
      } : drawing
      const side = riskRewardSide(next.name)
      if (previous && before && side && !riskRewardMetrics(side, next.points) && riskRewardMetrics(side, drawing.points)) {
        next.points = previous.points
      }
      if (sameDrawingData(previous, next)) return
      const drawings = validateDrawings([...state.local.drawings.filter(row => row.id !== drawing.id), next])
      return { ...state, local: { ...state.local, drawings } }
    })
  }

  remove(id: string, epoch?: string): Promise<void> {
    return this.update(state => {
      if (epoch !== undefined && epoch !== state.local.epoch) return
      const drawings = state.local.drawings.filter(row => row.id !== id)
      if (drawings.length !== state.local.drawings.length) return { ...state, local: { ...state.local, drawings } }
    })
  }

  replace(drawings: ChartDrawing[]): Promise<void> {
    return this.update(state => ({ ...state, local: { epoch: crypto.randomUUID(), drawings: validateDrawings(drawings) } }))
  }

  async acceptCloud(base: DrawingArchive, cloudBytes: number, mergeLocal: (current: DrawingArchive) => DrawingArchive): Promise<DrawingArchive> {
    let local = base
    await this.update(state => {
      local = mergeLocal(state.local)
      return { base, local, cloudBytes }
    })
    return local
  }

  subscribe = (listener: () => void): (() => void) => {
    const drawingKey = this.scopedKey(DRAWING_STORAGE_KEY)
    const drawingEvent = this.scopedKey(DRAWINGS_CHANGED)
    const fromOtherWindow = (event: StorageEvent) => { if (event.key === drawingKey || event.key === null) listener() }
    window.addEventListener(drawingEvent, listener)
    window.addEventListener('storage', fromOtherWindow)
    return () => {
      window.removeEventListener(drawingEvent, listener)
      window.removeEventListener('storage', fromOtherWindow)
    }
  }

  private async update(change: (state: DrawingState) => DrawingState | undefined): Promise<void> {
    const apply = () => {
      const next = change(this.read())
      if (next) this.write(next)
    }
    // Chrome can run the drawing windows on different event loops. Keep the
    // local read plus write indivisible, independently of the network lock.
    if (navigator.locks?.request) await navigator.locks.request(this.scopedKey('workstation:drawing-storage'), apply)
    else apply()
  }

  private write(state: DrawingState): void {
    const { local, base, cloudBytes } = state
    const next = JSON.stringify({ local, ...(!sameDrawingData(local, base) ? { base } : {}), cloudBytes })
    if (this.snapshot() === next) return
    this.storage.setItem(DRAWING_STORAGE_KEY, next)
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(this.scopedKey(DRAWINGS_CHANGED)))
  }
}
