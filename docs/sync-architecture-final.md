# Sync Architecture Final

This document is the implementation spec for the sync rewrite

The spec was verified against the current codebase and the installed `pg-boss` package:

- `apps/runtime/src/worker.ts`
- `apps/runtime/src/worker-sync-trigger.ts`
- `apps/runtime/src/services/sync.ts`
- `apps/runtime/src/services/sync/locking.ts`
- `apps/runtime/src/services/sync/transactions.ts`
- `apps/runtime/src/services/sync/shared.ts`
- `apps/runtime/src/services/sync-queue.ts`
- `apps/runtime/src/api/server.ts`
- `apps/runtime/src/cli.ts`
- `apps/runtime/src/bootstrap.ts`
- `packages/fansly/src/adapter.ts`
- `packages/shared/src/config.ts`
- `packages/db/src/schema.ts`
- `packages/db/src/repositories/sync.ts`
- `packages/db/src/repositories/fans.ts`
- `packages/db/src/repositories/transactions.ts`
- `node_modules/pg-boss/dist/index.d.ts`
- `node_modules/pg-boss/dist/types.d.ts`
- `node_modules/pg-boss/dist/manager.js`
- `node_modules/pg-boss/dist/plans.js`

## 1. Decision Log

This section is part of the spec. It records every material disagreement between the three candidate specs and the final choice.

### 1. Scheduler-Visible Stream Model

What each spec chose:

- `sync-architecture-last_codex.md`: 4 streams. `light`, `transactions`, `subscribers`, `followers`. Follower reconcile stays inside `followers`.
- `sync-architecture-last_codex_2.md`: 4 streams. `light`, `transactions`, `subscribers`, `followers`. Follower reconcile stays inside `followers`.
- `sync-architecture-last_opus.md`: 5 streams. `light`, `transactions`, `subscribers`, `followers`, `followers_reconcile`.

Option A: 4 streams with follower reconcile as an internal mode.

Pros:

- Reuses the existing `sync_stream` enum without alteration.
- Keeps the external stream list close to the current code and current audit rows.
- Avoids one extra control-plane row per Fansly page.

Cons:

- One revision pair must represent two different obligations: incremental freshness and full-set reconciliation.
- A manual or scheduled incremental request can arrive while a reconcile is in progress, which makes one-row state transitions and priority handling harder to reason about.
- Checkpoint state becomes a multi-mode state machine instead of one checkpoint domain per scheduler-visible unit.

Option B: 5 streams with `followers_reconcile` as a separate control-plane target.

Pros:

- Incremental followers and reconcile get separate revision pairs, cadences, backoff, and observability.
- A long-running reconcile cannot blur whether incremental follower freshness is currently satisfied.
- Separate checkpoint rows become straightforward: `followers` for incremental progress, `followers_reconcile` for full-scan progress.

Cons:

- Requires adding `followers_reconcile` to `sync_stream`.
- Adds one more control-plane row per Fansly page.

Decision:

Use 5 scheduler-visible streams: `light`, `transactions`, `subscribers`, `followers`, and `followers_reconcile`. The extra row is negligible at 30-50 pages, and the cleaner revision model is worth the enum addition because follower reconcile is operationally distinct work, not just an internal implementation detail.

### 2. Follower Reconcile Scheduling

What each spec chose:

- `sync-architecture-last_codex.md`: internal follower reconcile every 48 hours, or sooner on anomaly.
- `sync-architecture-last_codex_2.md`: anomaly-driven reconcile only. No periodic cadence.
- `sync-architecture-last_opus.md`: separate `followers_reconcile` stream every 24 hours.

Option A: anomaly-driven only.

Pros:

- Lowest steady-state provider load.
- Avoids scheduled full scans when incremental sync appears healthy.

Cons:

- Stale deactivations can persist indefinitely if no anomaly fires.
- Drift detection depends on the quality of metadata counts and checkpoint heuristics.

Option B: 24-hour cadence.

Pros:

- Guarantees a bounded full-set scrub interval.
- Makes reconcile freshness easy to reason about.

Cons:

- Daily full scans are unnecessarily expensive for the target scale and the current 5-second follower-page pacing.
- It spends provider budget even when incremental sync is healthy and counts match.

Option C: 48-hour cadence plus anomaly triggers.

Pros:

- Preserves a bounded stale-row cleanup interval.
- Cuts the steady-state reconcile load in half versus daily scans.
- Still allows immediate anomaly-driven repair when follower count drift or checkpoint anomalies appear.

Cons:

- Reconcile freshness is looser than a daily cadence.

Decision:

Use a separate `followers_reconcile` stream with a 48-hour cadence and anomaly-triggered wakeups. The current code proves that follower reconcile is the expensive path, so the final design must keep a periodic safety net without turning every page into a daily full-scan workload.

### 3. Snapshot Persistence Model

What each spec chose:

- `sync-architecture-last_codex.md`: generation columns on `page_follows` and `page_subscriptions`.
- `sync-architecture-last_codex_2.md`: `sync_snapshot_runs` plus `sync_snapshot_members`.
- `sync-architecture-last_opus.md`: generation columns on `page_follows` and `page_subscriptions`.

Option A: separate snapshot tables.

Pros:

- Explicit open/applying/applied snapshot lifecycle.
- Easy to inspect partial snapshot membership.
- Uniform pattern for subscribers and follower reconcile.

Cons:

- Adds two new hot tables and cleanup responsibilities.
- Duplicates membership that already lives in canonical tables.
- Writes every member twice: once to the snapshot table and once to the canonical table.

Option B: generation columns on existing canonical tables.

Pros:

- Uses the real source-of-truth tables directly.
- Requires less schema and less write amplification.
- Supports resumable scans as long as generation and offset live in `sync_checkpoints.state`.

Cons:

- Finalization logic must be careful to deactivate only after a full scan completes.
- Partial progress visibility is in checkpoint state rather than dedicated snapshot tables.

Decision:

Use generation columns on `page_follows` and `page_subscriptions`. The page-scoped execution lock already guarantees single-writer semantics per page, so snapshot tables add complexity without buying correctness the final design actually needs.

### 4. Light Stream Scope and Metadata Ownership

What each spec chose:

- `sync-architecture-last_codex.md`: `light` is page metadata refresh plus bounded fan-hydration repair. The page executor refreshes page metadata on every wakeup.
- `sync-architecture-last_codex_2.md`: `light` is page metadata only. The stream descriptions keep hydration in stream-specific logic.
- `sync-architecture-last_opus.md`: `light` is metadata refresh and fan hydration only. The page executor refreshes page metadata on every wakeup.

Option A: `light` owns metadata and generic hydration repair, and the executor refreshes metadata on every wakeup.

Pros:

- One place to repair page-level metadata and “cheap” fan state.
- Fresh provider counters are always available before any stream runs.

Cons:

- Long multi-chunk subscriber or follower work would spend extra metadata requests every wakeup for no direct benefit.
- The current code does not have a standalone, bounded “generic hydration repair” unit that is independent from subscribers and transactions.
- It blurs stream ownership again after deliberately splitting `light`, `transactions`, and `subscribers`.

Option B: `light` is metadata only. Each stream performs only the stream-specific hydration and data writes it actually needs.

Pros:

- Keeps `light` cheap and easy to reason about.
- Avoids wasting provider requests on every wakeup during long-running chunked streams.
- Matches the current code more closely: subscriber hydration happens inside subscriber sync, not as a generic sidecar job.

Cons:

- Some streams still need provider identity or source counts at revision start and must fetch or reuse them deliberately.

Decision:

`light` is metadata-only. The page executor does not perform a global metadata refresh on every wakeup; instead, `light` owns metadata freshness, and other streams fetch provider metadata only when they explicitly need it at the start of a new revision.

### 5. Manual Wakeup Behavior and Queue Reprioritization

What each spec chose:

- `sync-architecture-last_codex.md`: update desired state, call immediate `send()`, and use `findJobs()` plus `cancel()` plus `send()` to replace a lower-priority created wakeup.
- `sync-architecture-last_codex_2.md`: same as Codex 1.
- `sync-architecture-last_opus.md`: update desired state and call immediate `send()` only. No cancel/recreate reprioritization.

Option A: update desired state and call `send()` only.

Pros:

- Immediate wakeup when no page job exists.
- No reliance on delayed debounce behavior.
- No risk of manipulating an active job through the public queue API.

Cons:

- If a low-priority created wakeup already exists, its queue priority is not upgraded.

Option B: update desired state and replace a lower-priority created wakeup with `findJobs()` plus `cancel()` plus `send()`.

Pros:

- Better queue ordering if the job is definitely still queued and not active.

Cons:

- `cancel()` updates any job in `state < completed`, including `active`, so a read-then-cancel race can cancel a job that was fetched by a worker after `findJobs()` ran.
- Cancelling an active job releases the singleton key while the original handler may still be running, which can permit a second same-page job and violate the page lock.
- Public `pg-boss` APIs do not expose a safe compare-and-cancel primitive for this case.

Option C: `sendDebounced()`.

Pros:

- Built-in dedupe.

Cons:

- Verified wrong for urgent work. `manager.js` sets `singletonNextSlot = true` and computes a future `startAfter`, so manual work is delayed by design.

Decision:

Manual, onboarding, and recovery triggers update durable desired state and then call immediate `send()` once. They do not use `sendDebounced()`, and they do not cancel/recreate queued jobs because the public `pg-boss` API makes that race unsafe.

### 6. Chunk Budget

What each spec chose:

- `sync-architecture-last_codex.md`: 5 provider requests or 45 seconds, whichever comes first.
- `sync-architecture-last_codex_2.md`: 5 provider requests or 45 seconds, whichever comes first.
- `sync-architecture-last_opus.md`: 12 provider requests or 45 seconds, whichever comes first.

Option A: 5 provider requests per chunk.

Pros:

- Fits the current Fansly pacing across both normal requests and follower-page requests.
- Preserves fairness at the page lock by keeping one page from monopolizing the worker.
- Keeps follower chunks comfortably under the 45-second wall-clock budget with the current 5-second follower-page floor.

Cons:

- More wakeups and more checkpoint writes.

Option B: 12 provider requests per chunk.

Pros:

- Higher throughput per wakeup.
- Lower queue churn.

Cons:

- At the current follower-page floor, 12 follower requests are already about 60 seconds of provider pacing before database work.
- It turns the page lock into a longer critical section and reduces fairness.

Decision:

Use 5 provider requests or 45 seconds, whichever comes first. The current verified request pacing makes 12 safe for some streams but unsafe for the follower family, and the page-scoped lock means fairness matters more than reducing wakeup count.

### 7. Revision Field Naming and Completion Semantics

What each spec chose:

- `sync-architecture-last_codex.md`: `desired_revision` and `applied_revision`.
- `sync-architecture-last_codex_2.md`: `desired_revision` and `satisfied_revision`.
- `sync-architecture-last_opus.md`: `desired_revision` and `satisfied_revision`.

Option A: `applied_revision`.

Pros:

- Short and technically workable.

Cons:

- “Applied” reads like partial side effects may be enough.
- It does not clearly communicate that the whole requested revision must be fully converged.

Option B: `satisfied_revision`.

Pros:

- Makes the invariant explicit: work is pending when `desired_revision > satisfied_revision`.
- Fits the reconciler model better than a transport-oriented verb.

Cons:

- Slightly longer name.

Decision:

Use `desired_revision` and `satisfied_revision`. The final design is about durable reconciliation, not partial application, so the stronger name is worth it because it matches the real invariant.

### 8. Page Executor Worker API

What each spec chose:

- `sync-architecture-last_codex.md`: planner uses `work(batchSize=1)`; page executor uses `fetch()` plus explicit `touch()`, `complete()`, and `fail()`.
- `sync-architecture-last_codex_2.md`: final workers use `work(batchSize=1)`.
- `sync-architecture-last_opus.md`: final workers use `work(batchSize=1)`.

Option A: `work(batchSize=1)` for the page executor.

Pros:

- Less worker code.
- Built-in heartbeat refresh and completion.

Cons:

- `manager.js` completes the active job only after the callback returns, so the same keyed page cannot safely enqueue its successor inside the same control path.
- The final architecture needs same-page continuation immediately after a chunk yields; waiting for the next planner tick adds avoidable latency.

Option B: custom `fetch()` loop for the page executor.

Pros:

- Explicit release point: update state, `complete()` the current job, then `send()` the successor for the same page.
- Supports immediate same-page continuation without relying on the next planner tick.
- Uses the verified public API surface directly.

Cons:

- Requires a heartbeat timer with `touch()`.
- More worker plumbing.

Decision:

Use `work(batchSize=1)` for the planner and a custom `fetch()` loop for `sync.page.execute`. Immediate same-page continuation is a hard requirement for bounded chunk execution, and `work()` cannot provide it safely with an `exclusive` queue keyed by `singletonKey`.

### 9. Queue Names and Retry Configuration

What each spec chose:

- `sync-architecture-last_codex.md`: `sync.planner`, `sync.planner.dlq`, `sync.page.execute`, `sync.page.execute.dlq`. Planner `retryLimit = 3`.
- `sync-architecture-last_codex_2.md`: `sync.plan`, `sync.plan.dlq`, `sync.page.execute`, `sync.page.execute.dlq`. Planner `retryLimit = 2`.
- `sync-architecture-last_opus.md`: `sync.planner`, `sync.planner.dlq`, `sync.page.execute`, `sync.page.dlq`. Planner `retryLimit = 2`.

Option A: short queue names such as `sync.plan` and `sync.page.dlq`.

Pros:

- Shorter names.

Cons:

- Less explicit.
- DLQ names no longer map one-to-one to their source queues.

Option B: explicit names that mirror the queue they belong to.

Pros:

- Clear operational attribution.
- Easier alerts, dashboards, and runbook references.
- Consistent with a small number of long-lived core queues.

Cons:

- Slightly longer queue names.

Decision:

Use `sync.planner`, `sync.planner.dlq`, `sync.page.execute`, and `sync.page.execute.dlq`. Set planner `retryLimit = 2`, not 3, because queue retries are only for infrastructure faults and the installed `pg-boss` default is already 2.

### 10. Priority Policy

What each spec chose:

- `sync-architecture-last_codex.md`: base priorities `light=60`, `transactions=50`, `subscribers=35`, `followers=20`; `manual=90`; `onboarding=100`; `anomaly=max(base,45)`.
- `sync-architecture-last_codex_2.md`: base priorities `light=40`, `transactions=35`, `subscribers=25`, `followers=10`; `manual=80`; `onboarding=100`; recovery preserves the current unsatisfied priority.
- `sync-architecture-last_opus.md`: base priorities `light=40`, `transactions=35`, `subscribers=25`, `followers=15`, `followers_reconcile=10`; `manual=80`; `onboarding=100`; `recovery=max(base,45)`.

Option A: lower base priority scale with smaller gaps.

Pros:

- Simpler numeric range.

Cons:

- Leaves less room between hourly, follower, reconcile, and user-initiated work.
- Makes anomaly and recovery floors more likely to collapse multiple stream classes into the same priority band.

Option B: wider scheduled spacing and explicit high-priority bands for user requests.

Pros:

- Clear within-page order even after adding `followers_reconcile`.
- Keeps manual and onboarding work obviously above scheduled work.
- Lets anomaly and recovery floors matter without outranking the whole hourly light family.

Cons:

- Slightly more opinionated priority scale.

Decision:

Use base priorities `light=60`, `transactions=50`, `subscribers=40`, `followers=20`, `followers_reconcile=10`; `manual=90`; `onboarding=100`; `anomaly=max(base_priority,45)`; `recovery=max(base_priority,45)`. Chunk yields and business failures preserve the row’s current pending reason and effective priority instead of silently downgrading user-requested work.

### 11. Migration Sequence

What each spec chose:

- `sync-architecture-last_codex.md`: shadow planner, then trigger rewrite, then `light` plus `transactions`, then `subscribers`, then followers, then limiter and legacy removal.
- `sync-architecture-last_codex_2.md`: similar split, with separate trigger rewrite and explicit subscriber and follower phases.
- `sync-architecture-last_opus.md`: shadow planner, then `light`, then `transactions`, then `subscribers`, then follower streams, then limiter and cleanup.

Option A: cut over `light`, `transactions`, and `subscribers` as three separate live phases.

Pros:

- Smallest blast radius per cutover.
- Fastest way to isolate whether metadata, transactions, or subscribers caused a regression.

Cons:

- `light` and `transactions` still share most of the current light-family machinery, so splitting them into fully separate rollout phases creates extra temporary gating logic.
- It stretches the migration with little operational benefit because metadata and transactions have similar freshness and cost profiles.

Option B: cut over `light` plus `transactions` together, then `subscribers`, then the follower family, then the limiter and cleanup.

Pros:

- Keeps the rollout aligned with real execution families in the current codebase without forcing a temporary hybrid between metadata and transactions.
- Still gives `subscribers` its own soak window, which is valuable because subscriber diffs have a separate destructive-clear guard and different correctness risk.
- Preserves a clean boundary before the slower, lock-sensitive follower migration.

Cons:

- The first live cutover is larger than a stream-by-stream rollout.

Decision:

Cut over `light` and `transactions` together, then `subscribers`, then the follower family. Metadata and transactions are operationally similar enough to share a live cutover, while subscribers deserve their own boundary because they carry different failure modes and rollback criteria.

## 2. Architecture

### 2.1 Scope

This architecture replaces:

- per-page cron queues
- `sync.trigger` as the scheduling source of truth
- advisory-lock skip semantics
- monolithic in-memory subscriber and follower reconciliation
- `runAllSync()` as a long-lived execution primitive

It keeps:

- Postgres as the control plane
- `pg-boss` v12.14.0 as the execution transport
- the existing `sync_runs`, `sync_run_events`, `sync_request_attempts`, and `sync_checkpoints` audit model

### 2.2 Verified Current-State Problems

The new design exists to remove five verified failure modes in the current code:

1. `sync.trigger` is batch-coupled. `worker.ts` registers `boss.work(SYNC_TRIGGER_QUEUE, { batchSize: 10 }, ...)`, and `manager.js` completes or fails the fetched batch as a unit.
2. Lock contention is terminal. `withPageSyncLock()` uses `pg_try_advisory_lock()` and callers record `skipped` instead of preserving pending work.
3. Advisory locks hold a pooled connection for the whole sync because the lock is session-scoped on a checked-out client.
4. `runAllSync()` holds one page lock across light and follower work, so a long follower pass blocks everything else for that page.
5. Followers and subscribers are still monolithic in the critical places: end-of-run-only follower checkpoint advancement, in-memory reconcile sets, and full subscriber snapshots accumulated before reconciliation.

### 2.3 Design Summary

- Durable desired state lives in `sync_stream_state`.
- Scheduler-visible streams are `light`, `transactions`, `subscribers`, `followers`, and `followers_reconcile`.
- `pg-boss` is a wakeup and execution transport, not the source of scheduling truth.
- One page-scoped lock exists: `sync.page.execute` with queue policy `exclusive` and `singletonKey = platform_account_id::text`.
- Work is pending when `desired_revision > satisfied_revision`.
- The planner is a one-minute reconciler that emits one wakeup per page.
- The page executor processes exactly one bounded chunk per job and immediately hands off the next same-page job if more runnable work remains.
- Subscribers and follower reconcile use generation columns on canonical tables, not separate snapshot tables.
- Shared Postgres rate limiting is required before multi-worker execution.

### 2.4 Control Plane

`sync_stream_state` is the source of truth. Each row is one `(platform_account_id, stream)` target.

Supported rows:

- Fansly pages: `light`, `transactions`, `subscribers`, `followers`, `followers_reconcile`
- OnlyFans pages: `light`, `transactions`

Cadences:

- `light`: 3600 seconds
- `transactions`: 3600 seconds
- `subscribers`: 3600 seconds
- `followers`: 43200 seconds
- `followers_reconcile`: 172800 seconds

Base priorities:

- `light = 60`
- `transactions = 50`
- `subscribers = 40`
- `followers = 20`
- `followers_reconcile = 10`

Request-priority rules:

- `scheduled`: `effective_priority = base_priority`
- `manual`: `effective_priority = 90`
- `onboarding`: `effective_priority = 100`
- `anomaly`: `effective_priority = max(base_priority, 45)`
- `recovery`: `effective_priority = max(base_priority, 45)`

State invariants:

- A row is satisfied when `desired_revision = satisfied_revision`.
- A row is pending when `desired_revision > satisfied_revision`.
- Scheduled cadence does not pile up revisions. The planner increments `desired_revision` only when the row is currently satisfied and due.
- Manual, onboarding, anomaly, and explicit recovery requests may increment `desired_revision` even while older work is already pending.
- Partial chunk progress never advances `satisfied_revision`.
- Chunk yields and business failures preserve the current pending reason and effective priority for that outstanding revision.

### 2.5 Queue Topology

Queues:

- `sync.planner`
- `sync.planner.dlq`
- `sync.page.execute`
- `sync.page.execute.dlq`
- existing raw-payload / observability cleanup queue remains separate

`sync.planner` configuration:

- `policy: 'exclusive'`
- `expireInSeconds: 120`
- `heartbeatSeconds: 30`
- `retryLimit: 2`
- `retryDelay: 30`
- `retryBackoff: true`
- `deadLetter: 'sync.planner.dlq'`
- scheduled with `schedule('sync.planner', '* * * * *')`
- processed with `work(batchSize=1, includeMetadata=true)`

`sync.page.execute` configuration:

- `policy: 'exclusive'`
- `expireInSeconds: 180`
- `heartbeatSeconds: 30`
- `retryLimit: 2`
- `retryDelay: 30`
- `retryBackoff: true`
- `deadLetter: 'sync.page.execute.dlq'`
- every send includes `singletonKey = String(platform_account_id)`
- every send includes `priority = MAX(effective_priority)` across the page’s runnable pending rows

DLQ configuration:

- `sync.planner.dlq`
  - `policy: 'standard'`
  - `retentionSeconds: 1209600` (14 days)
  - no worker is bound
- `sync.page.execute.dlq`
  - `policy: 'standard'`
  - `retentionSeconds: 1209600` (14 days)
  - no worker is bound

Queue payloads:

- `sync.planner`: no business payload
- `sync.page.execute`: `{ platformAccountId }`

DLQ rules:

- Only infrastructure failures land in DLQs.
- Any entry in either sync DLQ is actionable and pages immediately.
- DLQ queues are an operator inbox, not an automatic retry surface.

### 2.6 Planner

The planner is a one-minute reconciler. It never queries `pgboss.job` as the source of scheduling truth.

Per tick:

1. Promote due satisfied rows.
2. Select runnable pending rows.
3. Emit one page wakeup per page.

Promotion query conditions:

- `status = 'active'`
- `desired_revision = satisfied_revision`
- `next_due_at <= now()`

Promotion effects:

- increment `desired_revision` by 1
- set `desired_at = now()`
- set `pending_reason = 'scheduled'`
- set `effective_priority = base_priority`
- compute the next future slot and store it in `next_due_at`

Runnable pending query conditions:

- `status = 'active'`
- `desired_revision > satisfied_revision`
- `backoff_until <= now()`

Emission rules:

- group runnable rows by `platform_account_id`
- compute the page wakeup priority as the maximum `effective_priority` among that page’s runnable rows
- call `send('sync.page.execute', { platformAccountId }, { singletonKey, priority })`
- do not add an artificial emission cap

The planner is idempotent:

- if a page wakeup already exists or is active, `send()` returns `null`
- the desired-state rows remain authoritative either way

### 2.7 Cadence and Jitter

Every row gets a stable `slot_offset_seconds` at seed time. The offset is deterministic and stored; it is not recomputed ad hoc from the latest success timestamp.

Stable offset formula:

- assign `stream_index` values: `light=1`, `transactions=2`, `subscribers=3`, `followers=4`, `followers_reconcile=5`
- compute `slot_offset_seconds = ((platform_account_id * 2654435761) + (stream_index * 2246822519)) % cadence_seconds`

Implementation note:

- compute the formula with 64-bit integer arithmetic or inside Postgres; do not rely on JavaScript floating-point math for the stored offset

Scheduling rules:

- `next_due_at` is always the next future slot boundary plus `slot_offset_seconds`
- the system never uses `last_success + cadence` drift scheduling

### 2.8 Page Executor

The page executor is a custom `fetch()` loop, not a `work()` callback.

Loop behavior:

1. Poll `fetch('sync.page.execute', { batchSize: 1, includeMetadata: true, priority: true })`.
2. If no job exists, sleep for 1 second and poll again.
3. When a job is fetched, start a heartbeat timer that calls `touch()` every 15 seconds.
4. Load the page’s `sync_stream_state` rows.
5. Choose the highest-priority runnable row ordered by:
   - `effective_priority DESC`
   - `desired_at ASC NULLS LAST`
   - fixed stream tie-break: `light`, `transactions`, `subscribers`, `followers`, `followers_reconcile`
6. Execute exactly one bounded chunk for that stream.
7. Persist business data, checkpoint state, and control-plane state.
8. Stop heartbeating.
9. `complete()` the current wakeup.
10. Re-read the page state. If any runnable pending row remains, immediately `send()` the successor wakeup for that same page.

Immediate continuation rule:

- If the page still has pending work that is runnable now, the executor re-enqueues the page immediately after `complete()`.
- If the page only has rows that are still pending but backed off or `auth_failed`, the executor does not re-enqueue. The planner will wake the page later when the row becomes runnable again.

Chunk budget:

- hard wall-clock limit: 45 seconds
- hard provider-request limit: 5 upstream requests
- whichever limit is hit first, the chunk persists progress and yields

### 2.9 Trigger Model

All triggers become desired-state writes plus a page wakeup hint.

Trigger order:

1. update `sync_stream_state`
2. commit
3. call immediate `send('sync.page.execute', ...)`

User-facing scope mapping:

- `light`
  - Fansly: `light`, `transactions`, `subscribers`
  - OnlyFans: `light`, `transactions`
- `followers`
  - Fansly: `followers`
- `all`
  - Fansly: `light`, `transactions`, `subscribers`, `followers`, `followers_reconcile`
  - OnlyFans: `light`, `transactions`

Public-scope rule:

- `followers_reconcile` is not a standalone public scope in the first cut. It is scheduled, anomaly-driven, and included in `all`.

Rules:

- Manual and onboarding requests increment `desired_revision` for every targeted row.
- Manual requests set `pending_reason = 'manual'` and `effective_priority = 90`.
- Onboarding requests set `pending_reason = 'onboarding'` and `effective_priority = 100`.
- `send()` is a wakeup hint only. If it returns `null`, that is fine; the durable desired-state write already preserved the work.

CLI behavior:

- CLI commands stop running sync code inline.
- CLI writes desired state, nudges the page queue, and may optionally block until the targeted revisions converge by polling `sync_stream_state`.

### 2.10 Stream Semantics

#### `light`

Responsibilities:

- refresh page metadata
- update provider identity, counts, balances, and page-level metadata
- update legacy `platform_accounts.last_light_sync_at`

Rules:

- `light` does not run transactions or subscribers.
- `light` should normally complete in one chunk.
- `light` owns page metadata freshness. Other streams read stored metadata or fetch provider metadata only when they explicitly need it at revision start.

#### `transactions`

Responsibilities:

- incremental transaction sync
- resumable transaction backfill

Rules:

- Reuse the current checkpoint model in `sync_checkpoints`.
- Persist incremental or backfill progress after every provider page, exactly as the current resumable transaction path already does.
- Mark the row satisfied only when the requested revision has completed its current incremental or backfill continuation.

Checkpoint state:

- keep the existing transaction backfill state shape
- continue using `upsertCheckpointProgress()` during chunk execution

#### `subscribers`

Responsibilities:

- full subscriber scan
- current/non-current reconciliation

Initialization at the start of a new revision:

- allocate `generation = previous_generation + 1`
- persist `{ generation, offset: 0, pageCount: 0, providerReportedTotal: null }` in `sync_checkpoints.state`

Per provider page:

- fetch one subscriber page
- persist the raw payload
- hydrate fans for that page only
- upsert `page_subscriptions` rows with `last_seen_generation = generation` and `is_current = true`
- update `fan_pages.is_subscriber` for rows seen in that page
- persist the new offset and page count after each provider page

Finalize only after the full scan completes:

- if the first page returns zero rows while current subscriber rows already exist, record an anomaly, back off, and refuse destructive finalization
- set `page_subscriptions.is_current = false` for rows on that page where `is_current = true` and `(last_seen_generation IS NULL OR last_seen_generation < generation)`
- update `fan_pages.is_subscriber = false` for fans no longer in current subscriptions
- rebuild subscriber rollups
- update the checkpoint’s `last_successful_run_id`
- mark `satisfied_revision = desired_revision`

#### `followers`

Responsibilities:

- incremental follower catch-up
- maintain the forward checkpoint
- trigger reconcile when drift or checkpoint anomalies appear

Initialization at the start of a new revision:

- read the current follower checkpoint cursor as `knownFollowId`
- fetch provider metadata once for the revision to capture the page’s current provider account id and source follower count
- persist revision state in `sync_checkpoints.state`, including `knownFollowId`, `newestFollowId`, `offset`, and `sourceFollowerCount`

Per provider page:

- fetch one follower page with the current follower-page delay floor
- persist the raw payload
- upsert fans, `page_follows`, and `fan_pages.is_follower`
- if the first page has an item, set `newestFollowId`
- persist offset and `newestFollowId` after every provider page

Completion conditions:

- stop when the old checkpoint is encountered
- stop when the provider says the list is exhausted
- stop when the chunk budget is exhausted

Finalize on a completed revision:

- write `cursor_text = newestFollowId` in the `followers` checkpoint
- rebuild follower rollups
- update legacy `platform_accounts.last_follower_sync_at`
- mark `satisfied_revision = desired_revision`

Anomaly triggers for `followers_reconcile`:

- active `page_follows.is_active = true` count does not match the source follower count captured at revision start
- the scan reaches end-of-list without encountering the old checkpoint when one existed
- the checkpoint fails to advance despite processing follower data

When an anomaly occurs:

- increment `followers_reconcile.desired_revision`
- set `pending_reason = 'anomaly'`
- set `effective_priority = max(base_priority, 45)`

#### `followers_reconcile`

Responsibilities:

- full follower scan
- deactivate stale follows only after a complete scan

Initialization at the start of a new revision:

- allocate `generation = previous_generation + 1`
- fetch provider metadata once for the revision if it is not already available from a just-completed follower run
- persist `{ generation, offset: 0, pageCount: 0, sourceFollowerCount }` in `sync_checkpoints.state`

Per provider page:

- fetch one follower page
- persist the raw payload
- upsert fans, `page_follows`, and `fan_pages.is_follower`
- set `page_follows.last_seen_generation = generation` for every seen follow
- persist offset and page count after each provider page

Finalize only after the full scan completes:

- set `page_follows.is_active = false` for rows on that page where `is_active = true` and `(last_seen_generation IS NULL OR last_seen_generation < generation)`
- refresh `fan_pages.is_follower` from canonical active follows
- rebuild follower rollups
- update legacy `platform_accounts.last_follower_sync_at`
- mark `satisfied_revision = desired_revision`

### 2.11 Audit Model

The existing audit tables are retained.

Rules:

- Every chunk execution creates its own `sync_runs` row.
- `sync_runs.stream` records the stream that actually ran: `light`, `transactions`, `subscribers`, `followers`, or `followers_reconcile`.
- `sync_runs.stats` carries chunk-scoped details such as:
  - requested revision
  - yield reason
  - checkpoint summary
  - generation
  - offset
  - chunk request count
- `sync_request_attempts` and `sync_run_events` remain unchanged.
- `sync_checkpoints` remains the stream-local resume-state table.

### 2.12 Failure Semantics

Provider 429, 5xx, timeout, and transport failures:

- catch inside the executor
- keep `desired_revision > satisfied_revision`
- increment `consecutive_failures`
- set `last_failed_at`, `last_error_code`, and `last_error_summary`
- set `backoff_until` with exponential backoff from 1 minute, capped at 30 minutes
- `complete()` the wakeup normally so the page key is released

Auth failures:

- credentials are page-scoped, so mark every active stream row for that page as `status = 'auth_failed'`
- keep unsatisfied revisions intact
- do not re-enqueue the page
- page immediately

Chunk budget exhaustion:

- normal, non-failure outcome
- persist progress
- reset `consecutive_failures` to 0
- keep `desired_revision > satisfied_revision`
- preserve the current pending reason and effective priority
- `complete()` the wakeup and immediately requeue if any runnable row remains

Worker crash, OOM, process death, or uncaught bug:

- if the process is still alive, `fail()` the current job
- if the process dies, heartbeat expiry handles retry
- queue retry and DLQ behavior is only for these infrastructure failures
- durable desired state remains unsatisfied and visible

### 2.13 Shared Rate Limiting

The final rate limiter is a shared Postgres reservation table.

Why reservation-based:

- It matches the current adapter behavior, which is minimum spacing rather than burst capacity.
- It directly models the existing `globalDelayMs` and `FOLLOWER_PAGE_DELAY_MS` behavior.

Keys:

- primary key: `(provider, scope, egress_key)`
- initial `egress_key` value: `global`

Initial scope rows:

- `fansly / global / global` with `min_spacing_ms = 2600`
- `fansly / followers_page / global` with `min_spacing_ms = 5000`
- `onlyfans / global / global` with `min_spacing_ms = 1000`

Reservation algorithm:

1. Determine the scopes needed by the request.
2. Open a short transaction.
3. `SELECT ... FOR UPDATE` every needed scope row in a fixed order: broadest scope first, then narrower scopes.
4. Compute `scheduled_at = GREATEST(now(), MAX(next_available_at))` across the locked rows.
5. For each locked row, update `next_available_at = scheduled_at + interval '1 millisecond' * min_spacing_ms`.
6. Commit.
7. Sleep outside the transaction until `scheduled_at`.

Scope rules:

- follower-page requests reserve both `fansly/global/global` and `fansly/followers_page/global`
- other current requests reserve only the provider-global row

Rollout rule:

- the process-local adapter limiter remains authoritative until the shared reservation flow is enabled
- no second executor process is allowed before the shared limiter is live
- after rollout, the adapter-local delay becomes a safety pad, not the correctness boundary

### 2.14 Legacy Compatibility Rules

Legacy columns remain for compatibility, but they are no longer the source of truth.

- `platform_accounts.last_light_sync_at` is updated by successful `light` runs only.
- `platform_accounts.last_follower_sync_at` is updated by successful `followers` and `followers_reconcile` runs.
- UI or API code that needs authoritative per-stream freshness must read `sync_stream_state.last_succeeded_at`.

## 3. SQL Schema

### 3.1 Enum Changes

```sql
ALTER TYPE sync_stream ADD VALUE IF NOT EXISTS 'followers_reconcile';

CREATE TYPE sync_target_status AS ENUM (
  'active',
  'paused',
  'auth_failed',
  'disabled'
);

CREATE TYPE sync_request_reason AS ENUM (
  'scheduled',
  'manual',
  'onboarding',
  'recovery',
  'anomaly'
);
```

### 3.2 New Table: `sync_stream_state`

```sql
CREATE TABLE sync_stream_state (
  platform_account_id BIGINT NOT NULL
    REFERENCES platform_accounts(id) ON DELETE CASCADE,
  stream sync_stream NOT NULL,
  status sync_target_status NOT NULL DEFAULT 'active',

  cadence_seconds INTEGER NOT NULL CHECK (cadence_seconds > 0),
  slot_offset_seconds INTEGER NOT NULL CHECK (slot_offset_seconds >= 0),
  next_due_at TIMESTAMPTZ NOT NULL,

  base_priority SMALLINT NOT NULL CHECK (base_priority BETWEEN 0 AND 100),
  effective_priority SMALLINT NOT NULL CHECK (effective_priority BETWEEN 0 AND 100),
  pending_reason sync_request_reason NOT NULL DEFAULT 'scheduled',

  desired_revision BIGINT NOT NULL DEFAULT 0,
  satisfied_revision BIGINT NOT NULL DEFAULT 0,
  desired_at TIMESTAMPTZ,

  backoff_until TIMESTAMPTZ NOT NULL DEFAULT '-infinity'::timestamptz,
  last_enqueued_at TIMESTAMPTZ,
  last_started_at TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ,
  last_succeeded_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error_code TEXT,
  last_error_summary TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (platform_account_id, stream),
  CHECK (stream IN (
    'light',
    'transactions',
    'subscribers',
    'followers',
    'followers_reconcile'
  )),
  CHECK (slot_offset_seconds < cadence_seconds),
  CHECK (desired_revision >= satisfied_revision)
);

CREATE INDEX sync_stream_state_due_idx
  ON sync_stream_state (next_due_at ASC, platform_account_id ASC)
  WHERE status = 'active'
    AND desired_revision = satisfied_revision;

CREATE INDEX sync_stream_state_pending_idx
  ON sync_stream_state (
    effective_priority DESC,
    desired_at ASC NULLS LAST,
    platform_account_id ASC,
    stream ASC
  )
  WHERE status = 'active'
    AND desired_revision > satisfied_revision;

CREATE INDEX sync_stream_state_backoff_idx
  ON sync_stream_state (backoff_until ASC, platform_account_id ASC)
  WHERE status = 'active'
    AND desired_revision > satisfied_revision;

CREATE INDEX sync_stream_state_freshness_idx
  ON sync_stream_state (stream, last_succeeded_at);
```

### 3.3 New Table: `sync_provider_rate_limits`

```sql
CREATE TABLE sync_provider_rate_limits (
  provider platform NOT NULL,
  scope TEXT NOT NULL,
  egress_key TEXT NOT NULL,
  min_spacing_ms INTEGER NOT NULL CHECK (min_spacing_ms >= 0),
  next_available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (provider, scope, egress_key)
);
```

### 3.4 Alter Existing Canonical Tables

```sql
ALTER TABLE page_follows
  ADD COLUMN IF NOT EXISTS last_seen_generation BIGINT;

CREATE INDEX IF NOT EXISTS page_follows_generation_idx
  ON page_follows (platform_account_id, last_seen_generation)
  WHERE is_active = true;
```

```sql
ALTER TABLE page_subscriptions
  ADD COLUMN IF NOT EXISTS last_seen_generation BIGINT;

CREATE INDEX IF NOT EXISTS page_subscriptions_generation_idx
  ON page_subscriptions (platform_account_id, last_seen_generation)
  WHERE is_current = true;
```

### 3.5 Existing Tables Retained

No new audit tables are introduced.

Retained tables:

- `sync_runs`
- `sync_request_attempts`
- `sync_run_events`
- `sync_checkpoints`
- `raw_payloads`

Required application changes to existing schemas and repositories:

- update TypeScript unions and repository helpers so `sync_stream` includes `followers_reconcile`
- continue using `sync_checkpoints` as the resumable state store
- continue using `sync_runs.stats` as the extensible chunk audit payload

### 3.6 Checkpoint State Shapes

These shapes live in `sync_checkpoints.state`. No new checkpoint table is needed.

- `transactions`
  - existing transaction backfill state remains in place
- `subscribers`
  - `generation`
  - `offset`
  - `pageCount`
  - `providerReportedTotal`
- `followers`
  - `knownFollowId`
  - `newestFollowId`
  - `offset`
  - `pageCount`
  - `sourceFollowerCount`
- `followers_reconcile`
  - `generation`
  - `offset`
  - `pageCount`
  - `sourceFollowerCount`

## 4. Migration Plan

The old and new execution paths do not run live in parallel. The planner can run in shadow mode, but only one execution path is live per stream family at a time.

### Phase 0: Immediate Safety Patch

Effort: 1 engineer-day

- Change the legacy `sync.trigger` worker to `batchSize = 1`.
- Add temporary metrics for:
  - advisory-lock skips
  - `sync.trigger` batch-worker failures
- Stop treating lock skips as a healthy steady state in alerts.

Exit criteria:

- no fetched `sync.trigger` batch contains more than one job
- lock-skip rate is visible

### Phase 1: Add Control-Plane Schema and Seed State

Effort: 2 engineer-days

- Apply the schema in Section 3.
- Add repository methods for:
  - upserting `sync_stream_state`
  - incrementing desired revisions
  - selecting due and pending rows
  - updating backoff, auth failure, and success state
- Seed stream rows:
  - Fansly existing pages: `light`, `transactions`, `subscribers`, `followers`, `followers_reconcile`
  - OnlyFans existing pages: `light`, `transactions`
- Compute `slot_offset_seconds` with the deterministic formula in Section 2.7.

Seed rules:

- If a legacy success timestamp is trustworthy for that stream family, seed the row as satisfied and set `next_due_at` to the next future scheduled slot.
- If freshness is unknown, seed `desired_revision = 1`, `satisfied_revision = 0`, `pending_reason = 'recovery'`, and `effective_priority = max(base_priority, 45)`.
- For existing Fansly pages, seed `followers_reconcile` as pending recovery only when:
  - `last_follower_sync_at` is null, or
  - `last_follower_sync_at` is older than 48 hours, or
  - `platform_accounts.follower_count` differs from the current active `page_follows` count
- For newly onboarded pages:
  - Fansly: seed `light`, `transactions`, `subscribers`, and `followers` as pending onboarding
  - OnlyFans: seed `light` and `transactions` as pending onboarding
  - do not seed `followers_reconcile` as pending for brand-new pages

Seed limiter rows:

- `fansly/global/global` with `2600`
- `fansly/followers_page/global` with `5000`
- `onlyfans/global/global` with `1000`

Exit criteria:

- every page has the correct `sync_stream_state` rows
- repository helpers exist for desired-state updates and planner queries

### Phase 2: Create Queues and Run the Planner in Shadow Mode

Effort: 2 engineer-days

- Create `sync.planner`, `sync.planner.dlq`, `sync.page.execute`, and `sync.page.execute.dlq`.
- Implement the planner, but keep it in observe-only mode.
- Emit shadow metrics showing:
  - which rows would have been promoted
  - which pages would have been woken
  - where shadow output differs from legacy light and follower cron activity

Exit criteria:

- shadow planner output is stable for 2 business days
- no live execution is driven by the new planner yet

### Phase 3: Rewrite Triggers and CLI Entry Points

Effort: 2 engineer-days

- Replace `enqueueSyncTriggerJob()` and `enqueueInitialFullSync()` with desired-state writes plus page wakeups.
- Update:
  - `POST /api/v1/admin/sync/trigger`
  - `POST /api/v1/admin/sync/trigger-all`
  - page onboarding flows
  - CLI `sync` entry points
- Remove new writes to `sync.trigger`.
- Make CLI wait for revision convergence instead of running sync code inline when blocking behavior is needed.

Exit criteria:

- all new work enters through `sync_stream_state`
- API and CLI no longer bypass the control plane

### Phase 4: Cut Over `light` and `transactions`

Effort: 3 engineer-days

- Implement the `sync.page.execute` fetch worker.
- Split the current light-family code into explicit `light`, `transactions`, and `subscribers` executor handlers.
- Activate planner emission for `light` and `transactions` only.
- Keep `subscribers` rows present but planner-gated or `paused` until Phase 5.
- Remove metadata and transaction execution from the legacy `runLightSync()` path.
- Disable per-page hourly light queue creation for metadata and transaction work.

Exit criteria:

- metadata and transactions run only through planner plus page executor
- subscriber live execution is still isolated behind the Phase 5 cutover gate

Recommended soak:

- 1 business day

### Phase 5: Cut Over `subscribers`

Effort: 2 engineer-days

- Activate planner emission for `subscribers`.
- Preserve the subscriber “suspicious zero rows” destructive-clear guard.
- Remove subscriber execution from the legacy `runLightSync()` path.
- Disable any remaining legacy subscriber scheduling.

Exit criteria:

- subscribers run only through planner plus page executor
- no subscriber path depends on a full in-memory snapshot

Recommended soak:

- 1 business day

### Phase 6: Cut Over the Follower Family

Effort: 3 engineer-days

- Persist follower incremental progress after every provider page.
- Implement `followers_reconcile` with generation-based deactivation.
- Cut over follower execution to `followers` and `followers_reconcile`.
- Disable per-page follower cron queues.
- Remove advisory locks from the new sync execution path.
- Retire `runAllSync()` as an execution primitive.

Exit criteria:

- no follower path depends on end-of-run-only checkpoint persistence
- no follower path keeps the full active set in memory
- no per-page follower queues remain active

Recommended soak:

- 2 business days

### Phase 7: Enable the Shared Limiter

Effort: 2 engineer-days

- Activate the `sync_provider_rate_limits` reservation flow in the runtime adapters.
- Reduce the adapter-local delay to safety-pad behavior only.
- Keep the deployment at one executor process until this phase is complete.

Exit criteria:

- global rate limiting is enforced through Postgres
- multi-worker execution is now safe

### Phase 8: Remove Legacy Paths

Effort: 1 engineer-day

- Delete per-page queue creation and discovery.
- Delete `sync.trigger` and its worker.
- Delete advisory-lock helpers from sync execution.
- Delete `enqueueSyncTriggerJob()`, `enqueueInitialFullSync()`, `lightQueueName()`, and `followerQueueName()`.
- Remove dashboards that treat `skipped` as normal sync behavior.

Exit criteria:

- only the planner plus page-executor architecture remains

### Total

- Implementation: 18 engineer-days
- Recommended soak: 4 business days total

## 5. Observability

### 5.1 Metrics

Planner and backlog:

- `sync_planner_cycle_seconds` histogram
- `sync_stream_due_total{stream,reason}` counter
- `sync_stream_oldest_due_seconds{stream}` gauge
- `sync_stream_revision_lag{stream}` gauge
- `sync_stream_status_total{stream,status}` gauge

Queue and wakeups:

- `sync_page_execute_queue_wait_seconds` histogram
- `sync_page_execute_queue_depth` gauge
- `sync_page_execute_dedup_total{result="created|duplicate"}` counter
- `sync_pg_boss_dead_letter_total{queue}` gauge
- `sync_page_job_infra_retry_total{queue}` counter

Execution:

- `sync_page_chunk_duration_seconds{stream}` histogram
- `sync_page_chunk_requests_total{provider,stream}` counter
- `sync_page_chunk_yield_total{stream,reason="request_budget|wall_clock|backoff"}` counter
- `sync_page_chunk_budget_exhausted_total{stream,budget="request_budget|wall_clock"}` counter
- `sync_stream_backoff_total{stream,error_code}` counter
- `sync_stream_consecutive_failures{stream,platform_account_id}` gauge
- `sync_stream_auth_failed_total{platform}` gauge

Freshness and latency:

- `sync_stream_freshness_seconds{stream,platform_account_id}` gauge
- `sync_stream_time_to_success_seconds{stream,reason}` histogram
- `sync_manual_start_latency_seconds` histogram

Checkpoint and generation progress:

- `sync_stream_resume_offset{stream,platform_account_id}` gauge
- `sync_stream_generation_age_seconds{stream,platform_account_id}` gauge
- `sync_stream_provider_total_mismatch_total{stream}` counter

Rate limiting:

- `sync_provider_limit_wait_seconds{provider,scope,egress_key}` histogram
- `sync_provider_limit_reservations_total{provider,scope,egress_key}` counter
- `sync_provider_limit_next_available_lag_seconds{provider,scope,egress_key}` gauge

### 5.2 Alert Thresholds

Planner:

- warn: `sync_planner_cycle_seconds` p95 > 5s for 15m
- critical: `sync_planner_cycle_seconds` p95 > 15s for 15m

Queue health:

- warn: `sync_page_execute_queue_wait_seconds` p95 > 120s for 15m
- critical: `sync_page_execute_queue_wait_seconds` p95 > 300s for 15m
- critical: `sync_pg_boss_dead_letter_total{queue="sync.page.execute.dlq"} > 0`
- critical: `sync_pg_boss_dead_letter_total{queue="sync.planner.dlq"} > 0`

Chunk duration:

- warn: `sync_page_chunk_duration_seconds` p95 > 60s for 15m
- critical: any chunk duration > 180s
- warn: sustained increase in `sync_page_chunk_budget_exhausted_total{budget="wall_clock"}` for the same stream for 30m

Freshness:

- critical: `sync_stream_freshness_seconds{stream="light"}` > 7200
- critical: `sync_stream_freshness_seconds{stream="transactions"}` > 7200
- warn: `sync_stream_freshness_seconds{stream="subscribers"}` > 14400
- critical: `sync_stream_freshness_seconds{stream="subscribers"}` > 21600
- warn: `sync_stream_freshness_seconds{stream="followers"}` > 64800
- critical: `sync_stream_freshness_seconds{stream="followers"}` > 86400
- warn: `sync_stream_freshness_seconds{stream="followers_reconcile"}` > 259200
- critical: `sync_stream_freshness_seconds{stream="followers_reconcile"}` > 345600

Backlog and revision lag:

- warn: `sync_stream_oldest_due_seconds{stream="light"}` > 1800 for 10m
- warn: `sync_stream_oldest_due_seconds{stream="transactions"}` > 1800 for 10m
- warn: `sync_stream_oldest_due_seconds{stream="subscribers"}` > 7200 for 30m
- warn: `sync_stream_oldest_due_seconds{stream="followers"}` > 21600 for 60m
- warn: `sync_stream_oldest_due_seconds{stream="followers_reconcile"}` > 86400 for 120m
- warn: `sync_stream_revision_lag{stream}` > 3 for 15m
- critical: `sync_stream_revision_lag{stream}` > 10 for 15m

Manual work:

- warn: `sync_manual_start_latency_seconds` p95 > 120s for 15m
- critical: `sync_manual_start_latency_seconds` p95 > 300s for 15m

Auth and limiter:

- critical: `sync_stream_auth_failed_total > 0`
- warn: `sync_provider_limit_wait_seconds{provider="fansly",scope="global"}` p95 > 30s for 30m
- critical: `sync_provider_limit_wait_seconds{provider="fansly",scope="global"}` p95 > 120s for 30m

### 5.3 Dashboards

1. Control Plane

- due rows by stream
- oldest due seconds
- revision lag
- stream status counts

2. Queue Health

- queue depth
- queue wait latency
- dedup result counts
- DLQ counts
- infrastructure retries

3. Executor

- chunk duration by stream
- chunk request counts
- yield reasons
- budget exhaustion counts by stream and budget
- business backoff counts
- consecutive failures by page

4. Freshness and Manual SLA

- freshness by stream and page
- time-to-success by reason
- manual start latency

5. Resume Progress

- subscriber offsets
- follower incremental offsets
- follower reconcile offsets
- generation ages

6. Rate Limiting

- reservation counts by scope
- wait time distributions
- next-available lag

7. Migration

- shadow planner output versus legacy cron fires
- shadow planner page gaps by stream
- legacy advisory-lock skips
- legacy trigger worker failures
- execution-path split (`legacy` versus `new`) during cutover

### 5.4 Transitional Metrics

Keep these until legacy scheduling and execution are removed:

- `sync_legacy_lock_skip_total`
- `sync_legacy_trigger_batch_failure_total`
- `sync_legacy_cron_fire_total{stream}`
- `sync_shadow_planner_due_total{stream}`
- `sync_shadow_planner_emission_total{stream}`
- `sync_shadow_planner_wakeup_total{stream,result}`
- `sync_shadow_planner_page_gap_total{stream}`
- `sync_cutover_execution_total{path="legacy|new",stream}`

Transitional alerts:

- critical: any increase in `sync_legacy_lock_skip_total` after Phase 6
- critical: any increase in `sync_legacy_trigger_batch_failure_total` after Phase 0
- warn: any increase in `sync_shadow_planner_page_gap_total{stream}` during Phase 2

## 6. What Not To Do

1. Do not keep per-page cron queues or `sync.trigger` as long-term scheduler primitives.
2. Do not keep advisory locks in the new execution path.
3. Do not split the page mutex by stream. One page lock is the design.
4. Do not use `sendDebounced()` for manual, onboarding, or freshness-critical wakeups.
5. Do not cancel queued page jobs to reprioritize them. The public `pg-boss` API makes that race unsafe.
6. Do not use `pending_since`-style timestamps as the correctness boundary.
7. Do not keep transactions or subscribers hidden behind a scheduler-visible `light` umbrella.
8. Do not reintroduce `all` as a runnable execution job type.
9. Do not keep follower or subscriber full snapshots in memory.
10. Do not update follower incremental checkpoints only at end-of-run.
11. Do not use `groupConcurrency`, `key_strict_fifo`, or `stately` as the page mutex.
12. Do not add a custom page lease table on top of `exclusive + singletonKey`.
13. Do not query `pgboss.job` as planner source-of-truth state.
14. Do not add artificial planner emission caps.
15. Do not make the planner aware of rate-limit token math. The planner decides what is due; the limiter decides when requests may leave.
16. Do not add a second executor process before the shared limiter is enabled.
17. Do not use `work()` for the page executor when same-page continuation must happen immediately after a chunk yields.
18. Do not use `batchSize > 1` for any sync execution queue.
19. Do not implement sleep-based retry loops inside workers. Backoff belongs in durable control-plane state.

## 7. Corrections

### 7.1 Incorrect

1. `sendDebounced()` is not suitable for urgent manual wakeups. Verified in `manager.js`: it sets `singletonNextSlot = true` and computes a future `startAfter`.
2. `findJobs()` plus `cancel()` plus `send()` is not a safe way to reprioritize page wakeups. Verified in `plans.js`: `cancel()` updates any job where `state < completed`, so a read-then-cancel race can cancel an already-active page job and release the singleton key while the original worker is still running.
3. `work(batchSize=1)` is enough to fix legacy batch coupling, but it is not enough for the final page executor. Verified in `manager.js`: `work()` completes active jobs only after the callback returns, so it cannot safely release the page key before sending the successor same-page wakeup.
4. `pg-boss` default `retryLimit` is 2, not “unset” or implicitly higher. Verified in `plans.js`.
5. Any migration plan that seeds OnlyFans `subscribers` rows is wrong for this codebase. The current OnlyFans path in `sync.ts` has `light` and `transactions` only; there is no OnlyFans subscriber sync implementation to cut over.

### 7.2 Unverified or Too Weak to Base the Final Design On

1. Throughput estimates such as “N minutes for a 15k-follower page” are illustrative only. They depend on live provider behavior and page cardinalities that cannot be verified from this repository.
2. Exact cross-instance claims about `schedule()` internals were not required for the final design and were not used as correctness assumptions. The planner queue is `exclusive`, and planner logic is idempotent.
3. References to `node_modules/pg-boss/src/...` are not the installed package surface in this repository. The verified files are under `node_modules/pg-boss/dist/...`.
