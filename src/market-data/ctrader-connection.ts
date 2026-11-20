import { parseCTraderConnection, type CTraderConnectionConfig } from './ctrader-connection-config'

const CONNECTION_UNAVAILABLE = 'cTrader 连接配置未就绪，需要只读连接凭据。'

async function readConnection(fetcher: typeof fetch, filename: string): Promise<CTraderConnectionConfig | undefined> {
  try {
    const response = await fetcher(`${import.meta.env.BASE_URL}${filename}`, {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(5000),
    })
    if (response.ok) return parseCTraderConnection(await response.json())
  } catch {
    return undefined
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
