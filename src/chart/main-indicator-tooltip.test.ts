import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(resolve('node_modules/klinecharts/dist/index.esm.js'), 'utf8')
function drawingMethod(owner: string, next: string) {
  const start = source.indexOf(`${owner}.prototype.drawImp = `) + `${owner}.prototype.drawImp = `.length
  const end = source.indexOf(`${owner}.prototype.${next}`, start)
  return runInNewContext(`(${source.slice(start, end).trim().replace(/;$/, '')})`, {
    isValid: (value: unknown) => value !== null && value !== undefined,
    TooltipShowType: { Standard: 'standard', Rect: 'rect' },
    TooltipShowRule: { None: 'none' },
  }) as (this: Record<string, unknown>, context: unknown) => void
}
const mainDraw = drawingMethod('CandleTooltipView', '_drawCandleStandardTooltip')
const subDraw = drawingMethod('IndicatorTooltipView', 'drawIndicatorTooltip')

describe('main indicator tooltip visibility', () => {
  it.each([
    ['standard', 'standard'], ['rect', 'rect'], ['standard', 'rect'], ['rect', 'standard'],
  ])('keeps candle prices and subpane legends for %s candle / %s indicator tooltips', (candleType, indicatorType) => {
    const tooltip = (showType: string) => ({ showRule: 'always', showType, offsetTop: 0, offsetLeft: 0, offsetRight: 0 })
    const styles = { candle: { tooltip: { ...tooltip(candleType), showIndicator: false } }, indicator: { tooltip: tooltip(indicatorType) } }
    const crosshair = { kLineData: { timestamp: 1 } }
    const store = {
      getStyles: () => styles, getTooltipStore: () => ({ getCrosshair: () => crosshair, getActiveIcon: () => null }),
      getDataList: () => [crosshair.kLineData], getPrecision: () => ({ price: 2, volume: 2 }),
      getLocale: () => 'zh-CN', getCustomApi: () => ({}), getThousandsSeparator: () => ',', getDecimalFoldThreshold: () => 3,
      getIndicatorStore: () => ({ getInstances: () => new Map() }), getTimeScaleStore: () => ({ getDateTimeFormat: () => ({}) }),
    }
    const pane = { getId: () => 'candle_pane', getChart: () => ({ getChartStore: () => store }), getYAxisWidget: () => ({ getBounding: () => ({ width: 50 }) }) }
    const drawn = { candle: false, main: false }
    const view = {
      getWidget: () => ({ getPane: () => pane, getBounding: () => ({ width: 800 }) }),
      isDrawTooltip: (_crosshair: unknown, value: { showRule: string }) => value.showRule === 'always',
      _drawCandleStandardTooltip: (...args: unknown[]) => { drawn.candle = (args.at(-1) as typeof styles.candle).tooltip.showRule === 'always'; return 0 },
      drawIndicatorTooltip: (...args: unknown[]) => { drawn.main = (args.at(-1) as typeof styles.indicator).tooltip.showRule === 'always'; return 0 },
      _drawRectTooltip: (...args: unknown[]) => { drawn.candle ||= args[12] as boolean; drawn.main ||= args[13] as boolean },
    }
    const original = structuredClone(styles)
    mainDraw.call(view, {})
    expect(drawn).toEqual({ candle: true, main: false })
    expect(styles).toEqual(original)
    const subTooltip = vi.fn()
    subDraw.call({ ...view, drawIndicatorTooltip: subTooltip }, {})
    expect(subTooltip.mock.lastCall?.at(-1)).toBe(styles.indicator)
    styles.candle.tooltip.showIndicator = true
    mainDraw.call(view, {})
    expect(drawn).toEqual({ candle: true, main: true })
  })
})
