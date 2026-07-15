> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Sync Engine

The sync engine is a durable per-page, per-stream state machine. PostgreSQL
decides what work is due, owns cursors and retry times, and records progress;
pg-boss provides disposable wakeups. Platform handlers fetch one bounded
chunk, journal raw responses, update projections, and either complete or yield
back to the queue.

## 1. Durable state and scheduling policy

`packages/db/src/repositories/page-sync.ts` defines the eleven streams, their
domains, cadence, work class, dependencies, priorities, and state transitions.
`page_sync_states` is the retry and reconciliation authority. A queue row can
expire or disappear without losing the request, because the planner can
materialize another wakeup from durable state.

| Stream | Domain | Cadence | Scheduled priority | Default class |
|---|---|---:|---:|---|
| `light` | connection | 1 h | 60 | live |
| `transactions` | financials | 1 h | 50 | live |
| `fan_identities` | financials | 6 h | 49 | maintenance |
| `top_spenders` | financials | 1 h | 45 | maintenance |
| `subscribers` | audience | 1 h | 40 | live |
| `followers` | audience | 1 h | 35 | live |
| `followers_reconcile` | audience | 48 h | 34 | maintenance |
| `dm_conversations` | messages_live | 30 min | 30 | live |
| `dm_messages` | messages_history | 24 h | 25 | history |
| `fan_earnings` | financials | 24 h | 20 | maintenance |
| `purchase_history` | messages_history | 4 h | 19 | history |

The policy's base priority for `purchase_history` is 15; scheduled requests
receive 19 through the source-specific priority table. Manual, onboarding,
reset, recovery, and anomaly requests receive their own boosts without
changing stream order.

Dependencies are also durable policy: `top_spenders` follows transactions;
`followers_reconcile` follows followers; `purchase_history` follows light;
message-head and message-history work wait for progressively larger page
foundations. `getSyncStreamDependenciesForPage` applies platform-specific
exceptions, including the reduced OFAPI DM prerequisite set.

Migration `packages/db/migrations/0089_page_sync_dispatch_source.sql` separates
immutable `request_source` audit lineage from mutable `dispatch_source`.
Continuation and superseding generations can therefore retain the fair
scheduling class without rewriting how the request originated.

Tombstoned pages are excluded by the repository's active-page predicates, so
they are not scheduled, leased, or kept alive by executor continuation.

## 2. Planner

`apps/runtime/src/services/sync/planner.ts` runs the minutely planner cycle:

1. Close sync runs inactive for more than 90 seconds.
2. Ensure every active page has the required stream-state rows.
3. Pause flag-ineligible OnlyFans DM, audience, and top-spender streams.
4. Turn due policy slots into pending durable requests.
5. List runnable pages, send one page wakeup, and mark successful enqueue.

The planner does not encode retry delay in `startAfter`. Retry timing stays in
`page_sync_states.retry_at`; the planner sends a wakeup only when that state is
runnable.

Manual/API scheduling flows through `apps/runtime/src/services/sync-control.ts`
and the same repository transitions. A newer request can supersede the
currently leased generation; completion/yield compare request sequence before
deciding whether the stream is really finished.

## 3. Queue lane and fairness

`apps/runtime/src/services/sync-queue.ts` owns queue `sync.page.execute` and its
dead-letter queue. Its production contract is:

- exclusive queue policy;
- 15-minute expiry;
- 30-second heartbeat;
- `retryLimit: 0`, because durable state owns retries;
- singleton key equal to the page id;
- group id from provider plus egress key, limiting one active page per egress
  lane.

Queue creation alone is conflict-no-op in pg-boss, so startup explicitly calls
`updateQueue`, reads the queue back, and fails if policy, expiry, heartbeat, or
retry limit still drift.

`apps/runtime/src/services/sync/executor.ts` fetches FIFO across available
groups (`priority: false`, creation order, group concurrency one). Numeric
stream priority remains inside the page state; FIFO page wakeups and one-chunk
quantums prevent a continuously renewed high-priority page from starving an
older page that shares its egress.

Multiple local workers share a serialized fetch section and an active-group
set. The fetch excludes groups already running in this process, closing the
window between pg-boss fetches and its group accounting.

## 4. One job, one chunk

`processSyncPageExecuteJob` executes exactly one bounded chunk. It never drains
the page locally. A required continuation returns to pg-boss so queue ordering
can arbitrate again.

Parent completion and child insertion occur in one PostgreSQL transaction via
pg-boss's caller-supplied database wrapper. Completion must report exactly one
affected row before the child can be inserted. A database-clock check refuses
handoff inside the final 60 seconds of the job expiry window; the planner then
reconciles durable state. Jobs created under old expiry, retry, or singleton
semantics are detected and rolled forward without making a vendor request.

`runSyncPageExecutorUntilIdle` is a CLI/test helper. It is not the production
worker fairness path.

## 5. Leasing, budgets, and yields

The executor chooses the highest durable runnable stream for the page, claims
its request generation, dispatches the platform handler, and records complete,
yield, retry, block, or pause through repository compare-and-set transitions.

`apps/runtime/src/services/sync/chunk-budget.ts` bounds a chunk to five HTTP
requests and 45 seconds by default. The request observer counts actual started
requests, including retries. `hasRequestCapacity(count)` lets a multi-call unit
reserve its entire cost; Fansly fan earnings reserves two calls before
starting a fan. `resolveYieldReason` records either `request_budget` or
`wall_clock` against the same required capacity.

Yielded cursors and checkpoints are stored before continuation. The cursor is
stream-specific JSON and is always interpreted by the matching handler; the
generic executor treats it as opaque state. A completed walk resets the cursor
where the handler requires a fresh cadence walk.

## 6. Platform dispatch

`apps/runtime/src/platforms/registry.ts` maps platform capability to split
handler functions in `apps/runtime/src/services/sync/executor-handlers.ts`:

- Fansly supports every stream except `fan_identities`: ten streams total.
- OnlyFans supports `light`, `transactions`, `fan_identities`, `top_spenders`,
  `subscribers`, `dm_conversations`, and `dm_messages`: seven streams total.

The registry also defines manual trigger scopes. Fansly's `all` scope
deliberately omits the heavy `fan_earnings` and `purchase_history` crawls even
though the adapter supports them.

The Fansly bulk-stream gate in `apps/runtime/src/services/sync/fansly-stream-gate.ts`
is ramp-aware. An empty or blank allowlist means every page. The gate reports
`ramped`, `flag_off`, `not_allowlisted`, or `unsupported_platform`; disabled
bulk work stays out of normal page-health expectations.

## 7. Raw-response journaling

Every successful fetch reaches `persistRawPayload` before its durable cursor is
advanced. Sync execution context increments a fetch counter, producing an
idempotency key of the form
`<page>:<stream>:<run>:<nextPageSyncObservationSeq>`. The counter is per HTTP
fetch, not per logical page or cursor value, so repeated shapes in one run do
not collide. Failed fetches are journaled best-effort with the same fetch
sequence discipline and failure metadata.

These `pull` observations feed the canonicalizers described in
`docs/generated/06-capture-and-canonicalization.md`. Projection writes that are
part of a stream happen after capture and use stream-specific idempotency or
upsert rules.

## 8. Notable stream behavior

OnlyFans DM history in `apps/runtime/src/services/sync/ofapi-dm-sync.ts` uses a
conversation-local adaptive breaker. The normal message page size is 100. An
opaque first-page timeout is retried as single attempts at 20 and then 5.
Three distinct conversation failures in one run escalate to page/provider
failure. Per-chat health, quarantine, and a sticky preferred page limit keep a
poison chat from pinning the whole stream. Regular conversations retain 200
messages; spender conversations retain 1,000.

DM thread-summary finalization is intentionally separated from vendor fact
capture. A failure records projection debt and allows the sync chunk to keep
its captured facts. `apps/runtime/src/services/projection-debt-sweep.ts` repairs
that debt every five minutes without calling a platform.

Fansly top-spender work has bootstrap and current-window modes and a bounded
candidate cap. Fansly fan-earnings and purchase-history walks are low-priority,
flag/ramp-gated bulk work rather than prerequisites for the ordinary
financial/messages health blocks.

## 9. Failure classification and health

`apps/runtime/src/services/sync/executor.ts` classifies failures before writing
state:

- provider 401/403 is account auth failure and pauses every page stream;
- `ProxyMissingError` or `FanslyProxyMissingError` is a permanent
  `manual_action_required` / `proxy_missing` blocker;
- rate limits and transient transport failures become durable retries with a
  future `retry_at`;
- unsupported or explicitly disabled paths become paused/blocked according to
  their handler result rather than hot-looping.

Worker heartbeats, runs, per-stream progress, blocks, queue delay, and
freshness summaries are exposed through `sync-status.ts`, `sync-monitor.ts`,
`sync-summary.ts`, `sync-blocks.ts`, and `sync/observability.ts`. Those views
derive from durable stream state; queue presence alone is not evidence that a
sync is healthy or complete.
