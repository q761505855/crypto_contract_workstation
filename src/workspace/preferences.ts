import { writePreference } from '../storage/preference-events'

export const WORKSPACE_PREFERENCES_KEY = 'workspace.layout.v1'

export interface WorkspacePreferences {
  schemaVersion: 1
  panels: {
    account: boolean
    order: boolean
    dock: boolean
    replay: boolean
    status: boolean
  }
  chartHeight: number | null
  mobileChartHeight: number | null
  dockHeight: number
}

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = Object.freeze({
  schemaVersion: 1,
  panels: Object.freeze({ account: true, order: true, dock: true, replay: true, status: true }),
  chartHeight: null,
  mobileChartHeight: null,
  dockHeight: 220,
})

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function panel(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`workspace.panels.${field} 必须是布尔值`)
  return value
}

function height(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`workspace.${field} 必须是 ${min}–${max} 的整数`)
  }
  return value
}

export function validateWorkspacePreferences(value: unknown): WorkspacePreferences {
  const item = record(value, 'workspace')
  if (item.schemaVersion !== 1) throw new Error('workspace.schemaVersion 不受支持')
  const panels = record(item.panels, 'workspace.panels')
  return {
    schemaVersion: 1,
    panels: {
      account: panel(panels.account, 'account'),
      order: panel(panels.order, 'order'),
      dock: panel(panels.dock, 'dock'),
      replay: panel(panels.replay, 'replay'),
      status: panel(panels.status, 'status'),
    },
    chartHeight: item.chartHeight === null ? null : height(item.chartHeight, 'chartHeight', 280, 1600),
    mobileChartHeight: item.mobileChartHeight === null ? null : height(item.mobileChartHeight, 'mobileChartHeight', 280, 1600),
    dockHeight: height(item.dockHeight, 'dockHeight', 160, 480),
  }
}

export function loadWorkspacePreferences(storage?: Pick<Storage, 'getItem'>): WorkspacePreferences {
  try {
    const local = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    const saved = local?.getItem(WORKSPACE_PREFERENCES_KEY)
    if (saved != null) return validateWorkspacePreferences(JSON.parse(saved))
  } catch {
    // Damaged or inaccessible device storage must not prevent the workspace from opening.
  }
  return validateWorkspacePreferences(DEFAULT_WORKSPACE_PREFERENCES)
}

export function saveWorkspacePreferences(value: WorkspacePreferences, storage?: Pick<Storage, 'setItem'>): void {
  const validated = validateWorkspacePreferences(value)
  const local = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  if (local) writePreference(local, WORKSPACE_PREFERENCES_KEY, JSON.stringify(validated))
}
