export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}
