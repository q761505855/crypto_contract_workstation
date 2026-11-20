# cTrader Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal** — Switch the experimental workstation to direct, read-only cTrader demo market data while preserving its chart, simulation, replay, and application archives.

**Architecture** — The browser uses one cTrader JSON socket for authentication, symbol lookup, native trendbar requests, and multiplexed chart subscriptions. Replay steps on closed native candles. Existing backup formats remain readable, while browser and GitHub data use experimental namespaces.

**Tech stack** — TypeScript, React, WebSocket, IndexedDB, Vite, Vitest, Playwright.

**Spec** — [cTrader design](../specs/2026-11-20-ctrader-only-market-data-design.md)

## Global constraints

- Implement on `codex/ctrader-only`. Production Pages remains on `main`.
- The demo WebSocket is the only live market source. Use native `1m`, `2m`, `3m`, `4m`, `5m`, `10m`, `15m`, `30m`, `1h`, `4h`, `12h`, `1d`, `1w`, `1M` candles.
- Authenticate the application, verify the token allows only the specified demo account, then verify `SCOPE_VIEW` before requesting market data. Publish a populated connection configuration only after actual verification. Exclude refresh tokens and GitHub credentials from that configuration.
- Cloud writes stay under `projects/crypto-contract-workstation/experiments/ctrader/`. Application archives retain old formats and omit credentials. Market history is memory-only.

## Review focus

- Socket replacement cannot route previous chart selections into a current chart.
- Retries and truncated history cannot skip native candles or mistake weekends for gaps.
- Higher-period views reveal only completed bars, and replay resumes using the stored source and cursor.
- Existing Binance sessions remain readable, and invalid imports fail before writes.
- Cloud requests cannot overwrite the production namespace or upload market data through a legacy path.

### Task 1 — cTrader protocol and native market data

**Files** — `src/market-data/ctrader-client.ts`, `ctrader-market.ts`, focused tests, `models.ts`, and `intervals.ts`.

**Interfaces** — `CTraderMarketService` provides native symbol discovery, `loadCandles('trade', symbol, timeframe, from, to, options)`, streaming callbacks, and market status. `MarketCandle` preserves Binance archive compatibility and adds the cTrader source and tick volume. Native timeframe validation is separate from legacy archive validation.

- [x] Write and run fake-socket tests for authorization, pagination, reconnect, and subscriptions.
- [x] Implement official IDs, request correlation, heartbeat, native candle decoding, symbol metadata, throttling, cancellation, scheduling, and subscription restoration.
- [x] Run focused market tests. The four market and compatibility suites passed, and the production check includes these suites.

### Task 2 — Native replay and charts

**Files** — `src/replay/`, `src/components/ReplayControls.tsx`, native replay tests.

**Interfaces** — Native controller and replay datafeed consume the `CTraderMarketService` history interface and use the existing application replay contracts. `ReplaySession` has optional `marketSource` for legacy input, with `ctrader` written for new sessions.

- [x] Write failing tests for weekend navigation, completed-only higher bars, simulation events, and refusal to resume legacy sessions in cTrader.
- [x] Implement native playback and replay chart adapters. Preserve the legacy formats for JSON and IndexedDB.
- [x] Run replay and browser integration tests. The browser verified 1m steps on a 2m chart and restoration of a simulated position after reload.

### Task 3 — Storage isolation and legacy archives

**Files** — `src/storage/`, preference readers and writers, `src/github-sync/`, relevant archive tests, archive and cloud documentation.

**Interfaces** — Production browser data is isolated through explicit storage keys and database names. `defaultStorageTarget()` targets the cTrader experiment directory. Archive backup and sync services provide an experiment mode that validates old input and excludes market-history operations.

- [x] Add failing tests for preference, drawing, session, GitHub namespace, market exclusion, and legacy/missing values.
- [x] Wire isolated storage for the main app and chart views, and carry source through JSON and cloud session codecs. Preserve checksum and conflict handling.
- [x] Run archive, preference, and sync tests. The production check includes JSON restoration and GitHub snapshots with an invalid but correctly checksummed session.

### Task 4 — Static app integration and acceptance

**Files** — `src/market-data/runtime.ts`, `src/app/App.tsx`, `src/chart/`, `src/components/`, static connection config, `e2e/`, and `README.md`.

**Interfaces** — The default runtime constructs the cTrader service, datafeed, and archive services. Chart and replay selectors use native periods and experiment preferences. The static deployment can load same-origin `ctrader-connection.json`.

- [x] Add browser coverage for native chart requests, replay, configuration restore and the removed market-history controls.
- [x] Wire the runtime, picker, status, archive controls and static config template.
- [x] Run `npm run check` (821 tests), `npm run test:e2e` (6 tests), and `npm run test:e2e:pages` (8 tests). Address the independent review findings and run the regressions again.
- [ ] Run the five-symbol real demo verification. The supplied token returned `SCOPE_VIEW` for two accounts, so it fails the agreed publication condition. The committed connection file is a blank template.
