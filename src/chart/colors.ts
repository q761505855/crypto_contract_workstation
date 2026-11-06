/** Portable Canvas colors accepted by every chart setting and archive reader. */
export function isChartColor(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) || value === 'transparent') return true
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?|\.\d+))?\s*\)$/i.exec(value)
  return rgba !== null && rgba.slice(1, 4).every(channel => Number(channel) <= 255) &&
    (value.startsWith('rgba(') ? rgba[4] !== undefined : rgba[4] === undefined)
}

export function validateStyleColors(value: unknown, field = 'styles'): void {
  if (Array.isArray(value)) { value.forEach((item, index) => validateStyleColors(item, `${field}[${index}]`)); return }
  if (value === null || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    if (/color$/i.test(key) && !isChartColor(entry)) throw new Error(`${field}.${key} color 无效`)
    validateStyleColors(entry, `${field}.${key}`)
  }
}
