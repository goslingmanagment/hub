# Code Review 2026-03-15 — Consolidated

**Project:** `/Users/dmitriy/code/core` — TypeScript monorepo (pnpm workspaces)
**Baseline:** `pnpm typecheck` ✅, `pnpm test` 154/154 across 30 files ✅
**Previous review:** `docs/code-review-2026-03-09.md` (file missing from tree; diff reconstructed from commits)
**Sources:** Two independent reviews (Opus 4.6 + Codex), merged and deduplicated.

---

## Summary

| Severity | Count |
|----------|------:|
| 🔴 Critical | 1 |
| 🟠 High | 5 |
| 🟡 Medium | 6 |
| 🔵 Low | 4 |

### Top 5 Riskiest Files

| # | File | Risk |
|---|------|------|
| 1 | `packages/db/src/schema.ts` | Missing unique constraint on upstream page identity; missing index on pending-transaction lookup |
| 2 | `packages/db/src/repositories/transactions.ts` | Fan attribution erasure on rescan; N+1 fan upserts |
| 3 | `apps/runtime/src/services/sync/executor-handlers.ts` | N+1 DB writes in loops; checkpoint state parsing; generation deactivation |
| 4 | `apps/runtime/src/services/connections.ts` | Credential update can detach page from upstream account; hard-coded credential state |
| 5 | `apps/runtime/src/services/sync/onlyfans-transactions.ts` | Chargeback-only window skip; complex backfill state machine; full-history rebuilds |

---

## 🔴 Critical

### C-1: Duplicate upstream pages allowed — same ledger can be double-counted

**Files:** `packages/db/src/schema.ts:101-136`, `packages/db/src/repositories/catalog.ts:55-110`, `apps/runtime/src/services/page-onboarding.ts:78-110,144-171`, `apps/runtime/src/services/reporting.ts:457-481`

**Problem:** `platform_accounts` enforces uniqueness only on `label`. `(platform, platform_account_id)` is indexed but **not unique**. Both onboarding flows create the page row before writing the verified upstream account id, and `updatePageMetadata()` freely rewrites `platform_account_id` afterward. The same Fansly/OF account can exist under multiple local page labels.

**Impact:** Duplicate syncs against the same upstream ledger. Double-counted revenue and spender totals at page/model/agency layers. Operational ambiguity when different local pages silently represent the same real account.

---

## 🟠 High

### H-1: Sequential fan upserts create O(N) round-trips during sync

**Files:** `packages/db/src/repositories/fans.ts:26-78`, `apps/runtime/src/services/sync/executor-handlers.ts:419-459,608-633,794-815`

**Problem:** `upsertFans` iterates each fan individually — INSERT + ON CONFLICT per fan, plus separate INSERT for `fan_username_aliases`. In subscriber/follower/reconcile handlers, `upsertPageSubscription`, `upsertFanPage`, and `upsertPageFollow` are also called per-item. A single 100-item page produces ~400 individual DB operations. For follower reconcile with 10k+ followers — ~20k+ SQL statements.

**Impact:** Sync latency scales linearly with follower count. Dominates chunk execution time and risks exceeding the 45s wall-clock budget on large pages.

### H-2: Credential updates can silently detach a page from its upstream account

**Files:** `apps/runtime/src/services/connections.ts:125-188`, `apps/runtime/src/services/sync/shared.ts:129-175`, `apps/runtime/src/services/onlyfans.ts:71-84`

**Problem:** `updatePageCredentials()` verifies credentials are valid but does not assert they belong to the same upstream account already attached to the page. Fansly: any valid session accepted, next metadata refresh rewrites page to whatever `getAccountMe()` returns. OF: verification looks up submitted username, but resolved account id not persisted.

**Impact:** Fansly pages silently rebound to different creator. OF pages store new auth while syncing old account id — stale-account failures or cross-account data confusion.

### H-3: Encryption key rotation not supported; decrypt failures bypass sync state

**Files:** `packages/shared/src/crypto.ts:3-48`, `packages/db/src/schema.ts:139-158`, `apps/runtime/src/services/page-context.ts:147-188`, `apps/runtime/src/services/sync/executor.ts:67-117,250-256`

**Problem:** Encrypted envelopes persist `keyVersion`, but `decryptJson()` ignores it and only accepts the single configured `APP_ENCRYPTION_KEY`. Page context resolution (decrypt) happens before `recordSyncStreamChunkStarted()` and before chunk-level try/catch.

**Impact:** Key rotation strands all existing pages. Decrypt failures bypass normal `auth_failed`/chunk-failure persistence — fall straight into pg-boss DLQ with no durable per-page recovery state.

### H-4: Fansly rescans can erase previously known fan attribution

**Files:** `packages/db/src/repositories/transactions.ts:51-84`, `apps/runtime/src/services/sync/transactions.ts:208-245,508-545`

**Problem:** `upsertTransaction()` always writes `fanId: input.fanId ?? null` during conflict updates. When `correlationAccountId` is absent or hydration misses on rescan, upsert writes NULL over previously populated `fan_id`.

**Impact:** Fan attribution disappears non-deterministically after rescans. Spender projections, fan-level reporting, and fan page membership degrade over time.

### H-5: Advisory lock release failure silently leaks lock on pooled connection

**Files:** `apps/runtime/src/services/sync/locking.ts:19-42`

**Problem:** `withPageSyncLock` acquires session-level advisory lock on pooled connection. Unlock in nested `finally` catches errors with `.catch(() => undefined)`. If unlock fails, connection returns to pool still holding the lock. Session-level advisory locks persist until session ends.

**Impact:** Failed unlock causes lock held by pooled connection, blocking subsequent sync attempts for same page until connection recycled by pool.

---

## 🟡 Medium

### M-1: Duplicate subscriber/follower sync implementations

**Files:** `apps/runtime/src/services/sync/subscribers.ts` vs `executor-handlers.ts:executeSubscribersChunk`; `apps/runtime/src/services/sync/followers.ts` vs `executor-handlers.ts:executeFollowersChunk`

**Problem:** Two complete implementations exist side by side. Legacy `syncSubscribers` lacks chunk-budget awareness and uses different deactivation strategy (`setPageSubscriptionsCurrentFlag` vs generation-based). Legacy paths appear used only from CLI commands.

**Impact:** Behavioral divergence risk. Bug fix applied to one path but not the other → CLI and executor produce different sync results.

### M-2: Incremental syncs still rebuild full rollups instead of using dirty range

**Files:** `apps/runtime/src/services/sync/transactions.ts:66-76,223-249`, `apps/runtime/src/services/sync/onlyfans-transactions.ts:256-267,526-575`

**Problem:** Dirty-range rebuild helpers exist, but steady-state incremental commit paths call `rebuildSpenderProjections()` and `rebuildRevenueRollups()` with no lower bound — full-history recomputation on every incremental sync.

**Impact:** Sync cost grows with ledger age instead of changed data. Higher lock time, DB load, growing timeout pressure on long-lived pages.

### M-3: OF incremental cleanup skips delete-missing for chargeback-only windows

**Files:** `apps/runtime/src/services/sync/onlyfans-transactions.ts:519-575`

**Problem:** `deleteTransactionsMissingFromWindow()` called only when `processedTransactions > 0`, not when window has `processedChargebacks > 0` and zero normal transactions.

**Impact:** Stale rows in chargeback-only windows survive indefinitely. Revenue/spender state diverges if chargeback changes and no normal transactions in same window.

### M-4: Missing index on `fan_pages(platform_account_id)`

**Files:** `packages/db/src/schema.ts:411-437`

**Problem:** Unique constraint on `(fan_id, platform_account_id)` but no standalone index on `platform_account_id`. Queries in `listFansForPage`, `refreshFanPageFollowerState`, `refreshFanPageSubscriberState`, `getCurrentSubscribers` filter by `platform_account_id` alone.

**Impact:** Suboptimal index scan order. Growing I/O cost as fan counts increase.

### M-5: Missing composite index on pending-transaction boundary lookup

**Files:** `packages/db/src/repositories/transactions.ts:320-329`, `packages/db/src/schema.ts:542-552`

**Problem:** Incremental sync start uses `min(occurred_at)` filtered by `platform_account_id` and `transaction_state = 'pending'`. Only relevant indexes are `(platform_account_id, occurred_at)` and `(fan_id)` — no index on state.

**Impact:** Every incremental sync scans for sparse pending rows. Latency grows with transaction volume.

### M-6: DLQs configured but operationally unmanaged

**Files:** `apps/runtime/src/services/sync-queue.ts:42-75`, `apps/runtime/src/services/sync/executor.ts:250-256`, `apps/runtime/src/worker.ts:15-64`

**Problem:** Planner and page-execute queues have DLQs. Executor crashes fail pg-boss job. No runtime worker for DLQs, no alerting, no recovery path.

**Impact:** Pages stop syncing permanently after repeated crashes unless operator inspects pg-boss manually.

---

## 🔵 Low

### L-1: LIKE wildcard characters not escaped in search queries

**Files:** `packages/db/src/repositories/reporting.ts:349,449,532`, `packages/db/src/repositories/spenders.ts:547-548,942`

**Problem:** User search queries wrapped as `%${input.query}%` — `%` and `_` wildcards not escaped.

**Impact:** Search results broader than expected for queries containing wildcards. Not a security issue (parameterized), but functional correctness issue.

### L-2: `millsToNumber` precision loss for very large sums

**Files:** `packages/shared/src/money.ts:38-40`, `apps/runtime/src/services/reporting.ts:467-497`

**Problem:** `Number(toMills(value))` loses precision beyond `Number.MAX_SAFE_INTEGER`. Model totals rebuilt with `BigInt(page.netEarningsMills)` re-materialize rounded IEEE-754 value.

**Impact:** Latent. Breaks for extremely large lifetime totals (>$9B). Not realistic today.

### L-3: Connection status hard-codes `hasCredentials = true`

**Files:** `apps/runtime/src/services/connections.ts:94-105`

**Problem:** `listConnectionStatuses()` never checks whether credential row exists or is decryptable.

**Impact:** Dashboard reports `active`/`stale`/`error` for pages missing credentials or with undecryptable creds.

### L-4: `isAuthError` uses fragile string matching

**Files:** `apps/runtime/src/services/connections.ts:31-39`

**Problem:** Checks if `errorSummary.toLowerCase()` includes `"401"`, `"unauthorized"`, `"auth"`, `"token"` — can match unrelated errors.

**Impact:** Connection status incorrectly classified as `"expired"`, masking actual failure reason.

---

## Test Coverage Gaps

| Critical Path | Tested? | Risk |
|---|---|---|
| `updatePageCredentials()` — same-account invariant | No | Credential swap goes undetected |
| `crypto.ts` — key rotation / older keyVersion decrypt | No | Key rotation breaks all pages silently |
| Page onboarding — duplicate upstream account rejection | No | Double-counted revenue |
| `upsertTransaction()` — fan_id preservation on rescan | No | Fan attribution erasure |
| OF chargeback-only window delete-missing | No | Stale rows survive |
| `time.ts` period bound resolution | No | Revenue reporting accuracy (off-by-one prone) |
| `spenders.ts` aggregation logic | No | Complex windowed/lifetime metrics untested |
| `reporting.ts` multi-platform aggregation | No | Revenue aggregation untested |
| Worker startup/shutdown + DLQ behavior | No | Only planner-cycle tested |
| `proxy.ts` normalization + `redactSensitiveText` | No | Credential redaction is security function |

---

## Diff From Previous Review (2026-03-09)

File `docs/code-review-2026-03-09.md` missing from working tree. Delta reconstructed from commits.

### ✅ Fixed Since 2026-03-09

| Issue | Evidence |
|---|---|
| Custom revenue period off-by-one | `time.ts:231-251` now `[from, to)` exclusive. Commit `290315e` |
| OF backfill lower-bound persistence | Tests at `onlyfans-transactions.test.ts:363-406`. Commit `fea236c` |
| Cursorless resume through OF chargeback phase | Tests at `onlyfans-transactions.test.ts:443-536`. Commit `211740c` |
| UTC business-date handling (timezone mismatch) | `time.ts:218-223` returns UTC for both platforms. Commit `44b93d7` |

### ❌ Persisting / Status Unknown

| Issue | Status |
|---|---|
| N+1 fan upsert | **Persists** (H-1) |
| Non-atomic rollup rebuild | Partially persists — dirty-range helpers added but not used in incremental path (M-2) |
| Unsafe Drizzle tx casts | **Unknown** — not found in current codebase, may have been fixed |

### 🆕 New Findings

- C-1: Duplicate upstream pages (schema gap)
- H-2: Credential detach on update
- H-4: Fan attribution erasure on rescan
- H-5: Advisory lock leak
- M-1: Duplicate sync implementations (legacy vs executor)
- M-3: Chargeback-only window skip
- M-6: DLQs unmanaged

## Fix Pass Results

| Finding ID | Status | Commit | Tests | Notes |
|---|---|---|---|---|
| C-1 | Fixed | `fix(C-1): prevent duplicate upstream identity binding` | `pnpm test -- tests/db-write.integration.test.ts tests/schema-guard.test.ts` | Added DB uniqueness and immutable page identity binding. |
| H-4 | Fixed | `fix(H-4): preserve fan attribution on rescans` | `pnpm test -- tests/db-write.integration.test.ts` | Transaction upserts now keep existing `fan_id` when rescans resolve to `NULL`. |
| H-2 | Fixed | `fix(H-2): verify credential account identity` | `pnpm test -- tests/db-write.integration.test.ts` | Credential updates now reject upstream-account mismatches for Fansly and OnlyFans. |
| H-5 | Fixed | `fix(H-5): fail hard on advisory unlock errors` | `pnpm test -- tests/sync-locking.test.ts` | Unlock failures now discard the pooled client instead of silently returning it. |
| H-1 | Fixed | `fix(H-1): batch sync fan upserts` | `pnpm exec vitest run tests/db-write.integration.test.ts tests/sync-handlers.test.ts tests/onlyfans-transactions.test.ts` | Batched fan, fan-page, follow, and subscription writes on active sync paths. |
| M-2 | Fixed | `fix(M-2): scope incremental rollup rebuilds` | `pnpm exec vitest run tests/onlyfans-transactions.test.ts tests/fansly-transactions.test.ts` | Incremental transaction syncs now rebuild from the dirty lower bound instead of full history. |
| M-3 | Fixed | `fix(M-3): clean chargeback-only transaction windows` | `pnpm exec vitest run tests/onlyfans-transactions.test.ts` | OnlyFans delete-missing cleanup now runs when the window contains only chargebacks. |
| M-4 | Fixed | `fix(M-4): add fan_pages platform account index` | `pnpm exec vitest run tests/schema-guard.test.ts` | Added the standalone `fan_pages(platform_account_id)` index used by page-scoped fan lookups. |
| M-5 | Fixed | `fix(M-5): add pending transaction boundary index` | `pnpm exec vitest run tests/schema-guard.test.ts` | Added a composite index for pending-transaction boundary scans on incremental sync. |
| M-1 | Pending |  |  |  |
