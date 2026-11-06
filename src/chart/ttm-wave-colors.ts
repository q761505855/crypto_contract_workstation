export const TTM_WAVE_PALETTES = {
  A: { positive: ['#168c72', '#9aefca'], negative: ['#d93654', '#ffadba'] },
  B: { positive: ['#168a80', '#9ae9db'], negative: ['#dc4940', '#ffc0aa'] },
  C: { positive: ['#1b966e', '#a7f2c8'], negative: ['#d33e62', '#ffb3ce'] },
} as const

export type TtmWave = keyof typeof TTM_WAVE_PALETTES
