import type { ReplaySession } from '../replay/models'
import { openWorkstationDatabase } from './market-data-store'

export interface ReplaySessionStore {
  put(session: ReplaySession): Promise<void>
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
