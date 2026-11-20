import { isCTraderTimeframe, type CTraderTimeframe, type MarketTimeframe } from '../market-data/intervals'

export const SECOND_STEP_MS = { '1s': 1000, '5s': 5000, '15s': 15000 } as const
export type SecondStepPeriod = keyof typeof SECOND_STEP_MS
export type FineStepPeriod = 'tick' | SecondStepPeriod
export type ReplayStepPeriod = MarketTimeframe | FineStepPeriod
export type CTraderReplayStepPeriod = CTraderTimeframe | FineStepPeriod

export const FINE_STEP_PERIODS = ['tick', '1s', '5s', '15s'] as const satisfies readonly FineStepPeriod[]

export function isFineStepPeriod(value: unknown): value is FineStepPeriod {
  return (FINE_STEP_PERIODS as readonly unknown[]).includes(value)
}

export function isCTraderReplayStepPeriod(value: string): value is CTraderReplayStepPeriod {
  return isFineStepPeriod(value) || isCTraderTimeframe(value)
}
