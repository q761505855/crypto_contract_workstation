# Phase 1 Static Chart Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a testable, backend-free React workstation shell that embeds KLineChart Pro behind a stable adapter and proves the historical/live mode layout on GitHub Pages.

**Architecture:** A Vite React application owns the workstation layout. KLineChart Pro is created exactly once for the application lifetime through `ProChartAdapter`; a deterministic demo `Datafeed` supplies Phase 1 candles so the chart can be verified before Binance integration. GitHub Actions runs type checks, unit tests, browser smoke tests, and a Pages production build.

**Tech Stack:** Node.js 24, npm 11, Vite 8.1.5, React 19.2.8, TypeScript 7.0.2, `@klinecharts/pro` 0.1.1, `klinecharts` 9.8.12, Vitest 4.1.10, Testing Library, Playwright 1.61.1, GitHub Actions, GitHub Pages.

## Global Constraints

- The deliverable is a static site; do not add a backend, server runtime, database server, Docker configuration, Binance API key, or real-order code.
- Pin every direct npm dependency to the exact version listed in Task 1 and commit `package-lock.json`.
- Use TypeScript strict mode and keep one responsibility per source file.
- The GitHub Pages production base path is `/crypto_contract_workstation/`; local development uses `/`.
- Keep `ChartWorkspace` mounted while switching modes because KLineChart Pro 0.1.1 exposes no destroy API.
- Do not wrap the root in React `StrictMode`; its development remount cycle would construct duplicate Pro instances.
- Business components depend on `ChartAdapterPort`, never on KLineChart Pro private DOM or private fields.
- Phase 1 uses only deterministic demo data. Binance REST/WebSocket work belongs to Phase 2.
- Real-time mode is visibly read-only even though Phase 1 has no live feed yet.
- The existing approved requirements and design files remain authoritative:
  - `项目需求-v2.md`
  - `docs/superpowers/specs/2026-07-22-static-crypto-replay-workstation-design.md`

---

## Planned File Structure

```text
.
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── deploy-pages.yml
├── e2e/
│   └── app-shell.spec.ts
├── src/
│   ├── app/
│   │   ├── App.test.tsx
│   │   ├── App.tsx
│   │   └── app.css
│   ├── chart/
│   │   ├── ChartWorkspace.test.tsx
│   │   ├── ChartWorkspace.tsx
│   │   ├── chart-config.test.ts
│   │   ├── chart-config.ts
│   │   ├── demo-datafeed.test.ts
│   │   ├── demo-datafeed.ts
│   │   ├── pro-chart-adapter.test.ts
│   │   └── pro-chart-adapter.ts
│   ├── components/
│   │   ├── ModeSwitch.tsx
│   │   └── panels.tsx
│   ├── test/
│   │   └── setup.ts
│   ├── main.tsx
│   └── vite-env.d.ts
├── tests/
│   └── deployment-config.test.ts
├── index.html
├── package.json
├── package-lock.json
├── playwright.config.ts
├── tsconfig.app.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
└── vitest.config.ts
```

File responsibilities:

- `src/chart/chart-config.ts`: default symbol, supported periods, indicator defaults, and immutable Pro options.
- `src/chart/demo-datafeed.ts`: deterministic Phase 1 implementation of Pro's `Datafeed` interface.
- `src/chart/pro-chart-adapter.ts`: the only production file allowed to instantiate `KLineChartPro`.
- `src/chart/ChartWorkspace.tsx`: stable React host element for the adapter.
- `src/app/App.tsx`: workstation mode state and layout composition.
- `src/components/ModeSwitch.tsx`: accessible history/live toggle.
- `src/components/panels.tsx`: Phase 1 account, order, replay, and live-status placeholders.
- `tests/deployment-config.test.ts`: executable assertions for Pages base-path and workflow safety.

---

### Task 1: Static React Foundation

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `index.html`
- Create: `tsconfig.json`
- Create: `tsconfig.app.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `src/vite-env.d.ts`
- Create: `src/test/setup.ts`
- Create: `src/app/App.test.tsx`
- Create: `src/app/App.tsx`
- Create: `src/app/app.css`
- Create: `src/main.tsx`

**Interfaces:**
- Consumes: none.
- Produces: default React component `App(): JSX.Element`; npm scripts `dev`, `build`, `typecheck`, `test`, and `check`.

- [ ] **Step 1: Add pinned package metadata, TypeScript/Vite configuration, and a failing shell test**

`package.json`:

```json
{
  "name": "crypto-contract-workstation",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": {
    "node": ">=24.0.0",
    "npm": ">=11.0.0"
  },
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc -b --pretty false",
    "test": "vitest run",
    "check": "npm run typecheck && npm run test && npm run build"
  },
  "dependencies": {
    "@klinecharts/pro": "0.1.1",
    "klinecharts": "9.8.12",
    "react": "19.2.8",
    "react-dom": "19.2.8"
  },
  "devDependencies": {
    "@playwright/test": "1.61.1",
    "@testing-library/jest-dom": "7.0.0",
    "@testing-library/react": "16.3.2",
    "@types/node": "26.1.1",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "6.0.4",
    "jsdom": "29.1.1",
    "typescript": "7.0.2",
    "vite": "8.1.5",
    "vitest": "4.1.10"
  }
}
```

`tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

`tsconfig.app.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["node", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "tests"]
}
```

`tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["vite.config.ts", "vitest.config.ts", "playwright.config.ts"]
}
```

`vite.config.ts`:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [react()],
  }
})
```

`vitest.config.ts`:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
```

`src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
```

`src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

`src/app/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App', () => {
  it('renders the workstation title and mode label', () => {
    render(<App />)
    expect(
      screen.getByRole('heading', { name: '加密货币合约回放工作站' }),
    ).toBeVisible()
    expect(screen.getByText('历史模拟')).toBeVisible()
  })
})
```

- [ ] **Step 2: Install dependencies and verify the test fails**

Run:

```bash
npm install
npm test -- src/app/App.test.tsx
```

Expected: dependency installation creates `package-lock.json`; the test command fails because `src/app/App.tsx` does not exist.

- [ ] **Step 3: Add the minimal application shell**

`index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      name="description"
      content="纯前端加密货币合约历史回放与实时行情工作站"
    />
    <title>Crypto Contract Replay Workstation</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/app/App.tsx`:

```tsx
import './app.css'

export default function App() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>加密货币合约回放工作站</h1>
        <span className="mode-badge">历史模拟</span>
      </header>
      <section className="phase-card">
        <p>Phase 1：静态图表基础</p>
      </section>
    </main>
  )
}
```

`src/app/app.css`:

```css
:root {
  color: #d8dee9;
  background: #0b0f14;
  font-family:
    Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  font-synthesis: none;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  width: 100%;
  min-width: 1024px;
  height: 100%;
  margin: 0;
}

button,
input,
select {
  font: inherit;
}

.app-shell {
  min-height: 100%;
  background: #0b0f14;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 56px;
  padding: 0 20px;
  border-bottom: 1px solid #242c37;
}

.app-header h1 {
  margin: 0;
  font-size: 18px;
}

.mode-badge {
  color: #66c2ff;
}

.phase-card {
  margin: 24px;
  padding: 24px;
  border: 1px solid #242c37;
  border-radius: 8px;
  background: #121821;
}
```

`src/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client'
import App from './app/App'

const rootElement = document.getElementById('root')
if (rootElement === null) {
  throw new Error('Root element #root was not found.')
}

createRoot(rootElement).render(<App />)
```

- [ ] **Step 4: Verify unit test, type check, and production build**

Run:

```bash
npm test -- src/app/App.test.tsx
npm run typecheck
npm run build
```

Expected: one App test passes, TypeScript exits 0, and Vite writes `dist/index.html`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json index.html tsconfig*.json vite.config.ts vitest.config.ts src
git commit -m "build: scaffold static React workstation"
```

---

### Task 2: Chart Configuration and Deterministic Demo Datafeed

**Files:**
- Create: `src/chart/chart-config.test.ts`
- Create: `src/chart/chart-config.ts`
- Create: `src/chart/demo-datafeed.test.ts`
- Create: `src/chart/demo-datafeed.ts`

**Interfaces:**
- Consumes: `Datafeed`, `Period`, and `SymbolInfo` from `@klinecharts/pro`.
- Produces: `DEFAULT_SYMBOL`, `SUPPORTED_PERIODS`, `DEFAULT_MAIN_INDICATORS`, `DEFAULT_SUB_INDICATORS`, `createChartOptions(container, datafeed)`, and `DemoDatafeed`.

- [ ] **Step 1: Write failing configuration and Datafeed tests**

`src/chart/chart-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAIN_INDICATORS,
  DEFAULT_SUB_INDICATORS,
  DEFAULT_SYMBOL,
  SUPPORTED_PERIODS,
} from './chart-config'

describe('chart configuration', () => {
  it('uses BTCUSDT and exposes every approved period', () => {
    expect(DEFAULT_SYMBOL.ticker).toBe('BTCUSDT')
    expect(SUPPORTED_PERIODS.map((period) => period.text)).toEqual([
      '1m',
      '3m',
      '5m',
      '15m',
      '30m',
      '1h',
      '2h',
      '4h',
      '6h',
      '8h',
      '12h',
      '1d',
      '3d',
      '1w',
      '1M',
    ])
    expect(DEFAULT_MAIN_INDICATORS).toEqual(['MA'])
    expect(DEFAULT_SUB_INDICATORS).toEqual(['VOL', 'MACD'])
  })
})
```

`src/chart/demo-datafeed.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SYMBOL, SUPPORTED_PERIODS } from './chart-config'
import { DemoDatafeed } from './demo-datafeed'

describe('DemoDatafeed', () => {
  it('filters symbols without case sensitivity', async () => {
    const datafeed = new DemoDatafeed()
    await expect(datafeed.searchSymbols('eth')).resolves.toEqual([
      expect.objectContaining({ ticker: 'ETHUSDT' }),
    ])
  })

  it('returns deterministic ascending candles inside the requested range', async () => {
    const now = 1_800_000_000_000
    const datafeed = new DemoDatafeed(() => now)
    const period = SUPPORTED_PERIODS.find((item) => item.text === '5m')
    expect(period).toBeDefined()

    const rows = await datafeed.getHistoryKLineData(
      DEFAULT_SYMBOL,
      period!,
      now - 15 * 60_000,
      now,
    )

    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.timestamp)).toEqual([
      now - 15 * 60_000,
      now - 10 * 60_000,
      now - 5 * 60_000,
      now,
    ])
    expect(rows.every((row) => row.high >= row.low)).toBe(true)
  })

  it('does not emit live updates in Phase 1', () => {
    const datafeed = new DemoDatafeed()
    const callback = vi.fn()
    datafeed.subscribe(DEFAULT_SYMBOL, SUPPORTED_PERIODS[0], callback)
    expect(callback).not.toHaveBeenCalled()
    expect(() =>
      datafeed.unsubscribe(DEFAULT_SYMBOL, SUPPORTED_PERIODS[0]),
    ).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- src/chart/chart-config.test.ts src/chart/demo-datafeed.test.ts
```

Expected: FAIL because `chart-config.ts` and `demo-datafeed.ts` do not exist.

- [ ] **Step 3: Implement immutable chart configuration**

`src/chart/chart-config.ts`:

```ts
import type {
  ChartProOptions,
  Datafeed,
  Period,
  SymbolInfo,
} from '@klinecharts/pro'

export const DEFAULT_SYMBOL: SymbolInfo = Object.freeze({
  exchange: 'BINANCE',
  market: 'USDT-M PERPETUAL',
  name: 'Bitcoin / Tether USDT Perpetual',
  shortName: 'BTCUSDT',
  ticker: 'BTCUSDT',
  priceCurrency: 'USDT',
  type: 'PERPETUAL',
  pricePrecision: 2,
  volumePrecision: 3,
})

export const SUPPORTED_PERIODS: readonly Period[] = Object.freeze([
  { multiplier: 1, timespan: 'minute', text: '1m' },
  { multiplier: 3, timespan: 'minute', text: '3m' },
  { multiplier: 5, timespan: 'minute', text: '5m' },
  { multiplier: 15, timespan: 'minute', text: '15m' },
  { multiplier: 30, timespan: 'minute', text: '30m' },
  { multiplier: 1, timespan: 'hour', text: '1h' },
  { multiplier: 2, timespan: 'hour', text: '2h' },
  { multiplier: 4, timespan: 'hour', text: '4h' },
  { multiplier: 6, timespan: 'hour', text: '6h' },
  { multiplier: 8, timespan: 'hour', text: '8h' },
  { multiplier: 12, timespan: 'hour', text: '12h' },
  { multiplier: 1, timespan: 'day', text: '1d' },
  { multiplier: 3, timespan: 'day', text: '3d' },
  { multiplier: 1, timespan: 'week', text: '1w' },
  { multiplier: 1, timespan: 'month', text: '1M' },
])

export const DEFAULT_MAIN_INDICATORS = Object.freeze(['MA'])
export const DEFAULT_SUB_INDICATORS = Object.freeze(['VOL', 'MACD'])

export function createChartOptions(
  container: HTMLElement,
  datafeed: Datafeed,
): ChartProOptions {
  return {
    container,
    datafeed,
    drawingBarVisible: true,
    locale: 'zh-CN',
    mainIndicators: [...DEFAULT_MAIN_INDICATORS],
    period: SUPPORTED_PERIODS[3],
    periods: [...SUPPORTED_PERIODS],
    subIndicators: [...DEFAULT_SUB_INDICATORS],
    symbol: { ...DEFAULT_SYMBOL },
    theme: 'dark',
    timezone: 'Asia/Shanghai',
  }
}
```

- [ ] **Step 4: Implement deterministic demo candles**

`src/chart/demo-datafeed.ts`:

```ts
import type {
  Datafeed,
  DatafeedSubscribeCallback,
  Period,
  SymbolInfo,
} from '@klinecharts/pro'
import type { KLineData } from 'klinecharts'

const DEMO_SYMBOLS: readonly SymbolInfo[] = Object.freeze([
  {
    exchange: 'BINANCE',
    market: 'USDT-M PERPETUAL',
    name: 'Bitcoin / Tether USDT Perpetual',
    shortName: 'BTCUSDT',
    ticker: 'BTCUSDT',
    priceCurrency: 'USDT',
    type: 'PERPETUAL',
  },
  {
    exchange: 'BINANCE',
    market: 'USDT-M PERPETUAL',
    name: 'Ethereum / Tether USDT Perpetual',
    shortName: 'ETHUSDT',
    ticker: 'ETHUSDT',
    priceCurrency: 'USDT',
    type: 'PERPETUAL',
  },
])

function periodToMilliseconds(period: Period): number {
  const unitMilliseconds: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000,
  }
  const unit = unitMilliseconds[period.timespan]
  if (unit === undefined) {
    throw new Error('Unsupported demo period: ' + period.timespan)
  }
  return period.multiplier * unit
}

function candleAt(timestamp: number, index: number): KLineData {
  const baseline = 60_000 + index * 8
  const wave = Math.sin(index / 6) * 120
  const open = baseline + wave
  const close = open + Math.cos(index / 4) * 45
  return {
    timestamp,
    open,
    high: Math.max(open, close) + 30,
    low: Math.min(open, close) - 30,
    close,
    volume: 100 + (index % 20) * 15,
    turnover: close * (100 + (index % 20) * 15),
  }
}

export class DemoDatafeed implements Datafeed {
  constructor(private readonly now: () => number = Date.now) {}

  async searchSymbols(search = ''): Promise<SymbolInfo[]> {
    const normalized = search.trim().toUpperCase()
    return DEMO_SYMBOLS.filter((symbol) =>
      symbol.ticker.toUpperCase().includes(normalized),
    ).map((symbol) => ({ ...symbol }))
  }

  async getHistoryKLineData(
    _symbol: SymbolInfo,
    period: Period,
    from: number,
    to: number,
  ): Promise<KLineData[]> {
    const interval = periodToMilliseconds(period)
    const safeTo = Math.min(to, this.now())
    const alignedStart = Math.ceil(from / interval) * interval
    const start = Math.max(alignedStart, safeTo - interval * 499)
    const rows: KLineData[] = []
    for (
      let timestamp = start, index = 0;
      timestamp <= safeTo;
      timestamp += interval, index += 1
    ) {
      rows.push(candleAt(timestamp, index))
    }
    return rows
  }

  subscribe(
    _symbol: SymbolInfo,
    _period: Period,
    _callback: DatafeedSubscribeCallback,
  ): void {}

  unsubscribe(_symbol: SymbolInfo, _period: Period): void {}
}
```

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
npm test -- src/chart/chart-config.test.ts src/chart/demo-datafeed.test.ts
npm run typecheck
```

Expected: six chart configuration/Datafeed assertions pass and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/chart
git commit -m "feat: add chart configuration and demo datafeed"
```

---

### Task 3: KLineChart Pro Adapter

**Files:**
- Create: `src/chart/pro-chart-adapter.test.ts`
- Create: `src/chart/pro-chart-adapter.ts`

**Interfaces:**
- Consumes: `ChartPro`, `ChartProOptions`, `Period`, and `SymbolInfo` from `@klinecharts/pro`.
- Produces: `ChartAdapterPort`, `ChartProFactory`, and `ProChartAdapter`.

- [ ] **Step 1: Write a failing adapter contract test**

`src/chart/pro-chart-adapter.test.ts`:

```ts
import type {
  ChartPro,
  ChartProOptions,
  Period,
  SymbolInfo,
} from '@klinecharts/pro'
import { describe, expect, it, vi } from 'vitest'
import { ProChartAdapter } from './pro-chart-adapter'

function fakeChart(): ChartPro {
  return {
    getLocale: vi.fn(() => 'zh-CN'),
    getPeriod: vi.fn(() => ({
      multiplier: 15,
      timespan: 'minute',
      text: '15m',
    })),
    getStyles: vi.fn(() => ({}) as ReturnType<ChartPro['getStyles']>),
    getSymbol: vi.fn(() => ({ ticker: 'BTCUSDT' })),
    getTheme: vi.fn(() => 'dark'),
    getTimezone: vi.fn(() => 'Asia/Shanghai'),
    setLocale: vi.fn(),
    setPeriod: vi.fn(),
    setStyles: vi.fn(),
    setSymbol: vi.fn(),
    setTheme: vi.fn(),
    setTimezone: vi.fn(),
  }
}

describe('ProChartAdapter', () => {
  it('mounts once and delegates public updates', () => {
    const chart = fakeChart()
    const factory = vi.fn((_options: ChartProOptions) => chart)
    const adapter = new ProChartAdapter(factory)
    const options = {
      container: document.createElement('div'),
      datafeed: {
        getHistoryKLineData: vi.fn(async () => []),
        searchSymbols: vi.fn(async () => []),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
      },
      period: { multiplier: 15, timespan: 'minute', text: '15m' },
      symbol: { ticker: 'BTCUSDT' },
    } satisfies ChartProOptions

    adapter.mount(options)
    adapter.setTheme('light')
    adapter.setTimezone('UTC')
    adapter.setSymbol({ ticker: 'ETHUSDT' } satisfies SymbolInfo)
    adapter.setPeriod({
      multiplier: 1,
      timespan: 'hour',
      text: '1h',
    } satisfies Period)

    expect(factory).toHaveBeenCalledOnce()
    expect(chart.setTheme).toHaveBeenCalledWith('light')
    expect(chart.setTimezone).toHaveBeenCalledWith('UTC')
    expect(chart.setSymbol).toHaveBeenCalledWith({ ticker: 'ETHUSDT' })
    expect(chart.setPeriod).toHaveBeenCalledWith({
      multiplier: 1,
      timespan: 'hour',
      text: '1h',
    })
    expect(() => adapter.mount(options)).toThrow('already mounted')
  })
})
```

- [ ] **Step 2: Run the adapter test to verify it fails**

Run:

```bash
npm test -- src/chart/pro-chart-adapter.test.ts
```

Expected: FAIL because `pro-chart-adapter.ts` does not exist.

- [ ] **Step 3: Implement the public Pro adapter**

`src/chart/pro-chart-adapter.ts`:

```ts
import {
  KLineChartPro,
  type ChartPro,
  type ChartProOptions,
  type Period,
  type SymbolInfo,
} from '@klinecharts/pro'

export interface ChartAdapterPort {
  mount(options: ChartProOptions): void
  setPeriod(period: Period): void
  setSymbol(symbol: SymbolInfo): void
  setTheme(theme: string): void
  setTimezone(timezone: string): void
}

export type ChartProFactory = (options: ChartProOptions) => ChartPro

const createProChart: ChartProFactory = (options) => new KLineChartPro(options)

export class ProChartAdapter implements ChartAdapterPort {
  private chart: ChartPro | null = null

  constructor(private readonly factory: ChartProFactory = createProChart) {}

  mount(options: ChartProOptions): void {
    if (this.chart !== null) {
      throw new Error('KLineChart Pro is already mounted.')
    }
    this.chart = this.factory(options)
  }

  setTheme(theme: string): void {
    this.requireChart().setTheme(theme)
  }

  setTimezone(timezone: string): void {
    this.requireChart().setTimezone(timezone)
  }

  setSymbol(symbol: SymbolInfo): void {
    this.requireChart().setSymbol(symbol)
  }

  setPeriod(period: Period): void {
    this.requireChart().setPeriod(period)
  }

  private requireChart(): ChartPro {
    if (this.chart === null) {
      throw new Error('KLineChart Pro is not mounted.')
    }
    return this.chart
  }
}
```

- [ ] **Step 4: Run adapter and full unit tests**

Run:

```bash
npm test -- src/chart/pro-chart-adapter.test.ts
npm run typecheck
npm test
```

Expected: adapter delegation test passes, TypeScript exits 0, and the full suite has zero failures.

- [ ] **Step 5: Commit**

```bash
git add src/chart/pro-chart-adapter.ts src/chart/pro-chart-adapter.test.ts
git commit -m "feat: isolate KLineChart Pro behind adapter"
```

---

### Task 4: Stable React Chart Host

**Files:**
- Create: `src/chart/ChartWorkspace.test.tsx`
- Create: `src/chart/ChartWorkspace.tsx`
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: `ChartAdapterPort`, `ProChartAdapter`, `createChartOptions`, and `DemoDatafeed`.
- Produces: `ChartWorkspace({ createAdapter? }): JSX.Element` and stable test id `chart-host`.

- [ ] **Step 1: Write a failing mount-once component test**

`src/chart/ChartWorkspace.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChartAdapterPort } from './pro-chart-adapter'
import { ChartWorkspace } from './ChartWorkspace'

describe('ChartWorkspace', () => {
  it('mounts one adapter into a stable chart host', async () => {
    const adapter: ChartAdapterPort = {
      mount: vi.fn(),
      setPeriod: vi.fn(),
      setSymbol: vi.fn(),
      setTheme: vi.fn(),
      setTimezone: vi.fn(),
    }

    const { rerender } = render(
      <ChartWorkspace createAdapter={() => adapter} />,
    )
    rerender(<ChartWorkspace createAdapter={() => adapter} />)

    const host = screen.getByTestId('chart-host')
    expect(host).toBeVisible()
    await waitFor(() => expect(adapter.mount).toHaveBeenCalledOnce())
    expect(adapter.mount).toHaveBeenCalledWith(
      expect.objectContaining({ container: host }),
    )
  })
})
```

- [ ] **Step 2: Run the component test to verify it fails**

Run:

```bash
npm test -- src/chart/ChartWorkspace.test.tsx
```

Expected: FAIL because `ChartWorkspace.tsx` does not exist.

- [ ] **Step 3: Implement the lifetime-stable chart host**

`src/chart/ChartWorkspace.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import { createChartOptions } from './chart-config'
import { DemoDatafeed } from './demo-datafeed'
import {
  ProChartAdapter,
  type ChartAdapterPort,
} from './pro-chart-adapter'

export interface ChartWorkspaceProps {
  createAdapter?: () => ChartAdapterPort
}

const demoDatafeed = new DemoDatafeed()

export function ChartWorkspace({
  createAdapter = () => new ProChartAdapter(),
}: ChartWorkspaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const adapterRef = useRef<ChartAdapterPort | null>(null)

  if (adapterRef.current === null) {
    adapterRef.current = createAdapter()
  }

  useEffect(() => {
    if (hostRef.current === null) {
      throw new Error('Chart host was not mounted.')
    }
    adapterRef.current?.mount(createChartOptions(hostRef.current, demoDatafeed))
  }, [])

  return (
    <section className="chart-workspace" aria-label="行情图表">
      <div className="chart-host" data-testid="chart-host" ref={hostRef} />
    </section>
  )
}
```

Modify `src/main.tsx` to import Pro styles before application styles are evaluated:

```tsx
import '@klinecharts/pro/dist/klinecharts-pro.css'
import { createRoot } from 'react-dom/client'
import App from './app/App'

const rootElement = document.getElementById('root')
if (rootElement === null) {
  throw new Error('Root element #root was not found.')
}

createRoot(rootElement).render(<App />)
```

- [ ] **Step 4: Run focused tests and production build**

Run:

```bash
npm test -- src/chart/ChartWorkspace.test.tsx
npm run typecheck
npm run build
```

Expected: chart host test passes; production bundle contains Pro JavaScript and CSS without unresolved imports.

- [ ] **Step 5: Commit**

```bash
git add src/chart/ChartWorkspace.tsx src/chart/ChartWorkspace.test.tsx src/main.tsx
git commit -m "feat: mount KLineChart Pro in stable React host"
```

---

### Task 5: Historical and Read-Only Live Workstation Layout

**Files:**
- Create: `src/components/ModeSwitch.tsx`
- Create: `src/components/panels.tsx`
- Modify: `src/app/App.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/app.css`

**Interfaces:**
- Consumes: `ChartWorkspace`.
- Produces: mode type `WorkstationMode = 'history' | 'live'`; accessible buttons `历史模拟` and `实时行情`; stable panel test ids `simulation-panel`, `replay-controls`, and `live-status`.

- [ ] **Step 1: Replace the shell test with failing mode-behavior tests**

`src/app/App.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../chart/ChartWorkspace', () => ({
  ChartWorkspace: () => <div data-testid="chart-host" />,
}))

import App from './App'

describe('App', () => {
  it('shows simulator and replay controls in history mode', () => {
    render(<App />)
    expect(screen.getByTestId('simulation-panel')).toBeVisible()
    expect(screen.getByTestId('replay-controls')).toBeVisible()
    expect(screen.queryByTestId('live-status')).not.toBeInTheDocument()
  })

  it('keeps the chart but removes trading controls in live mode', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '实时行情' }))

    expect(screen.getByTestId('chart-host')).toBeVisible()
    expect(screen.queryByTestId('simulation-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('replay-controls')).not.toBeInTheDocument()
    expect(screen.getByTestId('live-status')).toHaveTextContent('只读')
  })
})
```

- [ ] **Step 2: Run tests to verify the mode assertions fail**

Run:

```bash
npm test -- src/app/App.test.tsx
```

Expected: FAIL because the placeholder shell has no mode buttons or panels.

- [ ] **Step 3: Add accessible mode switch and Phase 1 panels**

`src/components/ModeSwitch.tsx`:

```tsx
export type WorkstationMode = 'history' | 'live'

interface ModeSwitchProps {
  mode: WorkstationMode
  onChange: (mode: WorkstationMode) => void
}

export function ModeSwitch({ mode, onChange }: ModeSwitchProps) {
  return (
    <div className="mode-switch" aria-label="工作模式">
      <button
        aria-pressed={mode === 'history'}
        onClick={() => onChange('history')}
        type="button"
      >
        历史模拟
      </button>
      <button
        aria-pressed={mode === 'live'}
        onClick={() => onChange('live')}
        type="button"
      >
        实时行情
      </button>
    </div>
  )
}
```

`src/components/panels.tsx`:

```tsx
export function SimulationPanel() {
  return (
    <aside className="side-panel" data-testid="simulation-panel">
      <section>
        <h2>模拟账户</h2>
        <dl>
          <div><dt>余额</dt><dd>10,000.00 USDT</dd></div>
          <div><dt>权益</dt><dd>10,000.00 USDT</dd></div>
          <div><dt>浮动盈亏</dt><dd>0.00 USDT</dd></div>
        </dl>
      </section>
      <section>
        <h2>模拟下单</h2>
        <p>Phase 4 接入开仓、加仓、减仓、止盈、止损和强平。</p>
        <button disabled type="button">开多</button>
        <button disabled type="button">开空</button>
      </section>
    </aside>
  )
}

export function ReplayControls() {
  return (
    <section className="replay-controls" data-testid="replay-controls">
      <span>当前时间：尚未创建会话</span>
      <button disabled type="button">上一根</button>
      <button disabled type="button">下一根</button>
      <button disabled type="button">播放</button>
    </section>
  )
}

export function LiveStatus() {
  return (
    <aside className="side-panel" data-testid="live-status">
      <h2>实时行情</h2>
      <p>只读模式</p>
      <p>Phase 5 接入币安公开 WebSocket。</p>
    </aside>
  )
}
```

- [ ] **Step 4: Compose the permanent chart with mode-dependent panels**

`src/app/App.tsx`:

```tsx
import { useState } from 'react'
import { ChartWorkspace } from '../chart/ChartWorkspace'
import {
  ModeSwitch,
  type WorkstationMode,
} from '../components/ModeSwitch'
import {
  LiveStatus,
  ReplayControls,
  SimulationPanel,
} from '../components/panels'
import './app.css'

export default function App() {
  const [mode, setMode] = useState<WorkstationMode>('history')

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>加密货币合约回放工作站</h1>
        <ModeSwitch mode={mode} onChange={setMode} />
      </header>
      <div className="workspace-grid">
        <ChartWorkspace />
        {mode === 'history' ? <SimulationPanel /> : <LiveStatus />}
      </div>
      {mode === 'history' ? <ReplayControls /> : null}
      <footer className="status-footer">
        <span>KLineChart Pro</span>
        <span>{mode === 'history' ? '历史训练模拟' : '实时只读'}</span>
      </footer>
    </main>
  )
}
```

Replace `src/app/app.css` with:

```css
:root {
  color: #d8dee9;
  background: #0b0f14;
  font-family:
    Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  font-synthesis: none;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  width: 100%;
  min-width: 1024px;
  height: 100%;
  margin: 0;
}

button,
input,
select {
  font: inherit;
}

button {
  color: inherit;
  border: 1px solid #303b49;
  border-radius: 4px;
  background: #18212c;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.app-shell {
  display: grid;
  grid-template-rows: 56px minmax(0, 1fr) auto;
  width: 100%;
  height: 100%;
  background: #0b0f14;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid #242c37;
}

.app-header h1 {
  margin: 0;
  font-size: 17px;
}

.mode-switch {
  display: flex;
  gap: 6px;
}

.mode-switch button {
  padding: 7px 14px;
}

.mode-switch button[aria-pressed="true"] {
  color: #081018;
  border-color: #55b8ff;
  background: #55b8ff;
}

.workspace-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 288px;
  min-height: 0;
}

.chart-workspace,
.chart-host {
  width: 100%;
  height: 100%;
  min-height: 480px;
}

.chart-workspace {
  min-width: 0;
  border-right: 1px solid #242c37;
}

.side-panel {
  overflow: auto;
  padding: 16px;
  background: #10161f;
}

.side-panel section + section {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid #242c37;
}

.side-panel h2 {
  margin: 0 0 12px;
  font-size: 15px;
}

.side-panel dl {
  margin: 0;
}

.side-panel dl div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin: 8px 0;
}

.side-panel dd {
  margin: 0;
}

.side-panel button {
  margin-right: 8px;
  padding: 8px 20px;
}

.replay-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  padding: 8px 16px;
  border-top: 1px solid #242c37;
}

.replay-controls button {
  padding: 6px 12px;
}

.status-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  color: #8f9bab;
  border-top: 1px solid #242c37;
  font-size: 12px;
}
```

- [ ] **Step 5: Verify modes, type safety, and production bundle**

Run:

```bash
npm test -- src/app/App.test.tsx
npm run check
```

Expected: both mode tests pass, all unit tests pass, type checking exits 0, and the production build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/app src/components
git commit -m "feat: add history and read-only live layouts"
```

---

### Task 6: Browser Smoke Test

**Files:**
- Modify: `package.json`
- Create: `playwright.config.ts`
- Create: `e2e/app-shell.spec.ts`

**Interfaces:**
- Consumes: built workstation and stable `chart-host` test id.
- Produces: npm script `test:e2e` and a Chromium smoke test.

- [ ] **Step 1: Add the failing browser test and script**

Replace the `scripts` object in `package.json` with:

```json
{
  "dev": "vite",
  "build": "tsc -b && vite build",
  "typecheck": "tsc -b --pretty false",
  "test": "vitest run",
  "test:e2e": "playwright test",
  "check": "npm run typecheck && npm run test && npm run build"
}
```

`e2e/app-shell.spec.ts`:

```ts
import { expect, test } from '@playwright/test'

test('renders Pro chart shell and keeps live mode read-only', async ({ page }) => {
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: '加密货币合约回放工作站' }),
  ).toBeVisible()
  await expect(page.getByTestId('chart-host')).toBeVisible()
  await expect(page.getByText('指标', { exact: true })).toBeVisible()
  await expect(page.getByText('15m', { exact: true })).toBeVisible()
  await expect
    .poll(async () => page.getByTestId('chart-host').locator('canvas').count())
    .toBeGreaterThan(0)

  await page.getByRole('button', { name: '实时行情' }).click()
  await expect(page.getByTestId('live-status')).toContainText('只读模式')
  await expect(page.getByTestId('simulation-panel')).toHaveCount(0)
  await expect(page.getByTestId('replay-controls')).toHaveCount(0)
})
```

- [ ] **Step 2: Run the browser test to verify configuration is missing**

Run:

```bash
npm run test:e2e
```

Expected: FAIL because `playwright.config.ts` does not exist and no local web server is configured.

- [ ] **Step 3: Configure a deterministic local Vite server**

`playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
})
```

- [ ] **Step 4: Install Chromium and run smoke test**

Run:

```bash
npx playwright install chromium
npm run test:e2e
```

Expected: one Chromium test passes and observes at least one canvas inside the Pro chart host.

- [ ] **Step 5: Run the complete local gate**

Run:

```bash
npm run check
npm run test:e2e
```

Expected: all commands exit 0 with zero unit or browser test failures.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json playwright.config.ts e2e
git commit -m "test: add browser smoke coverage"
```

---

### Task 7: CI, GitHub Pages Deployment, and Phase 1 Documentation

**Files:**
- Create: `tests/deployment-config.test.ts`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy-pages.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: npm scripts `check` and `test:e2e`.
- Produces: CI workflow, Pages artifact deployment, documented local commands, and executable deployment assertions.

- [ ] **Step 1: Write a failing deployment configuration test**

`tests/deployment-config.test.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('deployment configuration', () => {
  it('builds with the repository Pages base path and no secrets', async () => {
    const workflow = await readFile(
      '.github/workflows/deploy-pages.yml',
      'utf8',
    )
    expect(workflow).toContain('VITE_BASE_PATH: /crypto_contract_workstation/')
    expect(workflow).toContain('actions/deploy-pages@v4')
    expect(workflow).not.toMatch(/TOKEN|API_KEY|SECRET_KEY/)
  })

  it('runs type, unit, build, and browser checks in CI', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8')
    expect(workflow).toContain('npm run check')
    expect(workflow).toContain('npm run test:e2e')
    expect(workflow).toContain('playwright install --with-deps chromium')
  })
})
```

- [ ] **Step 2: Run the deployment test to verify it fails**

Run:

```bash
npm test -- tests/deployment-config.test.ts
```

Expected: FAIL with `ENOENT` because the workflow files do not exist.

- [ ] **Step 3: Add CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Typecheck, unit test, and build
        run: npm run check
      - name: Install Playwright Chromium
        run: npx playwright install --with-deps chromium
      - name: Browser smoke test
        run: npm run test:e2e
```

- [ ] **Step 4: Add GitHub Pages deployment workflow**

`.github/workflows/deploy-pages.yml`:

```yaml
name: Deploy GitHub Pages

on:
  workflow_dispatch:
  push:
    branches:
      - main

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Verify
        run: npm run check
      - name: Build Pages artifact
        run: npm run build
        env:
          VITE_BASE_PATH: /crypto_contract_workstation/
      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 5: Replace README with Phase 1 operating instructions**

`README.md`:

```markdown
# Crypto Contract Replay Workstation

纯前端的币安 USDT 永续合约历史回放与实时行情工作站。

## 当前阶段

Phase 1 提供：

- Vite + React + TypeScript 静态应用；
- KLineChart Pro 图表；
- 交易对、周期、指标、画线、时区、截图和全屏能力；
- 历史模拟与实时只读的工作台布局；
- 确定性演示行情；
- GitHub Pages 部署。

Phase 1 不连接币安，也不执行模拟交易。相关能力将在后续阶段实现。

## 本地运行

```bash
npm ci
npm run dev
```

打开终端显示的本地地址。

## 验证

```bash
npm run check
npx playwright install chromium
npm run test:e2e
```

## 构建

```bash
npm run build
```

构建产物位于 `dist/`。

## GitHub Pages

`main` 分支通过 `.github/workflows/deploy-pages.yml` 构建并发布。仓库 Pages 路径固定为：

```text
/crypto_contract_workstation/
```

项目不需要后端，不接受币安 API Key，也不会发送真实订单。

## 文档

- [产品需求](./项目需求-v2.md)
- [批准的设计](./docs/superpowers/specs/2026-07-22-static-crypto-replay-workstation-design.md)
- [Phase 1 实施计划](./docs/superpowers/plans/2026-07-22-phase-1-static-chart-foundation.md)
```

- [ ] **Step 6: Run deployment tests and full gate**

Run:

```bash
npm test -- tests/deployment-config.test.ts
npm run check
npm run test:e2e
git diff --check
```

Expected: two deployment assertions pass, all unit/browser tests pass, production build succeeds, and Git reports no whitespace errors.

- [ ] **Step 7: Inspect the production artifact for secrets and bad absolute asset paths**

Run:

```powershell
Get-ChildItem -Recurse -File dist | Select-String -Pattern 'ghp_|github_pat_|API_KEY|SECRET_KEY'
Get-Content -Raw dist/index.html
```

Expected: the secret scan returns no matches; every generated JavaScript/CSS asset URL in `dist/index.html` starts with `/crypto_contract_workstation/` when built with `VITE_BASE_PATH=/crypto_contract_workstation/`.

- [ ] **Step 8: Commit**

```bash
git add .github README.md tests
git commit -m "ci: deploy static workstation to GitHub Pages"
```

---

## Phase 1 Completion Gate

Before declaring Phase 1 complete, run from a clean checkout:

```bash
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
git status --short
```

Required evidence:

- TypeScript reports zero errors.
- Vitest reports zero failed tests.
- Vite production build exits 0.
- Playwright Chromium smoke test passes.
- The Pro chart host contains at least one rendered canvas.
- Historical mode shows simulator/replay placeholders.
- Live mode removes all trading controls and says `只读模式`.
- `git status --short` is empty after the final commit.

After this gate passes, write a separate Phase 2 plan for Binance public REST data, symbol discovery, historical K-line downloads, mark-price K-lines, and IndexedDB caching.
