import type { Page } from '@playwright/test'
import { fixtureMinutePrices } from './archive-fixtures'
import { usesNativeKlines } from '../src/market-data/intervals'

/** Seed listing metadata, never candles, before the production DB upgrade. */
export async function seedSymbolListing(page: Page, onboardDate: number) {
  await page.route('**/__listing_fixture__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }))
  await page.goto('./__listing_fixture__')
  await page.evaluate(async onboardDate => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('crypto-contract-workstation', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('symbols', { keyPath: 'symbol' }).createIndex('by-onboard-date', 'onboardDate')
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('symbols', 'readwrite')
        transaction.objectStore('symbols').put({ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate, pricePrecision: 2, quantityPrecision: 3 })
        transaction.oncomplete = () => { database.close(); resolve() }
        transaction.onabort = () => { database.close(); reject(transaction.error) }
      }
    })
  }, onboardDate)
}

/**
 * UI tests start with cached canonical minutes for the requested chart window.
 * The real IndexedDB store, aggregation, replay, trading and backups still run.
 * Archive/network integration cases deliberately do not install this fixture.
 */
export async function installCachedMarketFixture(page: Page, symbolPrices: Record<string, number> = {}, trend = false, recentOnly = false) {
  await page.addInitScript({ content: `(() => {
    const MINUTE = 60000;
    const prices = ${fixtureMinutePrices.toString()};
    const usesNativeKlines = ${usesNativeKlines.toString()};
    const symbolPrices = ${JSON.stringify(symbolPrices)};
    const trend = ${JSON.stringify(trend)};
    const recentOnly = ${JSON.stringify(recentOnly)};
    window.__enableViewportProbe = true;
    window.__prepareMarketFixture = service => {
      if (service.__cachedFixture) return;
      service.__cachedFixture = true;
      const load = service.loadCandles.bind(service);
      const intervals = { '1m':1, '3m':3, '5m':5, '15m':15, '30m':30, '1h':60, '2h':120, '4h':240, '6h':360, '8h':480, '12h':720, '1d':1440, '3d':4320, '1w':10080 };
      let pending = Promise.resolve();
      service.loadCandles = async (kind, symbol, timeframe, from, to, options = {}) => {
        if (usesNativeKlines(timeframe)) return load(kind, symbol, timeframe, from, to, options);
        const now = new Date();
        if (recentOnly && from < Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)) return load(kind, symbol, timeframe, from, to, options);
        const seed = pending.catch(() => {}).then(async () => {
          options.signal?.throwIfAborted();
          const periodEnd = timeframe === '1M'
            ? Date.UTC(new Date(to).getUTCFullYear(), new Date(to).getUTCMonth() + 1, 1)
            : timeframe === '1w'
              ? Math.floor((to - 4 * 86400000) / (10080 * MINUTE)) * 10080 * MINUTE + 4 * 86400000 + 10080 * MINUTE
              : Math.floor(to / (intervals[timeframe] * MINUTE)) * intervals[timeframe] * MINUTE + intervals[timeframe] * MINUTE;
          const last = Math.min(periodEnd - MINUTE, Math.floor(Date.now() / MINUTE) * MINUTE - MINUTE);
          const first = Math.max(0, Math.ceil(from / MINUTE) * MINUTE);
          if (first > last) return;
          const existing = new Set((await service.store.getCandles(kind, symbol, '1m', first, last)).map(row => row.openTime));
          const rows = [];
          for (let at = first; at <= last; at += MINUTE) {
            if (existing.has(at)) continue;
            const [open, high, low, close] = prices(at, { price: symbolPrices[symbol], trend });
            rows.push({symbol, timeframe:'1m', openTime:at, closeTime:at+MINUTE-1, open, high, low, close, volume:'100.5', quoteVolume:'6030000', tradeCount:100, isClosed:true, source:'binance'});
          }
          await service.store.putCandles(kind, rows, options.signal);
        });
        pending = seed;
        await seed;
        return load(kind, symbol, timeframe, from, to, options);
      };
    };
  })();` })
}
