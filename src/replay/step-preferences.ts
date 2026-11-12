import { SUPPORTED_TIMEFRAMES, type MarketTimeframe } from '../market-data/intervals'
import { writePreference } from '../storage/preference-events'

export const REPLAY_STEP_PERIOD_KEY = 'replay.stepPeriod.v1'
export const DEFAULT_REPLAY_STEP_PERIOD: MarketTimeframe = '1m'

export function validateReplayStepPeriod(value: unknown): MarketTimeframe {
  if (typeof value !== 'string' || !SUPPORTED_TIMEFRAMES.includes(value)) {
    throw new Error('replayStepPeriod 必须是支持的步进周期')
  }
  return value as MarketTimeframe
}

export function readReplayStepPeriod(storage: Pick<Storage, 'getItem'> = localStorage): MarketTimeframe {
  try {
    const saved = storage.getItem(REPLAY_STEP_PERIOD_KEY)
    if (saved !== null) return validateReplayStepPeriod(JSON.parse(saved))
  } catch {
    // A damaged local preference falls back to the default period.
  }
  return DEFAULT_REPLAY_STEP_PERIOD
}

export function saveReplayStepPeriod(value: MarketTimeframe, storage: Pick<Storage, 'setItem'> = localStorage): void {
  writePreference(storage, REPLAY_STEP_PERIOD_KEY, JSON.stringify(validateReplayStepPeriod(value)))
}
