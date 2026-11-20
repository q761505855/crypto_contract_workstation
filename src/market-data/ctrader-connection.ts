import type { CTraderConnectionConfig } from './ctrader-client'

const CONNECTION_UNAVAILABLE = 'cTrader 连接配置未就绪，需要只读连接凭据。'

async function readConnection(fetcher: typeof fetch, filename: string): Promise<CTraderConnectionConfig | undefined> {
  let raw: unknown
  try {
    const response = await fetcher(`${import.meta.env.BASE_URL}${filename}`, {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(5000),
    })
    if (response.ok) raw = await response.json()
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { clientId, clientSecret, accessToken, accountId } = raw as Record<string, unknown>
  if (typeof clientId !== 'string' || !/^\S+$/.test(clientId) ||
      typeof clientSecret !== 'string' || !/^\S+$/.test(clientSecret) ||
      typeof accessToken !== 'string' || !/^\S+$/.test(accessToken)) {
    return undefined
  }
  return { clientId, clientSecret, accessToken,
    ...(typeof accountId === 'number' && Number.isSafeInteger(accountId) && accountId > 0 ? { accountId } : {}),
  }
}

export async function loadCTraderConnection(fetcher: typeof fetch = fetch): Promise<CTraderConnectionConfig> {
  const published = await readConnection(fetcher, 'ctrader-connection.json')
  if (published) return published
  if (import.meta.env.DEV) {
    const local = await readConnection(fetcher, 'ctrader-connection.local.json')
    if (local) return local
  }
  throw new Error(CONNECTION_UNAVAILABLE)
}
