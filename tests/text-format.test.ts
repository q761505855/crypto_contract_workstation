import { describe, expect, it } from 'vitest'
import { normalizeNewlines } from './text-format'

describe('normalizeNewlines', () => {
  it('normalizes Windows and legacy Mac line endings to LF', () => {
    expect(normalizeNewlines('alpha\r\nbeta\rgamma\n')).toBe(
      'alpha\nbeta\ngamma\n',
    )
  })
})
