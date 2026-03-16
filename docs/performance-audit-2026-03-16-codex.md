# Performance Audit — 2026-03-16 (Codex)

This audit used the local Postgres dataset in `agency_hub_core`, Fastify `server.inject()` timing runs, `EXPLAIN ANALYZE`, sync observability tables, and a real browser pass against the production dashboard bundle.

## Summary

### Before / After

| Area | Before | After | Change |
| --- | ---: | ---: | ---: |
| `GET /api/v1/overview` median | 18.91 ms | 12.50 ms | -33.9% |
| `GET /api/v1/overview` DB round trips | 28 | 22 | -21.4% |
| `GET /api/v1/overview/revenue?period=30d` median | 8.29 ms | 5.24 ms | -36.8% |
| `GET /api/v1/pages/lily-2/revenue?period=30d` median | 5.00 ms | 3.23 ms | -35.4% |
| `GET /api/v1/pages/lora-1/subscribers?limit=50` median | 5.93 ms | 3.44 ms | -42.0% |
| `GET /api/v1/pages/lily-2/followers?limit=50` median | 15.93 ms | 13.18 ms | -17.3% |
| `GET /api/v2/spenders?...pageLabel=lily-2&period=30d` median | 12.51 ms | 8.62 ms | -31.1% |
| Worker cold start (PgBoss + queue bootstrap) | 43.14 ms | 30.33 ms | -29.7% |
| API server bootstrap (`buildApiServer`) | 171.96 ms | 138.19 ms | -19.6% |
| Dashboard initial JS on `/` | 752.7 KB decoded | 343.1 KB decoded | -54.4% |

### Applied changes

1. Added and applied migration `0018_performance_indexes.sql` for follower, subscriber, and daily revenue lookups.
2. Collapsed duplicate `count(*)` queries on follower, subscriber, fan, and spender list endpoints by using `count(*) over()`.
3. Removed the overview endpoint’s repeated page and per-page subscriber lookups.
4. Parallelized PgBoss queue bootstrap to cut worker and API cold-start work.
5. Finished route-level lazy loading and moved the chart bundle behind a truly lazy chart component so overview no longer downloads charting code.

## API Layer

### Findings

- The overview endpoint had an N+1 pattern for “new subscribers today” and also re-fetched the page list when deriving connection status.
- Followers, subscribers, and spenders each paid an extra round trip for a separate count query even though the data query already scanned the same filtered set.

### Changes

- `apps/runtime/src/api/server.ts`
  - Replaced the per-page subscriber loop with `listSubscriberTotalsForPages(...)`.
  - Passed preloaded pages into `listConnectionStatuses(...)` so overview no longer performs a second `listVisiblePages(...)`.
- `packages/db/src/repositories/reporting.ts`
  - Converted `listFollowersForPage`, `listSubscribersForPage`, and `listFansForPage` to window-count queries.
  - Added `listSubscriberTotalsForPages(...)`.
- `packages/db/src/repositories/spenders.ts`
  - Converted both spender ranking paths to window-count queries.
- `apps/runtime/src/services/connections.ts`
  - Allowed reuse of preloaded page rows for connection-status derivation.

### Measured impact

- Overview query count dropped from 28 to 22.
- Follower list query count dropped from 8 to 7.
- Spender list query count dropped from 13 to 12.
- Subscriber list median fell from 5.93 ms to 3.44 ms.
- Spender list median fell from 12.51 ms to 8.62 ms.

## Database

### `EXPLAIN ANALYZE` findings

#### Followers endpoint

Before:

- `page_follows` used a sequential scan over 25,444 rows.
- Plan time: 15.32 ms.
- Key line: `Seq Scan on page_follows pf ... rows=15619`.

After:

- `page_follows_active_followed_idx` is used.
- Plan time: 0.31 ms.
- Key line: `Index Scan using page_follows_active_followed_idx on page_follows pf`.

#### Revenue rollups

Before:

- The revenue breakdown query used the wide unique index `daily_revenue_account_date_type_state_uniq`.
- Plan time: 0.19 ms.

After:

- The same query uses `daily_revenue_account_date_idx`.
- Plan time: 0.15 ms.
- This is a small improvement on the current dataset, but the index is narrower and better aligned with the range-scan predicate.

#### Subscribers endpoint

After applying `page_subscriptions_current_idx`, the current dataset still chooses a sequential scan. That is expected here: `page_subscriptions` only has 100 rows. The index is still valuable protection for growth because the endpoint filters on `platform_account_id + is_current` and orders by `ends_at, id`.

### Applied index changes

Migration `packages/db/migrations/0018_performance_indexes.sql` now creates:

```sql
create index if not exists page_follows_active_followed_idx
  on page_follows (platform_account_id, is_active, followed_at desc, id desc);

create index if not exists page_subscriptions_current_idx
  on page_subscriptions (platform_account_id, is_current, ends_at, id);

create index if not exists daily_revenue_account_date_idx
  on daily_revenue (platform_account_id, business_date);
```

The follower index was the biggest concrete win in this dataset.

## Sync Worker

### Actual bottleneck

The slowest sync runs were transaction syncs for page ids `2` and `7`:

- Run `300`: 113,990 ms total, `12,079 ms` total request time, `40` attempts.
- Run `305`: 98,000 ms total, about `9–10 s` total request time from request-attempt rows, `36` logical requests.

Most of the wall time is not local database work. The telemetry shows:

- transaction scans are flagged with `after_ineffective`, so the upstream `after` filter still scans materially old data;
- request time is only a small fraction of total chunk time;
- the rest is dominated by enforced Fansly pacing (`FANSLY_GLOBAL_DELAY_MS`, default 2500 ms) and provider-side pagination breadth.

### Ingestion notes

- Transaction reporting already writes into rollup tables instead of querying raw transactions on reads.
- The current local ingestion path is not the primary sync bottleneck on this dataset, so no speculative transaction-ingestion rewrite was applied.

### Worker cold-start changes

- `apps/runtime/src/services/sync-queue.ts`
  - Queue creation now runs in parallel in dependency-safe stages.
- `apps/runtime/src/worker.ts`
  - Planner scheduling and cleanup scheduling now run in parallel.
  - Removed redundant queue creation work for `RAW_PAYLOAD_CLEANUP_QUEUE`.

Measured impact:

- Worker bootstrap fell from 43.14 ms to 30.33 ms.

## Dashboard

### Findings

- The overview route was downloading the chart bundle even before the user visited a detail page.
- The original shell loaded roughly 752.7 KB of decoded JS on `/`.

### Changes

- `apps/dashboard/src/App.tsx`
  - Lazy-loaded login, overview, and page-detail routes in addition to the already-lazy secondary routes.
- `apps/dashboard/src/pages/PageDetailPage.tsx`
  - Moved the chart card behind a lazy-loaded `PageActivityChart`.
- `apps/dashboard/src/components/page/PageActivityChart.tsx`
  - New isolated chart component containing the `recharts` dependency.
- `apps/dashboard/vite.config.ts`
  - Disabled HTML/module preload of the chart chunk so it stays deferred until the chart path is reached.
  - Removed the custom `manualChunks` override that was accidentally hoisting React into the chart vendor chunk.

### Measured impact

Initial load of `/` before the frontend changes:

- `index-*.js`: 347.5 KB decoded
- `recharts-*.js`: 405.2 KB decoded
- Total initial JS: about 752.7 KB decoded

Initial load of `/` after the frontend changes:

- `index-B1eGgGBh.js`: 338.5 KB decoded
- `OverviewPage-*.js`: 4.2 KB decoded
- `constants-*.js`: 0.5 KB decoded
- Total initial JS: about 343.1 KB decoded

Detail-route confirmation:

- Navigating from overview to `/pages/lily-2` now loads `PageDetailPage-*.js` and `PageActivityChart-*.js` on demand.
- The 394.4 KB chart chunk is no longer part of the overview startup path.

## Remaining issues

- The biggest sync latency is still external: upstream transaction pagination plus deliberate pacing.
- The Fastify runtime in this workspace still does not serve `/` from `apps/dashboard/dist` directly in the local harness I used for browser profiling. That did not block the audit because the production bundle was profiled through a local static+proxy wrapper, but the direct Fastify static path is worth checking separately.

## Verification

- `pnpm db:migrate`
- `pnpm typecheck`
- `pnpm test`

Results:

- Typecheck passed.
- Tests passed: 32 files, 167 tests.
