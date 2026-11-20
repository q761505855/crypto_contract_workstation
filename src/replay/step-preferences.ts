import { SUPPORTED_TIMEFRAMES } from '../market-data/intervals'
import { writePreference } from '../storage/preference-events'
import { ctraderStorage } from '../storage/ctrader-storage'
import { isFineStepPeriod, type ReplayStepPeriod } from './step-periods'

export const REPLAY_STEP_PERIOD_KEY = 'replay.stepPeriod.v1'
export const DEFAULT_REPLAY_STEP_PERIOD: ReplayStepPeriod = '1m'

export function validateReplayStepPeriod(value: unknown): ReplayStepPeriod {
  if (isFineStepPeriod(value)) return value
  if (typeof value !== 'string' || !SUPPORTED_TIMEFRAMES.includes(value)) {
    throw new Error('replayStepPeriod 必须是支持的步进周期')
  }
  return value as ReplayStepPeriod
}

export function readReplayStepPeriod(storage: Pick<Storage, 'getItem'> = ctraderStorage): ReplayStepPeriod {
  try {
    const saved = storage.getItem(REPLAY_STEP_PERIOD_KEY)
    if (saved !== null) return validateReplayStepPeriod(JSON.parse(saved))
  } catch {
    // A damaged local preference falls back to the default period.
  }
  return DEFAULT_REPLAY_STEP_PERIOD
}

export function saveReplayStepPeriod(value: ReplayStepPeriod, storage: Pick<Storage, 'setItem'> = ctraderStorage): void {
  writePreference(storage, REPLAY_STEP_PERIOD_KEY, JSON.stringify(validateReplayStepPeriod(value)))
}
