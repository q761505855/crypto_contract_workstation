# History and Cloud Storage Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task; independent modules may use superpowers:dispatching-parallel-agents. Preserve current workspace changes.

**Goal:** Archive-first one-minute historical data, automatic history cloud storage, and default project-scoped configuration sync.

**Architecture:** Inject an archive client and optional history cloud adapter into MarketDataService. Store canonical minutes in IndexedDB, aggregate at read time, and process explicit downloads by month. GitHub clients scope relative paths to a project prefix; configuration retains existing archive semantics.

**Tech Stack:** React, TypeScript, IndexedDB, decimal.js, fflate 0.8.3, Vite, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-11-05-history-archive-design.md

## Global Constraints

- Cloud: q761505855/personal-cloud-storage, main, projects/crypto-contract-workstation.
- Do not print credentials or store them in backups; build defaults consume ignored .env.local.
- No new remembered user preferences; all existing BackupPreferences round-trip tests remain complete.
- Preserve other project namespaces, all unrelated cloud manifest entries, and existing multi-period archives.
- Month/day archives precede REST; only current UTC day and previous day without available daily archive may use REST.
- User approved implementation. Execute continuously without another design or execution confirmation.

## Review Focus

- Remote month containing more candles than this browser must not be truncated by upload (Task 3).
- Missing tail must fail explicit replay/download, rather than shorten its end (Task 4).
- Month-spanning aggregation and replay partial bars must not expose future minutes (Tasks 2/4).
- Cancellation and corrupt archives must not write invalid/partial batches (Tasks 1/4).
- Default cloud must be disabled in ordinary test fixtures, with no live token writes (Tasks 3/5).

### Task 1: Verified Binance archive reader

Files: src/market-data/archive-client.ts and archive-client.test.ts; fflate package dependency.

Interface: BinanceArchiveClient(fetcher = fetch).loadMonth(kind, symbol, year, month, options?: {signal?: AbortSignal}): Promise<MarketCandle[] | null>; loadDay(kind, symbol, year, month, day, options?): same. null only on 404; all other failures throw. Canonical output is validated, closed 1m candles; SHA-256 ZIP verification and exact CSV name required. Reject malformed rows, duplicate/out-of-period timestamps, incorrect OHLC, noninteger trades, nonminute times; allow CSV header. Use fflate.unzipSync filter to read only expected member.

- [x] Write failing tests for month URLs, marks, checksum, CSV header, missing vs failed, corrupt timestamps and cancellation.
- [x] Implement; run focused Vitest tests to green.

### Task 2: Minute aggregation and range helpers

Files: src/market-data/aggregate-candles.ts, history-ranges.ts, corresponding tests.

Interfaces: aggregateMinuteCandles(candles: readonly MarketCandle[], timeframe: string, visibleUntil?: number): MarketCandle[]; visibleUntil exclusive defaults Infinity, filters future and unfinished minutes; emit full contiguous groups, plus a contiguous partial final group only when explicit visibleUntil truncates that bucket (isClosed false). Do not mutate inputs. expandHistoryRange(from,to,now=Date.now(),onboardDate=0): {from:number,to:number}, expands UTC months, clamps to last closed minute and onboard ceil; invalid input throws. historyMonths(from,to): Array<{year:number,month:number,from:number,to:number}>.

- [x] Failing tests for all supported periods, exact decimal sums, gaps, calendar boundaries, partial no-future, month range/launch/future.
- [x] Implement and run focused tests.

### Task 3: Default project-scoped cloud history storage

Files: src/github-sync/* only, new default-storage.ts and history-store.ts plus tests; do not edit runtime/components.

Interfaces: defaultStorageTarget(): GitHubRepositoryTarget including optional root; createDefaultGitHubClient(): GitHubContentsClient | null (no VITE_GITHUB_TOKEN returns null, public reads allowed separately). GitHubHistoryStore(client) exposes loadMonth(symbol,year,month,options?:{signal?:AbortSignal}): Promise<{tradeCandles:MarketCandle[],markCandles:MarketCandle[],symbolInfo?:MarketSymbol}|null>; saveMonth(symbol,year,month, tradeCandles:readonly MarketCandle[],markCandles:readonly MarketCandle[],symbolInfo?:MarketSymbol):Promise<void>. New path data/market-history/SYMBOL/1m/YYYY/MM.json.gz; read legacy market-data too. Strict validation via backup validator before any write.

- [x] Failing tests for unauthenticated read, project prefix and traversal rejection, >1MiB raw content, immutable remote snapshots/conflicts, merging partial month and preserving other entries, unchanged content skipped, complete config round-trip.
- [x] Implement robust writes and integrate new history paths into existing sync service. Existing API constructors remain backward compatible.
- [x] Default target uses VITE vars with safe literal defaults; token never exported by backups. Run github focused tests.

### Task 4: Canonical-minute service and chart/replay integration

Files: market-data-service.ts/tests, runtime.ts, binance-datafeed.ts/tests, replay/useReplayController.ts/tests, pro-chart-adapter as needed.

Service constructor third optional arg {archives,cloud?,now?}; runtime always inject archives and default cloud; existing tests will be upgraded to cover real archive mode rather than weaken assertions. Expose prepareHistory(symbol,from,to,options?) returning actual {from,to}, callbacks onStatus?. Existing loadCandles is view-range (can be large for explicit callers); prepareHistory guarantees expanded month both kinds, full coverage. Minute load consults local, cloud, month, day, recent REST, all kinds remain distinct. Schedule cloud upload after saved downloads; expose retryPendingUploads and pending count/status. Cache reads aggregate minutes, with legacy period records only as fallback. Keep replay read boundaries and cold chart requests bounded to month-sized work; explicit ranges never bounded.

- [x] Tests first: archive-first no old REST, full month/cross-month/tail, concurrent reuse, recent fallback, no future, marks and upload failure retained.
- [x] Implement; useReplayController checks expected end and full selected range, not returned end.
- [x] Run service/datafeed/replay tests to green; retain existing safeguards.

### Task 5: Data management UI, default sync, documentation and end-to-end

Files: DataManager.tsx, BackupSyncPanel.tsx, README.md, docs/cloud-storage.md, docs/configuration-archiving.md, e2e/*.

- [x] Data manager download is fixed 1m regardless of chart period; default month range, preview actual UTC month coverage, one-click both kinds, progress, cancel, pending-upload retry. Cache stats/export show minute source.
- [x] Backup panel defaults owner/repo/branch/root and in-memory build token without displaying it; manual config compare/upload/pull remains, defaults require no entry. Preserve manual old root compatibility explicitly.
- [x] Playwright mock archives and GitHub (disable real default credential in tests); cold Sep2025 jump, full download and aggregation, default cloud upload/readback/isolation, config existing roundtrip.
- [x] Update docs with implemented status and coverage/compatibility. Run npm run check and relevant Playwright, fresh reviewer, fix material findings with regression tests.

## Progress

- Baseline earlier: 213 tests passed; current changes before implementation are documentation and .gitignore only.
- Working branch: codex/archive-cloud-storage. In-place branch preserves user's approved local env and documentation; no destructive reset or worktree migration.
- Tasks1–5 complete and verified; code remains on the local feature branch, not pushed or deployed.
- npm run check: 351 tests passed, typecheck and build passed (2026-11-05).
- Fresh review findings fixed with RED/GREEN regressions: bounded indicator reads, shared-repository root under branch/case edits.
- Replay chart period switches also use calendar-sized reads; a regression proves a weekly switch cannot silently request years of minute archives. Explicit download/session preparation retains its full selected range.
- A deferred replay request restarting across a mode boundary no longer reselects its old period over a newer user selection; RED/GREEN regression covers replay exit.
- Complete canonical cache hits bypass the per-symbol network queue. A deferred-month regression verifies a cached historical jump remains available while another month is downloading.
- Foreground chart status is scoped to its current active request. Old loads, completed upload callbacks and silent indicator work cannot overwrite a newer jump; two RED/GREEN regressions cover these paths.
- A separate persistent footer badge exposes pending upload months outside Data Manager, opens retry controls, and disappears after successful upload. Unit and browser failure/retry tests cover it; the queue remains device state outside backups.
- Official Binance archive and checksum GET responses were verified with the deployed Pages origin; both allow cross-origin reads. Real September archives and GitHub round-trip checks are independent of browser mocks.
- Integration regressions fixed: aborted cloud reads retry; negative cloud cache invalidated after upload; local preparation does not await upload; unchanged minute records are not rewritten; config-only sync does not export/reimport market history.
- Native IndexedDB batch failure now aborts the entire batch; range deletes avoid per-minute cursors. Full backup import uses native batch requests and one transaction completion promise, retaining pre-write validation and transaction atomicity; a forced second-write failure rolls back symbols and all earlier candles before preferences can change.
- Isolated native Chromium backup-import benchmark:43,200 minute records,8,978ms before native batching versus3,361ms after (~2.67x faster); persisted count verified in both cases.
- Full restore compares validated incoming market rows against scoped local ranges inside the same atomic write transaction, avoiding unchanged minute rewrites while restoring changed/new rows. Regression checks both skipped writes and final candle values.
- Actual full-pull snapshot reproduced in isolated native Chromium:360,701 market rows preserved, identical pull4,886ms with12 metadata/session writes. Initial empty-database native seed121,021ms confirms large cold imports take substantially longer than cached round-trips.
- Actual Binance→GitHub→verified readback: BTCUSDT September2025,43200 trade and43200 mark minutes; project namespace preserved.
- Pages CLOUD_STORAGE_TOKEN secret configured. Browser artifacts use a dummy token; final build and verifier accept only the explicitly configured credential.
- Final browser regressions passed in batches: archive/month preparation and cloud readback, default configuration round-trip, persistent failed-upload retry, HTTP418 protection, favorites and Supertrend, and the complete Pro scenario (3.2min) including explicit cloud-restore success. Pages subpath320px layout and default-config round-trip both passed.
