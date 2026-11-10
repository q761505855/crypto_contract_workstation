import { normalizeSimulationStatePrices, type SimulationState } from '../simulation/models'
import { openWorkstationDatabase } from './market-data-store'

export interface SimulationStateStore {
  save(state: SimulationState): Promise<void>
  load(sessionId: string): Promise<SimulationState | undefined>
}

const MIN_TIME = Number.MIN_SAFE_INTEGER
const MAX_TIME = Number.MAX_SAFE_INTEGER

export function simulationSessionRange(sessionId: string): IDBKeyRange {
  return IDBKeyRange.bound(
    [sessionId, MIN_TIME],
    [sessionId, MAX_TIME],
  )
}

export class IndexedDbSimulationStateStore
  implements SimulationStateStore
{
  constructor(private readonly databaseName?: string) {}

  async save(state: SimulationState): Promise<void> {
    const database = await openWorkstationDatabase(this.databaseName)
    const transaction = database.transaction(
      ['replaySessions', 'simulationStates', 'simulationTrades', 'simulationLedger'],
      'readwrite',
    )
    // Check in the same transaction as the write so a late autosave cannot leave orphan rows.
    if (await transaction.objectStore('replaySessions').getKey(state.sessionId) === undefined) {
      await transaction.done
      return
    }
    const tradesStore = transaction.objectStore('simulationTrades')
    const ledgerStore = transaction.objectStore('simulationLedger')

    let tradeCursor = await tradesStore
      .index('by-session-time')
      .openCursor(simulationSessionRange(state.sessionId))
    while (tradeCursor !== null) {
      await tradeCursor.delete()
      tradeCursor = await tradeCursor.continue()
    }

    let ledgerCursor = await ledgerStore
      .index('by-session-time')
      .openCursor(simulationSessionRange(state.sessionId))
    while (ledgerCursor !== null) {
      await ledgerCursor.delete()
      ledgerCursor = await ledgerCursor.continue()
    }

    await transaction.objectStore('simulationStates').put({
      ...state,
      trades: [],
      ledger: [],
    })
    await Promise.all([
      ...state.trades.map((trade, index) =>
        tradesStore.put({ ...trade, _sequence: index }),
      ),
      ...state.ledger.map((entry, index) =>
        ledgerStore.put({ ...entry, _sequence: index }),
      ),
    ])
    await transaction.done
  }

  async load(sessionId: string): Promise<SimulationState | undefined> {
    const database = await openWorkstationDatabase(this.databaseName)
    const transaction = database.transaction(['simulationStates', 'simulationTrades', 'simulationLedger'])
    const state = await transaction.objectStore('simulationStates').get(sessionId)
    if (state === undefined) {
      return undefined
    }
    const range = simulationSessionRange(sessionId)
    const [trades, ledger] = await Promise.all([
      transaction.objectStore('simulationTrades').index('by-session-time').getAll(range),
      transaction.objectStore('simulationLedger').index('by-session-time').getAll(range),
      transaction.done,
    ])
    const orderedTrades = trades
      .sort(
        (left, right) =>
          (left._sequence ?? left.timestamp) -
          (right._sequence ?? right.timestamp),
      )
      .map(({ _sequence: _ignored, ...trade }) => trade)
    const orderedLedger = ledger
      .sort(
        (left, right) =>
          (left._sequence ?? left.timestamp) -
          (right._sequence ?? right.timestamp),
      )
      .map(({ _sequence: _ignored, ...entry }) => entry)
    return normalizeSimulationStatePrices({
      ...state,
      trades: orderedTrades,
      ledger: orderedLedger,
    })
  }
}
