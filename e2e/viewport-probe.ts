import type { Page } from '@playwright/test'
import type { KLineData } from 'klinecharts'

/** Isolated browser-test instrumentation; no production globals are added. */
export async function installViewportProbe(page: Page) {
  await page.route('**/src/chart/pro-chart-adapter.ts*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    await route.fulfill({ response, body: `${source}\nconst probeMount = ProChartAdapter.prototype.mount;
const probeHistory = ProChartAdapter.prototype.loadChartHistory;
ProChartAdapter.prototype.loadChartHistory = async function(...args) {
  const events=window.__viewportEvents ??= [], seq=this.reloadSequence;
  events.push({type:'history-start',seq,period:args[1].text,from:args[2],to:args[3],notify:args[4]});
  try { const rows=await probeHistory.call(this,...args); events.push({type:'history-end',seq,current:this.reloadSequence,period:args[1].text,count:rows.length});return rows; }
  catch(error){events.push({type:'history-error',seq,error:String(error)});throw error;}
};
ProChartAdapter.prototype.mount = function(options) {
  window.__viewportEvents = [];
  probeMount.call(this, options); window.__viewportTestAdapter = this;
  const core = this.coreChart, adapter = this, events = window.__viewportEvents;
  for (const [owner, name] of [[this.datafeed.service,'loadCachedCandles'],[this.datafeed.service,'loadReplayCandles'],[this.datafeed.service?.store,'getCandles'],[this.datafeed.service?.store,'putCandles']]) {
    if (!owner || typeof owner[name] !== 'function') continue;
    const original=owner[name]; owner[name]=async function(...args){const started=performance.now();events.push({type:name+'-start',seq:adapter.reloadSequence,period:args[2],from:args[3],to:args[4]});try{const result=await original.apply(this,args);events.push({type:name+'-end',seq:adapter.reloadSequence,count:result?.length,ms:Math.round(performance.now()-started)});return result;}catch(error){events.push({type:name+'-error',error:String(error)});throw error;}};
  }
  const apply = core.applyNewData, scroll = core.scrollToTimestamp;
  core.applyNewData = function(rows, ...args) { window.__viewportRows = rows; events.push({type:'apply', first:rows[0]?.timestamp, last:rows.at(-1)?.timestamp, seq:adapter.reloadSequence}); return apply.call(this, rows, ...args); };
  core.scrollToTimestamp = function(time, ...args) { events.push({type:'scroll', time, seq:adapter.reloadSequence}); return scroll.call(this,time,...args); };
  core.subscribeAction('onDataReady', () => events.push({type:'ready', same:core.getDataList()===window.__viewportRows, seq:adapter.reloadSequence, pending:!!adapter.cancelPosition}));
};\n` })
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
