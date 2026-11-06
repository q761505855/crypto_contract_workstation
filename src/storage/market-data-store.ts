import { openDB, unwrap, type DBSchema, type IDBPDatabase } from 'idb'
import { findMissingRanges } from '../market-data/gaps'
import {
  EMPTY_SERIES_SUMMARY,
  type CandleKind,
  type MarketCandle,
  type MarketSymbol,
  type SeriesSummary,
} from '../market-data/models'
import type { ReplaySession } from '../replay/models'
import type {
  SimulationLedgerEntry,
  SimulationState,
  SimulationTrade,
} from '../simulation/models'

export type StoredSimulationTrade = SimulationTrade & {
  _sequence?: number
}

export type StoredSimulationLedgerEntry = SimulationLedgerEntry & {
  _sequence?: number
}

const DATABASE_NAME = 'crypto-contract-workstation'
const DATABASE_VERSION = 3

export interface WorkstationDatabase extends DBSchema {
  symbols: {
    key: string
    value: MarketSymbol
    indexes: {
      'by-onboard-date': number
    }
  }
  tradeCandles: {
    key: [string, string, number]
    value: MarketCandle
    indexes: {
      'by-series-time': [string, string, number]
    }
  }
  markCandles: {
    key: [string, string, number]
    value: MarketCandle
    indexes: {
      'by-series-time': [string, string, number]
    }
  }
  replaySessions: {
    key: string
    value: ReplaySession
    indexes: {
      'by-updated-at': number
    }
  }
  simulationStates: {
    key: string
    value: SimulationState
  }
  simulationTrades: {
    key: string
    value: StoredSimulationTrade
    indexes: {
      'by-session-time': [string, number]
    }
  }
  simulationLedger: {
    key: string
    value: StoredSimulationLedgerEntry
    indexes: {
      'by-session-time': [string, number]
    }
  }
}

const databasePromises = new Map<
  string,
  Promise<IDBPDatabase<WorkstationDatabase>>
>()

export function openWorkstationDatabase(
  databaseName = DATABASE_NAME,
): Promise<IDBPDatabase<WorkstationDatabase>> {
  let databasePromise = databasePromises.get(databaseName)
  if (databasePromise === undefined) {
    databasePromise = openDB<WorkstationDatabase>(
      databaseName,
      DATABASE_VERSION,
      {
        upgrade(database) {
          if (!database.objectStoreNames.contains('symbols')) {
            const symbols = database.createObjectStore('symbols', {
              keyPath: 'symbol',
            })
            symbols.createIndex('by-onboard-date', 'onboardDate')
          }
          if (!database.objectStoreNames.contains('tradeCandles')) {
            const tradeCandles = database.createObjectStore('tradeCandles', {
              keyPath: ['symbol', 'timeframe', 'openTime'],
            })
            tradeCandles.createIndex('by-series-time', [
              'symbol',
              'timeframe',
              'openTime',
            ])
          }
          if (!database.objectStoreNames.contains('markCandles')) {
            const markCandles = database.createObjectStore('markCandles', {
              keyPath: ['symbol', 'timeframe', 'openTime'],
            })
            markCandles.createIndex('by-series-time', [
              'symbol',
              'timeframe',
              'openTime',
            ])
          }
          if (!database.objectStoreNames.contains('replaySessions')) {
            const replaySessions = database.createObjectStore(
              'replaySessions',
              { keyPath: 'id' },
            )
            replaySessions.createIndex('by-updated-at', 'updatedAt')
          }
          if (!database.objectStoreNames.contains('simulationStates')) {
            database.createObjectStore('simulationStates', {
              keyPath: 'sessionId',
            })
          }
          if (!database.objectStoreNames.contains('simulationTrades')) {
            const trades = database.createObjectStore(
              'simulationTrades',
              { keyPath: 'tradeId' },
            )
            trades.createIndex('by-session-time', [
              'sessionId',
              'timestamp',
            ])
          }
          if (!database.objectStoreNames.contains('simulationLedger')) {
            const ledger = database.createObjectStore(
              'simulationLedger',
              { keyPath: 'entryId' },
            )
            ledger.createIndex('by-session-time', [
              'sessionId',
              'timestamp',
            ])
          }
        },
      },
    )
    databasePromises.set(databaseName, databasePromise)
  }
  return databasePromise
}

export interface MarketDataStore {
  putSymbols(symbols: readonly MarketSymbol[]): Promise<void>
  getSymbols(): Promise<MarketSymbol[]>
  putCandles(kind: CandleKind, candles: readonly MarketCandle[], signal?: AbortSignal): Promise<void>
  getCandles(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
    from: number,
    to: number,
  ): Promise<MarketCandle[]>
  getSeriesSummary(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
  ): Promise<SeriesSummary>
  deleteSeries(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
  ): Promise<void>
}

function storeName(kind: CandleKind): 'tradeCandles' | 'markCandles' {
  return kind === 'trade' ? 'tradeCandles' : 'markCandles'
}

function seriesRange(
  symbol: string,
  timeframe: string,
  from: number,
  to: number,
): IDBKeyRange {
  return IDBKeyRange.bound(
    [symbol.toUpperCase(), timeframe, from],
    [symbol.toUpperCase(), timeframe, to],
  )
}

function throwIfWriteCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('行情缓存写入已取消', 'AbortError')
}

export class IndexedDbMarketDataStore implements MarketDataStore {
  constructor(private readonly databaseName = DATABASE_NAME) {}

  async putSymbols(symbols: readonly MarketSymbol[]): Promise<void> {
    if (symbols.length === 0) {
      return
    }
    const database = await this.open()
    const transaction = database.transaction('symbols', 'readwrite')
    await Promise.all([
      ...symbols.map((symbol) => transaction.store.put(symbol)),
      transaction.done,
    ])
  }

  async getSymbols(): Promise<MarketSymbol[]> {
    const database = await this.open()
    const symbols = await database.getAll('symbols')
    return symbols.sort((left, right) => left.symbol.localeCompare(right.symbol))
  }

  async putCandles(
    kind: CandleKind,
    candles: readonly MarketCandle[],
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfWriteCancelled(signal)
    if (candles.length === 0) {
      return
    }
    const database = await this.open()
    throwIfWriteCancelled(signal)
    const name = storeName(kind)
    const transaction = database.transaction(name, 'readwrite')
    const done = transaction.done
    // Attach a rejection handler before an abort can occur, including when a
    // native put throws before control reaches the transaction completion await.
    void done.catch(() => undefined)
    const abort = () => {
      try { transaction.abort() } catch { /* Already completed or aborted. */ }
    }
    signal?.addEventListener('abort', abort, { once: true })
    let enqueueFailed = false
    let enqueueError: unknown
    // Keep at most one burst pending so cancellation does not have to clear a
    // month-sized queue. Enqueue synchronously inside the final success event
    // to keep the same atomic transaction active between bursts.
    try {
      throwIfWriteCancelled(signal)
      const native = unwrap(transaction.store)
      let offset = 0
      const enqueueBurst = () => {
        try {
          throwIfWriteCancelled(signal)
          const end = Math.min(offset + 1000, candles.length)
          let last: IDBRequest<IDBValidKey> | undefined
          while (offset < end) last = native.put(candles[offset++])
          if (offset < candles.length) {
            last!.addEventListener('success', enqueueBurst, { once: true })
          }
        } catch (error) {
          // This may run from a later request event, outside this async call's
          // stack. Preserve the original put error and let done settle first.
          enqueueFailed = true
          enqueueError = error
          abort()
        }
      }
      enqueueBurst()
      await done
    } catch (error) {
      abort()
      await done.catch(() => undefined)
      throwIfWriteCancelled(signal)
      if (enqueueFailed) throw enqueueError
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  async getCandles(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
    from: number,
    to: number,
  ): Promise<MarketCandle[]> {
    const database = await this.open()
    return database.getAllFromIndex(
      storeName(kind),
      'by-series-time',
      seriesRange(symbol, timeframe, from, to),
    )
  }

  async getSeriesSummary(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
  ): Promise<SeriesSummary> {
    const candles = await this.getCandles(
      kind,
      symbol,
      timeframe,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    )
    if (candles.length === 0) {
      return { ...EMPTY_SERIES_SUMMARY, gaps: [] }
    }
    const firstOpenTime = candles[0].openTime
    const lastOpenTime = candles.at(-1)!.openTime
    return {
      count: candles.length,
      firstOpenTime,
      lastOpenTime,
      gaps: findMissingRanges(
        candles,
        timeframe,
        firstOpenTime,
        lastOpenTime,
      ),
    }
  }

  async deleteSeries(
    kind: CandleKind,
    symbol: string,
    timeframe: string,
  ): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(storeName(kind), 'readwrite')
    await transaction.store.delete(seriesRange(symbol, timeframe, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER))
    await transaction.done
  }

  private open(): Promise<IDBPDatabase<WorkstationDatabase>> {
    return openWorkstationDatabase(this.databaseName)
  }
}

export { DATABASE_VERSION }
