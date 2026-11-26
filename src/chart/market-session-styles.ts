import { isChartColor } from './colors'
import { DEFAULT_MARKET_SESSION_VISIBILITY, type MarketSessionVisibility } from './market-session-times'

type SessionLineStyle = {
  style: 'solid' | 'dashed' | 'dotted'
  size: number
}

type SessionStyles = {
  sessionVisibility?: MarketSessionVisibility
  showMidday?: boolean
  sessionFills?: [{ color: string }, { color: string }, { color: string }]
  sessionLines?: [SessionLineStyle]
}

export const MARKET_SESSION_STYLES: Required<SessionStyles> = {
  sessionVisibility: DEFAULT_MARKET_SESSION_VISIBILITY,
  showMidday: false,
  sessionFills: [{ color: '#f5bb5538' }, { color: '#57b5fc38' }, { color: '#ce83ef38' }],
  sessionLines: [{ style: 'solid', size: 1 }],
}

export function validateMarketSessionStyles(styles: unknown): void {
  if (styles === null) return
  if (typeof styles !== 'object' || Array.isArray(styles)) throw new Error('MARKET_SESSIONS.styles 无效')
  if ('showMidday' in styles && typeof styles.showMidday !== 'boolean') {
    throw new Error('MARKET_SESSIONS.styles.showMidday 必须是布尔值')
  }
  if ('sessionVisibility' in styles) {
    const visibility = styles.sessionVisibility
    if (!Array.isArray(visibility) || visibility.length !== 3 || [...visibility].some(value => typeof value !== 'boolean')) {
      throw new Error('MARKET_SESSIONS.styles.sessionVisibility 必须包含东京、伦敦、纽约的三个布尔值')
    }
  }
  if ('sessionFills' in styles) {
    const fills = styles.sessionFills
    if (!Array.isArray(fills) || fills.length !== 3 || !fills.every(fill => fill && isChartColor(fill.color))) {
      throw new Error('MARKET_SESSIONS.styles.sessionFills 必须包含东京、伦敦、纽约的有效颜色')
    }
  }
  if ('sessionLines' in styles) {
    const lines = styles.sessionLines
    if (!Array.isArray(lines) || (lines.length !== 1 && lines.length !== 2) || !lines.every(line =>
      line && ['solid', 'dashed', 'dotted'].includes(line.style) && Number.isInteger(line.size) && line.size >= 0 && line.size <= 4
    )) {
      throw new Error('MARKET_SESSIONS.styles.sessionLines 无效')
    }
  }
}

export function marketSessionStyles(styles: unknown): Required<SessionStyles> {
  const configured = styles as SessionStyles | null | undefined
  return {
    sessionVisibility: configured?.sessionVisibility ?? MARKET_SESSION_STYLES.sessionVisibility,
    showMidday: configured?.showMidday ?? MARKET_SESSION_STYLES.showMidday,
    sessionFills: configured?.sessionFills ?? MARKET_SESSION_STYLES.sessionFills,
    sessionLines: configured?.sessionLines ?? MARKET_SESSION_STYLES.sessionLines,
  }
}

export function sessionAccentColor(color: string, fallback: string): string {
  const base = color === 'transparent' ? fallback : color
  if (base.startsWith('#')) return base.slice(0, base.length <= 5 ? 4 : 7)
  return base.replace(/^rgba\((.*),[^,]+\)$/i, 'rgb($1)')
}
