import type { Page } from '@playwright/test'
import type { KLineData } from 'klinecharts'

/** Enabled in both the dev server and the isolated Pages smoke-test build. */
export async function installViewportProbe(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, { __enableViewportProbe: true })
  })
  return () => page.evaluate(() => {
    const adapter = (window as unknown as { __viewportTestAdapter: {
      getRightmostVisibleCandleTime(): number | null
      getPeriod(): { text: string }
      coreChart: { getDataList(): KLineData[] }
      datafeed: { getReplayContext?(): unknown }
      chart: { cancelHistoryRequests?: () => void }
      viewportRestore: unknown
      reloadSequence: number
    } }).__viewportTestAdapter
    const rows = adapter.coreChart.getDataList()
    return { rightmost: adapter.getRightmostVisibleCandleTime(), period: adapter.getPeriod().text,
      last: rows.at(-1), timestamps: rows.map(row => row.timestamp), events: (window as unknown as { __viewportEvents: unknown[] }).__viewportEvents.slice(-60),
      debug: { context: adapter.datafeed.getReplayContext?.(), cancellation: typeof adapter.chart.cancelHistoryRequests, restore: adapter.viewportRestore, sequence: adapter.reloadSequence } }
  })
}
