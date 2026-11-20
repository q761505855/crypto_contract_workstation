export interface CTraderConnectionConfig {
  clientId: string
  clientSecret: string
  accessToken: string
  accountId?: number
}

export function parseCTraderConnection(raw: unknown): CTraderConnectionConfig | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { clientId, clientSecret, accessToken, accountId } = raw as Record<string, unknown>
  if (typeof clientId !== 'string' || !/^\S+$/.test(clientId) ||
      typeof clientSecret !== 'string' || !/^\S+$/.test(clientSecret) ||
      typeof accessToken !== 'string' || !/^\S+$/.test(accessToken)) {
    return undefined
  }
  return {
    clientId, clientSecret, accessToken,
    ...(typeof accountId === 'number' && Number.isSafeInteger(accountId) && accountId > 0 ? { accountId } : {}),
  }
}
