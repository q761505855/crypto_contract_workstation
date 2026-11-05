import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { normalizeNewlines } from './text-format'

describe('third-party attribution', () => {
  it('records the ZIP reader and ships its complete upstream MIT license', async () => {
    const notice = await readFile('public/THIRD_PARTY_NOTICES.txt','utf8')
    const license = await readFile('public/licenses/fflate-MIT.txt','utf8')
    const upstream = await readFile('node_modules/fflate/LICENSE','utf8')
    expect(notice).toContain('fflate 0.8.3')
    expect(normalizeNewlines(license)).toBe(normalizeNewlines(upstream))
  })
  it('records KLineChart packages, versions, licenses, and upstream notices', async () => {
    const notice = normalizeNewlines(
      await readFile('public/THIRD_PARTY_NOTICES.txt', 'utf8'),
    )
    const upstreamNotice = normalizeNewlines(
      await readFile('node_modules/klinecharts/NOTICE', 'utf8'),
    )

    expect(notice).toContain('@klinecharts/pro 0.1.1')
    expect(notice).toContain('Apache-2.0')
    expect(notice).toContain('https://github.com/klinecharts/pro')
    expect(notice).toContain('klinecharts 9.8.12')
    expect(notice).toContain('https://klinecharts.com/')
    expect(notice).toContain('https://github.com/klinecharts/KLineChart')
    expect(notice).toContain(upstreamNotice.trimEnd())
  })

  it('ships a recognizably complete Apache License 2.0 copy', async () => {
    const license = normalizeNewlines(
      await readFile('public/licenses/Apache-2.0.txt', 'utf8'),
    )
    const upstreamLicense = normalizeNewlines(
      await readFile('node_modules/@klinecharts/pro/LICENSE', 'utf8'),
    )

    expect(license).toBe(upstreamLicense)
    expect(license).toContain('Apache License\n                           Version 2.0, January 2004')
    expect(license).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')
    expect(license).toContain('9. Accepting Warranty or Additional Liability.')
    expect(license).toContain('END OF TERMS AND CONDITIONS')
    expect(license).toContain('APPENDIX: How to apply the Apache License to your work.')
  })

  it('records decimal.js and ships its complete MIT license', async () => {
    const notice = normalizeNewlines(
      await readFile('public/THIRD_PARTY_NOTICES.txt', 'utf8'),
    )
    const license = normalizeNewlines(
      await readFile('public/licenses/decimal.js-MIT.txt', 'utf8'),
    )
    const upstreamLicense = normalizeNewlines(
      await readFile('node_modules/decimal.js/LICENCE.md', 'utf8'),
    )

    expect(notice).toContain('decimal.js 10.6.0')
    expect(notice).toContain('License: MIT')
    expect(license.trimEnd()).toBe(upstreamLicense.trimEnd())
  })
})
