import { validateReplayDetails, type ReplaySession, type ReplaySessionDetails } from '../replay/models'
import { openWorkstationDatabase } from './market-data-store'
import { simulationSessionRange } from './simulation-state-store'

export interface ReplaySessionStore {
  put(session: ReplaySession): Promise<void>
  update(session: ReplaySession): Promise<void>
  updateDetails(id: string, details: ReplaySessionDetails): Promise<ReplaySession>
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
    const previous = await transaction.store.get(session.id)
    if (previous !== undefined) {
      // A replay cursor may predate a name or notes edit from another tab.
      const { name: _name, notes: _notes, ...progress } = session
      const updated = { ...progress, ...validateReplayDetails(previous.name, previous.notes),
        updatedAt: Math.max(previous.updatedAt, session.updatedAt) }
      await Promise.all([transaction.store.put(updated), transaction.done])
    } else {
      await transaction.done
    }
  }

  async updateDetails(id: string, details: ReplaySessionDetails): Promise<ReplaySession> {
    const fields = validateReplayDetails(details.name, details.notes)
    const database = await openWorkstationDatabase(this.databaseName)
    const transaction = database.transaction('replaySessions', 'readwrite')
    const existing = await transaction.store.get(id)
    if (!existing) throw new Error('找不到所选回放会话')
    const session = { ...existing, ...fields, updatedAt: Date.now() }
    await Promise.all([transaction.store.put(session), transaction.done])
    return session
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
