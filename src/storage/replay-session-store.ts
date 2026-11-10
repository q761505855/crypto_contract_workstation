import type { ReplaySession } from '../replay/models'
import { openWorkstationDatabase } from './market-data-store'
import { simulationSessionRange } from './simulation-state-store'

export interface ReplaySessionStore {
  put(session: ReplaySession): Promise<void>
  update(session: ReplaySession): Promise<void>
  delete(id: string): Promise<void>
  get(id: string): Promise<ReplaySession | undefined>
  list(): Promise<ReplaySession[]>
  getLatestActive(): Promise<ReplaySession | undefined>
}

export class IndexedDbReplaySessionStore implements ReplaySessionStore {
  constructor(private readonly databaseName?: string) {}

  async put(session: ReplaySession): Promise<void> {
    const database = await openWorkstationDatabase(this.databaseName)
    await database.put('replaySessions', session)
  }

  async update(session: ReplaySession): Promise<void> {
    const database = await openWorkstationDatabase(this.databaseName)
    const transaction = database.transaction('replaySessions', 'readwrite')
    // Autosaves from another tab may arrive after the session was deleted.
    if (await transaction.store.getKey(session.id) !== undefined) {
      await Promise.all([transaction.store.put(session), transaction.done])
    } else {
      await transaction.done
    }
  }

  async delete(id: string): Promise<void> {
    const database = await openWorkstationDatabase(this.databaseName)
    const transaction = database.transaction(
      ['replaySessions', 'simulationStates', 'simulationTrades', 'simulationLedger'],
      'readwrite',
    )
    const range = simulationSessionRange(id)
    await Promise.all([
      transaction.objectStore('replaySessions').delete(id),
      transaction.objectStore('simulationStates').delete(id),
      ...(['simulationTrades', 'simulationLedger'] as const).map(async (name) => {
        const store = transaction.objectStore(name)
        const keys = await store.index('by-session-time').getAllKeys(range)
        await Promise.all(keys.map((key) => store.delete(key)))
      }),
      transaction.done,
    ])
  }

  async get(id: string): Promise<ReplaySession | undefined> {
    const database = await openWorkstationDatabase(this.databaseName)
    return database.get('replaySessions', id)
  }

  async list(): Promise<ReplaySession[]> {
    const database = await openWorkstationDatabase(this.databaseName)
    const sessions = await database.getAllFromIndex(
      'replaySessions',
      'by-updated-at',
    )
    return sessions.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async getLatestActive(): Promise<ReplaySession | undefined> {
    const sessions = await this.list()
    return sessions.find((session) => session.active)
  }
}
