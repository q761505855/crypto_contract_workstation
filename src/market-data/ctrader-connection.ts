import type { CTraderConnectionConfig } from './ctrader-client'

const CONNECTION_UNAVAILABLE = 'cTrader 连接配置未就绪，需要仅授权给一个模拟账户的只读连接。'

export async function loadCTraderConnection(fetcher: typeof fetch = fetch): Promise<CTraderConnectionConfig> {
  let raw: unknown
  try {
    const response = await fetcher(`${import.meta.env.BASE_URL}ctrader-connection.json`, {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(5000),
    })
    if (response.ok) raw = await response.json()
  } catch {
    throw new Error(CONNECTION_UNAVAILABLE)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(CONNECTION_UNAVAILABLE)
  const { clientId, clientSecret, accessToken, accountId } = raw as Record<string, unknown>
  if (typeof clientId !== 'string' || !/^\S+$/.test(clientId) ||
      typeof clientSecret !== 'string' || !/^\S+$/.test(clientSecret) ||
      typeof accessToken !== 'string' || !/^\S+$/.test(accessToken) ||
      typeof accountId !== 'number' || !Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error(CONNECTION_UNAVAILABLE)
  }
  return { clientId, clientSecret, accessToken, accountId }
}
