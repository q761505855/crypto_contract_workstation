import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  WORKSPACE_PREFERENCES_KEY,
  loadWorkspacePreferences,
  saveWorkspacePreferences,
  validateWorkspacePreferences,
  type WorkspacePreferences,
} from './preferences'

const defaults: WorkspacePreferences = {
  schemaVersion: 1,
  panels: { account: true, order: true, dock: true, replay: true, status: true },
  chartHeight: null,
  mobileChartHeight: null,
  dockHeight: 220,
}

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('workspace preferences', () => {
  it('saves and reloads every panel, explicit false and automatic chart heights', () => {
    const local = storage()
    const value: WorkspacePreferences = {
      schemaVersion: 1,
      panels: { account: false, order: false, dock: false, replay: false, status: false },
      chartHeight: null, mobileChartHeight: 280, dockHeight: 480,
    }
    saveWorkspacePreferences(value, local)
    expect(JSON.parse(local.getItem(WORKSPACE_PREFERENCES_KEY)!)).toEqual(value)
    expect(loadWorkspacePreferences(local)).toEqual(value)
    const loaded = loadWorkspacePreferences(local)
    loaded.panels.order = true
    expect(loadWorkspacePreferences(local).panels.order).toBe(false)
    expect(validateWorkspacePreferences(value)).not.toBe(value)
    expect(validateWorkspacePreferences(value).panels).not.toBe(value.panels)
  })

  it('uses complete independent defaults for absent or damaged local data', () => {
    const local = storage()
    expect(loadWorkspacePreferences(local)).toEqual(defaults)
    for (const invalid of ['{', 'null', '{}', JSON.stringify({ ...defaults, mobileChartHeight: 0 })]) {
      local.setItem(WORKSPACE_PREFERENCES_KEY, invalid)
      const loaded = loadWorkspacePreferences(local)
      expect(loaded).toEqual(defaults)
      loaded.panels.account = false
      expect(loadWorkspacePreferences(local)).toEqual(defaults)
      expect(DEFAULT_WORKSPACE_PREFERENCES).toEqual(defaults)
    }
    expect(loadWorkspacePreferences({ getItem: () => { throw new Error('Unavailable') } })).toEqual(defaults)
  })

  it('handles a missing browser storage safely while still validating saves', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(loadWorkspacePreferences()).toEqual(defaults)
    expect(() => saveWorkspacePreferences(defaults)).not.toThrow()
    expect(() => saveWorkspacePreferences({ ...defaults, dockHeight: 0 })).toThrow(/workspace/)
  })

  it.each([
    null, [], {},
    { ...defaults, schemaVersion: 2 },
    { ...defaults, panels: {} },
    { ...defaults, panels: { ...defaults.panels, account: 0 } },
    { ...defaults, panels: { ...defaults.panels, order: null } },
    { ...defaults, panels: { ...defaults.panels, dock: undefined } },
    { ...defaults, panels: { ...defaults.panels, replay: 'false' } },
    { ...defaults, panels: { ...defaults.panels, status: 1 } },
    ...['chartHeight', 'mobileChartHeight'].flatMap(field =>
      [undefined, 0, 279, 1601, 300.5, '400', Number.NaN, Number.POSITIVE_INFINITY].map(value => ({ ...defaults, [field]: value }))),
    ...[undefined, null, 159, 481, 220.5, '220', Number.NaN].map(dockHeight => ({ ...defaults, dockHeight })),
  ])('rejects malformed values before replacing saved preferences (%j)', value => {
    const local = storage()
    saveWorkspacePreferences(defaults, local)
    expect(() => validateWorkspacePreferences(value)).toThrow(/workspace/)
    expect(() => saveWorkspacePreferences(value as WorkspacePreferences, local)).toThrow(/workspace/)
    expect(JSON.parse(local.getItem(WORKSPACE_PREFERENCES_KEY)!)).toEqual(defaults)
  })

  it.each([
    { chartHeight: 280, mobileChartHeight: 1600, dockHeight: 160 },
    { chartHeight: 1600, mobileChartHeight: null, dockHeight: 480 },
  ])('accepts inclusive height boundaries (%j)', dimensions => {
    expect(validateWorkspacePreferences({ ...defaults, ...dimensions })).toEqual({ ...defaults, ...dimensions })
  })
})
