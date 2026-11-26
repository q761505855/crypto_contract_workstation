import type { BybitTrade } from './bybit/trades'
import type { ChartPriceMarket } from './ctrader-datafeed'

export interface LocalArchiveMarket extends ChartPriceMarket {
  readonly source: 'okx-local' | 'databento-cme'
  readonly historyRevision: number
  subscribeArchives(listener: () => void): () => void
  activeDays(symbol: string): readonly string[]
  setActiveDays(symbol: string, days: readonly string[], append?: boolean): boolean
  clearActiveDays(): void
  archiveDay(timestamp: number): string
  archiveDayStart(day: string): number
  tradeDays(symbol: string): Promise<Set<string>>
  visitTrades(symbol: string, from: number, to: number, accept: (trade: BybitTrade) => unknown, signal: AbortSignal,
    onCoverage?: (from: number, to: number, found: boolean) => void): Promise<boolean>
  visitPriceSizes(symbol: string, from: number, to: number, accept: (batch: Float64Array<ArrayBuffer>) => Promise<void>,
    signal: AbortSignal): Promise<boolean>
}
