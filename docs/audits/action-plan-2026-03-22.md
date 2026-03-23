# Action Plan — 2026-03-22

Re-audited against current `main` on 2026-03-23. Every previously open item was checked against the cited code paths before being kept, re-prioritized, or dropped. The remaining work is ranked by actual production impact; stale, theoretical, duplicate, or already-mitigated findings are in Dropped.

## P0 — Fix now
None.

## P1 — Fix soon

None.

## P2 — Backlog

- [ ] ERROR-HANDLING-003: `adminVerifyPage` wraps all failures as `400 Bad Request`, including unexpected server-side errors. File: `apps/runtime/src/api/server.ts:1600-1626`. Fix: only convert domain validation and credential errors into 400s; let unexpected failures propagate as 500s.
- [ ] ERROR-HANDLING-004: Failed-login audit writes can still turn a normal bad-password path into a `500` instead of a `401`. File: `apps/runtime/src/services/auth.ts:423-440`. Fix: make failed-login auditing best-effort, or defer it so an audit insert failure cannot replace the intended auth response.
- [ ] FRONTEND-005: `ChatPreviewPanel` still renders the generic empty state when the preview request fails. File: `apps/dashboard/src/components/page/crm/ChatPreviewPanel.tsx:12-29`. Fix: handle `isError` explicitly so a failed preview load is distinguishable from a genuinely empty conversation.
- [ ] FRONTEND-006: `DbStatsPage` labels its first migration column "Name", but renders a hash prefix instead. File: `apps/dashboard/src/pages/dev/DbStatsPage.tsx:90-120`, `packages/contracts/src/routes.ts:1605-1613`, `apps/runtime/src/api/server.ts:1748-1759`. Fix: either rename the column to match the actual data, or extend the API to return a real migration name instead of duplicating hash-like identifiers.
- [ ] FRONTEND-007: `FanProfilePage` still uses `navigate(-1)` for Back navigation. File: `apps/dashboard/src/pages/FanProfilePage.tsx:151-154`. Fix: use a route-aware fallback so direct-entry pages stay inside the app instead of depending on browser history state.
- [ ] PERFORMANCE-010: `listCrmRetention` still executes the same heavy retention CTE three times for total, counts, and rows. File: `packages/db/src/repositories/crm.ts:912-983`. Fix: materialize `filtered` once or return counts and rows from a single query path instead of recomputing the full CTE for each result shape.
- [ ] RELIABILITY-016: Same-day custom ranges still silently become a zero-width `[from, from)` window. File: `packages/shared/src/time.ts:231-251`. Fix: treat same-day custom ranges as an inclusive single day, or reject them explicitly instead of returning an empty window silently.
- [ ] RELIABILITY-018: Telegram sends still have no explicit timeout or bounded retry policy. File: `apps/runtime/src/services/telegram.ts:81-125`. Fix: wrap `fetch` with an `AbortSignal` timeout and a small retry policy so hung Telegram calls cannot block requests or worker jobs indefinitely.
- [ ] RELIABILITY-020: Unknown transaction types still fall through to `other` without any warning or telemetry. File: `packages/fansly/src/mappers.ts:30-34`, `packages/onlyfans/src/mappers.ts:5-20`. Fix: emit a warning log or sync telemetry event whenever an unmapped raw transaction type falls through.
- [ ] API-CORRECTNESS-008: Search endpoints still treat `%` and `_` inside user queries as SQL wildcards. File: `packages/db/src/repositories/crm.ts:85-88`, `packages/db/src/repositories/reporting.ts:351-363`, `packages/db/src/repositories/spenders.ts:1017-1032`. Fix: escape `%` and `_` before building `ILIKE` patterns and use consistent `ESCAPE '\\'` semantics across the affected queries.
- [ ] CONFIGURATION-009: `drizzle.config.ts` still passes an empty string when `DATABASE_URL` is missing, which fails late and unclearly. File: `packages/db/drizzle.config.ts:3-9`. Fix: throw a clear configuration error before invoking drizzle-kit when `DATABASE_URL` is unset.
- [ ] TEST-GAPS-002: Integration suites allow 30s container startup in the helper, but still rely on Vitest's shorter default hook budget. File: `tests/helpers/db.ts:11-13`, `vitest.config.ts:18-24`, `tests/api.integration.test.ts:3-58`. Fix: raise hook and test timeouts to match the Testcontainers startup budget used by the integration harness.
- [ ] TEST-GAPS-003: `listenOnLoopback()` still calls `removeAllListeners("error")` on the shared server. File: `tests/helpers/network.ts:10-15`. Fix: remove only the helper's own one-shot error listener instead of clearing unrelated listeners from the server instance.

## Done

- [x] CONCURRENCY-002: Fixed the `openNotificationIncident` race so concurrent callers no longer fail each other. Commit: `77b48c38593b`.
- [x] RELIABILITY-001: Fixed sync job completion ordering so continuation wakeup failures no longer strand execution. Commit: `1e4caf5d3622`.
- [x] API-CORRECTNESS-002: Fixed credentials updates so stored proxies can be cleared. Commit: `4e778a2d42e4`.
- [x] DATA-INTEGRITY-002: Fixed Fansly raw type `20001` so it maps to `tip`. Commit: `3537148440af`.
- [x] DATA-INTEGRITY-004: Fixed follower finalization so writes, deactivation, rollups, and checkpointing stay transactional. Commit: `5d9a496762bc`.
- [x] DATA-INTEGRITY-005: Fixed OnlyFans empty-window cleanup semantics. Commit: `541b83f7929a`.
- [x] DATA-INTEGRITY-007: Fixed subscriber finalization so deactivation and checkpoint advancement stay transactional. Commit: `8b9e051f3f8c`.
- [x] ERROR-HANDLING-001: Fixed advisory lock release handling so unlock failures no longer replace the original business error. Commit: `380b944244ce`.
- [x] ERROR-HANDLING-002: Extended sensitive text redaction to database URLs and similar credential-bearing strings. Commit: `05ce6b68f824`.
- [x] RELIABILITY-003: Fixed Fansly query param serialization so `offset=0` and `limit=0` are preserved. Commit: `c92baafdd0f4`.
- [x] RELIABILITY-005: Fixed OnlyFans per-egress serialization so categories on the same egress no longer overlap. Commit: `b28489256438`.
- [x] SECURITY-001: Fixed API key rotation so the replacement key is created safely before old keys are revoked. Commit: `360d5e6ccf23`.
- [x] SECURITY-005: Fixed password reset flow so hash update, session revocation, and audit logging are atomic. Commit: `211c2a662320`.
- [x] SECURITY-007: Added stored-secret key-ring support and clearer decrypt-failure telemetry. Commit: `d0b5c36ceaad`.
- [x] TYPE-SAFETY-001: Fixed `loadConfig(customEnv)` so dotenv respects the passed env object. Commit: `36d1ef8`.
- [x] CONFIGURATION-001: Fixed migration path resolution and missing-directory handling. Commit: `454a24b`.
- [x] FRONTEND-002: Fixed `SubscribersPage` so client-side re-sorting no longer breaks pagination order. Commit: `308ae47`.
- [x] FRONTEND-003: Fixed `useSpenderBatch` so it no longer issues side-effecting POSTs from `useQuery`. Commit: `38530d3`.
- [x] PERFORMANCE-001: Fixed OnlyFans account lookup so it stops paginating once a unique username match is found. Commit: `2af97e0`.
- [x] PERFORMANCE-002: Moved terminal proxy-failure detection into SQL and out of the in-memory 2,000-row scan. Commit: `ae516f8`.
- [x] PERFORMANCE-003: Fixed the DM conversation N+1 query inside the sync page loop. Commit: `58dfa08`.
- [x] API-CORRECTNESS-003: Stopped exposing unsupported `content_manager` creation from product flows. Commit: `72206cde7716`.
- [x] CONFIGURATION-003: Added a compose migrator gate so schema bootstraps before runtime services start. Commit: `69ac525dd4fd`.
- [x] DATA-INTEGRITY-008: Fixed OnlyFans backfill resume parsing so current cursor/window state survives restarts. Commit: `9e91fb6b504f`.
- [x] PERFORMANCE-006: Added resumable in-loop budget yielding for incremental OnlyFans rescans. Commit: `efafe0bc95df`.
- [x] RELIABILITY-010: Changed Telegram daily reports to catch up by missing due dates instead of exact current hour. Commit: `926a1a8b606b`.
- [x] API-CORRECTNESS-009: Added explicit Telegram credential clearing across the contract, API, and dashboard. Commit: `306bf8faf46b`.

## Dropped

- CONFIGURATION-002: `.env.example` and `.env.docker.example` intentionally omit vars that already have safe runtime defaults; the current templates still boot cleanly.
- CONFIGURATION-004: The shared runtime image is already built on the normal full-stack compose path; the worker-only `docker compose up worker` case is edge developer ergonomics, not a meaningful defect.
- CONFIGURATION-005: `runMigrations()` is already module-relative; the remaining `contracts:generate` cwd sensitivity only affects ad hoc invocation outside the scripted repo-root path.
- CONFIGURATION-007: Duplicate-prefix migration drift is already blocked by `assertUniqueMigrationPrefixes()`, and the remaining "latest migration only" guard would need manual schema tampering to misfire.
- CONFIGURATION-008: No longer reproducible on 2026-03-23; `pnpm typecheck` and `pnpm test` both pass on current `main`.
- CONCURRENCY-003: The unique constraint already prevents cross-row identity collisions, and the remaining same-row race needs contradictory concurrent identity writes for one page, which current call paths do not realistically produce.
- API-CORRECTNESS-001: The follower adapter's `total` value is not used for dashboard pagination or destructive sync logic anywhere in the current code.
- API-CORRECTNESS-004: The DST ambiguity is real in the abstract, but current business-date call paths use UTC, so the problematic generic-timezone case is not exercised.
- API-CORRECTNESS-005: I found no current breakage tied to the `referrer` header spelling in the live adapter behavior; this is speculative without a failing path.
- DATA-INTEGRITY-003: `fanUpsertPresenceKey()` is a future-maintainer footgun, not a current data-integrity bug in shipping behavior.
- DATA-INTEGRITY-006: The overview path hardcodes `"fansly"` for subscriber and follower business dates, but both current platforms resolve to UTC, so behavior is unchanged today.
- DATA-INTEGRITY-010: Current checkpoint writers always persist a real `windowEnd`; the null fallback only matters for corrupted checkpoint state.
- FRONTEND-004: No current UI exposes the `custom` period state, so this is dormant product surface rather than a live regression.
- FRONTEND-008: The multi-touchpoint state is unreachable in the current single-select CRM filter UI.
- PERFORMANCE-007: The contract layer is sloppy, but the repository path already clamps conversation-message fetches to 100 rows.
- PERFORMANCE-009: The route schema is unbounded, but the sync-monitor service already clamps this path to `MAX_REQUEST_LIMIT = 500`.
- RELIABILITY-012: The cited call sites only consume provider amounts and prices that are already mill-precision or less in current flows; I found no failing path from extra decimals.
- RELIABILITY-015: This is already covered by the SQL newest-attempt fix from PERFORMANCE-002; the current code orders proxy-failure checks from newest to oldest and has regression coverage.
- RELIABILITY-019: The mismatch only matters if a request crosses a business-day boundary between adjacent `new Date()` calls inside one handler, which is too theoretical to prioritize.
- SECURITY-004: Stale audit item; `.dockerignore` already excludes `.env*`, session files, and other local secrets from Docker build context.
- SECURITY-008: `Buffer`/`Date` handling in `redactLogValue()` is inelegant, but I found no current call path that logs secret-bearing buffers or dates in a way that changes real exposure.
- TEST-GAPS-001: The current adapter test suite is not paying meaningful real-time waits here; this is no longer an active bottleneck.
- TEST-GAPS-004: The helper is test-only, and the single `TRUNCATE ... CASCADE` statement is already atomic; wrapping it in an extra transaction is low-value cleanup.
- TEST-GAPS-005: The current workspace install resolves these React aliases successfully, and the full suite is green.
- TEST-GAPS-006: No longer reproducible on 2026-03-23; the follower pacing test passes in the full suite.
- TYPE-SAFETY-003: Fastify and Zod already validate this route body at runtime; the remaining `as any` is compile-time hygiene only.
- TYPE-SAFETY-004: The envelope `alg` field is not a security boundary in this code path; decryption already uses a fixed algorithm and malformed payloads fail authentication.
- TYPE-SAFETY-006: The current optional `canonicalType` schema matches the live grouped and ungrouped revenue responses, and coverage exists in `tests/api.integration.test.ts`.
- TYPE-SAFETY-008: Every current caller seeds the singleton row before `updateTelegramSettings()`, so the undefined return path is theoretical in the shipping product.
- DOCUMENTATION-001: The README and compose references now match the current production deployment flow closely enough that this is no longer a meaningful action item.
- CONCURRENCY-001: The read and replacement of `fetchLock` happen synchronously with no `await`, so two workers cannot observe the same promise chain.
- DATA-INTEGRITY-001: The math claim is wrong. For integer half-up division, adding floor(divisor / 2) before dividing is the standard rule, including odd divisors, so there is no rounding bug to reproduce here.
- TYPE-SAFETY-002: The onboarding helper's catch path always rethrows, and the transaction callback always returns the created page. There is no real runtime path where `page` reaches the caller as `undefined`.
- CONCURRENCY-004: The `!` is a type escape, but not a concurrency bug. In the actual insert race, one caller inserts and the other caller's second `findFirst()` reads that row; the concurrent insert case does not make this path return `undefined`.
- FRONTEND-001: The CRM retention query already guarantees `subscriptionExpiresAt` for these rows, so the non-null assertion is safe under the current contract.
- RELIABILITY-002: `hasScheduledReportForDate()` only suppresses retries for rows with `status = sent`, so failed deliveries do not block retries.
- RELIABILITY-004: The shared OnlyFans limiter only defines a global scope today, so omitting a category scope there is consistent with the current model.
- RELIABILITY-006: Throwing immediately on paused or disabled streams is the intended early-exit behavior for this operator-facing wait path.
- SECURITY-002: The reachable call path normalizes missing proxy credentials to `null`, not `undefined`, before `buildProxyAuthToken()` runs. The spurious `Basic Og==` case is theoretical against the raw type, but not against the actual caller behavior.
- SECURITY-003: The all-zero key is only used to boot the app in the OpenAPI generation path. I found no path in that mode that decrypts or persists real secrets, so this is not an active cryptographic weakness in the running product.
- SECURITY-006: The local `.env` and `.env.docker` files do contain matching keys on this machine, but they are not tracked by git. This is a local environment hygiene issue, not a repository secret-exposure bug.
- CONFIGURATION-006: `resolveFanslyDefaultDelayEnvSource()` and `loadConfig()` are fed from the same env object in real call sites; the claimed mismatch is theoretical.
- DATA-INTEGRITY-009: The current state model has no dedicated reversal state, and transaction typing already carries the stronger semantic signal.
- DEAD-CODE-001: `severity` is an unused prop, but the cost is trivial and there is no behavior attached to it. This is cleanup only.
- ERROR-HANDLING-005: The exhausted-retries message can become generic when retry metadata does not carry a final error object, but the detailed failures are still logged and request-observed elsewhere. This is diagnostics polish, not a high-value fix.
- PERFORMANCE-004: Chunk request budgets should count real HTTP attempts, including retries; otherwise retries still consume outbound capacity without yielding.
- PERFORMANCE-005: Linear backoff is a tuning choice here, not a proven production defect.
- PERFORMANCE-008: The extra PgBoss client is an intentional design tradeoff that lets the API enqueue work directly; there is no evidence it is harmful today.
- RELIABILITY-007: Skipped runs still surface in `recentRuns`; the top-level status intentionally stays coarse instead of exposing `skipped` as a primary state.
- RELIABILITY-008: The UI explicitly labels the filter as `Auto-renew Off`, not `Off or Unknown`, so excluding `NULL` rows matches product semantics.
- RELIABILITY-009: On the cited `insert(...).returning()` paths, PostgreSQL either returns the inserted row or throws. The destructuring pattern is a typing annoyance, but not a runtime reliability bug in the cited code.
- RELIABILITY-011: The stale `existing` read does not cause false change detection in the cited path. Head repair only runs when the row is missing or `lastMessageId` already changed, and those conditions already make the page count as changed.
- RELIABILITY-013: The process-wide int8 parser mutation is a known tradeoff in an app-owned `pg` process and is not causing a present failure.
- RELIABILITY-014: The `NOT IN` null trap does not apply here because the subquery key is a non-nullable foreign key. This is a stylistic SQL preference, not an actual correctness issue in the current schema.
- RELIABILITY-017: The fixed `+100` increment is not the active bug here because the code only continues when the page length equals the requested limit; a short page already marks the stream done.
- SECURITY-009: `streamOrderSql()` is private and every current call site passes a hardcoded literal, so there is no live SQL-injection path.
- TYPE-SAFETY-005: The bundled upstream types treat `avatar` as required, and I found no evidence in the current integration that null avatars are a real payload shape. This is speculation without a failing path.
- TYPE-SAFETY-007: Current `safeTelemetryOp()` call sites either ignore the return value or pass an explicit fallback, so the cited attempt-id loss is not reproducible.
- API-CORRECTNESS-006: The Telegram report uses HTML mode, so emitting `&lt;1%` is already the correct escaped payload.
- API-CORRECTNESS-007: The code relies on the onboarding invariant that pages always have credentials; the bad status only appears under damaged or manually modified data.
- CONFIGURATION-010: The singleton check already exists in `packages/db/migrations/0021_telegram_dashboard.sql` via `check (id = 1)`.
- DEAD-CODE-002: The duplicated platform branches are real, but collapsing them is cosmetic. There is no correctness issue hiding behind the duplication.
- DEAD-CODE-003: `buildProxyCacheKey()` is just a one-line delegation in both adapters, but it also gives each adapter a stable override point. The duplication is harmless.
- DEAD-CODE-004: The issue is naming inconsistency, not dead code. Different local variable names across adapters are not themselves a defect.
- DEAD-CODE-005: The duplicate import is real but harmless and low value to clean up in isolation.
- DEAD-CODE-006: The duplicate imports in `ChatPreviewPanel.tsx` are real, but this is trivial cleanup with no product impact.
- DEAD-CODE-007: The duplicated `SortHeader` component exists in two tables, but the code is small and currently easy to reason about. There is no meaningful risk from leaving it duplicated.
- DEAD-CODE-008: The singular and batch fan upsert paths do repeat `updateSet` construction, but the duplication is straightforward and not causing behavior drift today.
- DEAD-CODE-009: `fan_pages.lastTransactionAt` is not dead. It is still read by reporting and spender paths in the current codebase.
- DEAD-CODE-010: `FanIntelligenceMarkdownRenderer` is exercised by the test suite, so the export is not dead.
- DEAD-CODE-011: `GLOBAL_DELAY_SAFETY_MARGIN_MS` is a magic constant with no doc, but it is an intentional tuning knob rather than dead code or a behavior bug.
- DEAD-CODE-012: `handleSelectProfileVersion` is still wired into the component tree, so it is not dead even if it is a thin wrapper.
- DEAD-CODE-013: The IIFE-to-throw pattern is harder to read than a direct branch, but it is stylistic only.
- DEAD-CODE-014: This is indentation and style, not dead code or a runtime problem.
- DEAD-CODE-015: The cited send-wakeup indentation issue is formatting only.
- DEAD-CODE-016: The default Telegram report hour literal is real, but extracting `9` into a named constant would be cosmetic at current scale.
- DEAD-CODE-017: `minDate` and `maxDate` are duplicated in a few modules, but the helpers are tiny and context-local. There is no meaningful maintenance pain to justify a shared abstraction right now.
- DEAD-CODE-018: The `parsed` and `raw` duality is an intentional adapter contract surface. They currently happen to be equal objects, but keeping both names avoids churn if parsing and raw payload capture diverge later.
- DEAD-CODE-019: The empty-`pageIds` checks are not simply redundant. `applyPageScope()` reports scope state, and individual callers still decide whether to short-circuit based on their own query shape.
- DEAD-CODE-020: The Commander negated option already drives `options.wait`, so checking `options.noWait` too is redundant. It is harmless and not worth special cleanup.
- PERFORMANCE-011: Parsing the same date three times is trivial overhead and not worth separate cleanup.
- RELIABILITY-021: The complaint is about a missing comment, not a reliability defect. `browser.ts` is a straightforward browser-safe export surface as written.
- RELIABILITY-022: The mixed field naming mirrors upstream payloads and is not a runtime reliability defect.
- RELIABILITY-023: `buildFanslyDmConversationMetadata()` omits `messageSyncExcludedReason` when the value is null on purpose. Downstream logic treats absence as "no exclusion reason," so nothing is lost.
- RELIABILITY-024: The duplicate checkpoint parse is harmless duplicate work with no behavioral consequence.
- RELIABILITY-025: Waiting before the final failed retry is a small failure-path latency cost, not a correctness problem.
- RELIABILITY-026: `sql.join` vs `inArray` is a consistency and style concern only. There is no demonstrated reliability problem from the current implementation.
- TYPE-SAFETY-009: Excluding `auto` from the response schema is deliberate. Requests may ask for `auto`, but resolved response granularity is always one of `day`, `week`, or `month`.
- TYPE-SAFETY-010: The `Array<any>` clause arrays are an imprecise typing choice, but there is no demonstrated runtime bug behind them. This is cleanup only.
- TYPE-SAFETY-011: The cast is ugly, but the normalizer immediately validates shape and throws on bad data; this is cleanup, not a demonstrated bug.
- TYPE-SAFETY-012: `createUserAccount()` fetches the created user before returning, so the route-level non-null assertion is safe in the current flow.
- TYPE-SAFETY-013: The raw SQL and cast are local type-smells, but there is no demonstrated behavioral defect attached to this query.
- TYPE-SAFETY-014: The non-null assertion in the trailing-punctuation helper is unnecessary, but the loop guard guarantees the index exists when it is read. It is not an actual unsafe access.
