import type { Page, WebSocketRoute } from '@playwright/test'

export const config = { clientId: 'test-app', clientSecret: 'test-secret', accessToken: 'test-access', accountId: 17 }
const minute = 60_000

export async function connectFixture(page: Page, multipleAccounts = false, {
  initialQuote = true,
  rejectedAccount = 0,
  historyAvailable,
  historyVolume,
  ticks = [],
}: {
  initialQuote?: boolean
  rejectedAccount?: number
  historyAvailable?: (timestamp: number) => boolean
  historyVolume?: (timestamp: number, minutes: number) => number
  ticks?: { timestamp: number; price: number }[]
} = {}) {
  const messages: { type: number; accountId?: number; period?: number; symbolId?: number; live: boolean }[] = []
  const legacyRequests: string[] = []
  let currentSocket: WebSocketRoute | undefined
  let currentAccount = config.accountId
  const pushSpot = (payload: object) => currentSocket?.send(JSON.stringify({ payloadType: 2131,
    payload: { ctidTraderAccountId: currentAccount, symbolId: 10, ...payload },
  }))
  await page.route('**/ctrader-connection.json', route => route.fulfill({ json: config }))
  const cors = { 'access-control-allow-origin': '*' }
  await page.route('https://api.bybit.com/**', route => route.fulfill({ headers: cors, json: { retCode: 0, result: { list: [] } } }))
  await page.route('https://raw.githubusercontent.com/**/bybit-trades/**', route => route.fulfill({ status: 404, headers: cors }))
  await page.route('https://testingcf.jsdelivr.net/gh/**', route => route.fulfill({ status: 404, headers: cors }))
  await page.routeWebSocket(/^wss:\/\/stream\.bybit\.com\/v5\/public\//, socket => socket.onMessage(message => {
    if (JSON.parse(message.toString()).op === 'subscribe') socket.send(JSON.stringify({ op: 'subscribe', success: true }))
  }))
  await page.route('**/cloud-connection.json', route => route.fulfill({ status: 404, headers: cors, body: '' }))
  await page.route('https://api.github.com/**', route => route.fulfill({ status: 404, headers: cors, json: { message: 'Not Found' } }))
  await page.route(/binance\.com|binance\.vision/, route => {
    legacyRequests.push(route.request().url())
    return route.abort()
  })
  await page.routeWebSocket(/^wss:\/\/(demo|live)\.ctraderapi\.com:5036\/$/, socket => {
    currentSocket = socket
    const live = new URL(socket.url()).hostname === 'live.ctraderapi.com'
    let activeAccount = config.accountId
    socket.onMessage(message => {
      const { clientMsgId, payloadType, payload } = JSON.parse(message.toString())
      messages.push({ type: payloadType, accountId: payload.ctidTraderAccountId, period: payload.period, symbolId: payload.symbolId, live })
      const response = (type: number, body: object = {}) => socket.send(JSON.stringify({ clientMsgId, payloadType: type, payload: body }))
      const account = { ctidTraderAccountId: config.accountId, traderLogin: 2017, isLive: false, brokerTitleShort: 'IC Markets' }
      const accountPayload = { ctidTraderAccountId: activeAccount }
      const assets = [{ assetId: 1, name: 'EUR', digits: 2 }, { assetId: 2, name: 'USD', digits: 2 }]
      const symbols = ['EURUSD', 'XAUUSD', 'US500', 'BTCUSD', 'ETHUSD', 'USDCHF'].map((symbolName, index) => ({
        symbolId: 10 + index, symbolName, enabled: true, baseAssetId: 1, quoteAssetId: 2,
      }))
      switch (payloadType) {
        case 2100: response(2101); break
        case 2149: response(2150, { permissionScope: 0, ctidTraderAccount: multipleAccounts ? [account,
          { ...account, ctidTraderAccountId: 18, traderLogin: 2018 },
          { ...account, ctidTraderAccountId: 19, traderLogin: 2019, isLive: true },
        ] : [account] }); break
        case 2102:
          if (payload.ctidTraderAccountId === rejectedAccount) response(2142, { errorCode: 'CANT_ROUTE_REQUEST' })
          else {
            currentAccount = activeAccount = payload.ctidTraderAccountId
            response(2103, { ctidTraderAccountId: activeAccount })
          }
          break
        case 2112: response(2113, { ...accountPayload, asset: assets }); break
        case 2114: response(2115, { ...accountPayload, symbol: symbols }); break
        case 2116: response(2117, { ...accountPayload, symbol: (payload.symbolId as number[]).map(symbolId => ({
          symbolId, digits: symbolId === 10 || symbolId === 12 ? 5 : 2, scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 604800 }],
          lotSize: 10000000, minVolume: 100000, stepVolume: 100000, maxVolume: 1000000000,
          leverageId: 123, commissionType: 1, preciseTradingCommissionRate: 3000000000,
        })) }); break
        case 2121: response(2122, { trader: { ...accountPayload, depositAssetId: 2, leverageInCents: 50000,
          totalMarginCalculationType: 0, accountType: 0 } }); break
        case 2177: response(2178, { ...accountPayload, leverage: { leverageId: 123, tiers: [{ volume: 100000000, leverage: 20000 }] } }); break
        case 2137: {
          const width = [0, 1, 2, 3, 4, 5, 10, 15, 30, 60][Number(payload.period)] ?? 1
          const start = Math.ceil(Number(payload.fromTimestamp) / (minute * width)) * width
          const end = Math.floor(Number(payload.toTimestamp) / (minute * width)) * width
          const trendbar = []
          const first = historyAvailable ? start : Math.max(start, end - 10 * width)
          for (let stamp = first; stamp <= end; stamp += width) {
            if (historyAvailable && !historyAvailable(stamp * minute)) continue
            trendbar.push({ utcTimestampInMinutes: stamp, period: payload.period, low: 110000, deltaOpen: 20, deltaHigh: 70, deltaClose: 50, volume: historyVolume?.(stamp * minute, width) ?? 42 })
          }
          response(2138, { ...accountPayload, symbolId: payload.symbolId, period: payload.period, trendbar, hasMore: false })
          break
        }
        case 2145: {
          const quotes = ticks.filter(quote =>
            quote.timestamp >= Number(payload.fromTimestamp) && quote.timestamp < Number(payload.toTimestamp)).reverse()
          const tickData = quotes.map((quote, i) => ({
            timestamp: quote.timestamp - (quotes[i - 1]?.timestamp ?? 0),
            tick: quote.price - (quotes[i - 1]?.price ?? 0),
          }))
          response(2146, { ...accountPayload, tickData, hasMore: false })
          break
        }
        case 2127: response(2128, accountPayload); break
        case 2129: response(2130, accountPayload); break
        case 2135: {
          response(2165, accountPayload)
          if (initialQuote) pushSpot({ symbolId: payload.symbolId, bid: 110050, ask: 110060 })
          break
        }
        case 2136: response(2166, accountPayload); break
      }
    })
  })
  return { messages, legacyRequests, pushSpot, disconnect: () => currentSocket?.close({ code: 1011, reason: 'test outage' }) }
}
