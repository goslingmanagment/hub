# Sync Queue Grouping Design

## Current state

The queue currently uses pg-boss `groupConcurrency: 1` in the page executor, and jobs are grouped by `buildSyncPageExecuteGroupId(provider, egressKey)`.

Before T6, all direct pages shared:

- `fansly:direct`
- `onlyfans:direct`

That was a deliberate coarse guardrail. All direct pages for a provider originate from the same real IP, so serializing them at the queue level prevented concurrent sync streams from piling requests onto one IP.

T6 changed direct grouping to per-page groups such as `fansly:page:<id>`. That improves throughput, but it also allows multiple direct pages to run active sync chunks at the same time. Because Fansly is especially sensitive to API abuse, this is unsafe: separate page jobs still share one egress IP, and the queue no longer limits stream concurrency for that IP.

The system already has two useful controls:

- per-request provider delays in the HTTP adapters
- an optional DB-backed shared rate limiter in `sync_provider_rate_limits`

Those controls pace request starts, but they do not provide a full stream-level ownership boundary. Multiple direct jobs can still become active simultaneously and compete for request slots, which raises fairness and safety concerns.

## Rejected approaches

### 1. Stream-type grouping

Example: allow `light` and `transactions` to run in parallel while serializing only same-stream work.

Rejected because it does not solve the real safety problem. Two different stream types from two direct pages would still hit the provider from the same IP concurrently.

### 2. Limited direct parallelism with permits

Example: allow 2 direct streams per provider/IP behind a semaphore.

Rejected for v1 because the production requirement is to be maximally cautious, and the current direct page counts are small. There is no evidence yet that direct Fansly traffic is safe with more than one concurrent active stream per IP.

### 3. Planner-only fairness changes

Example: round-robin scheduling or stricter chunk requeueing without a lower-layer gate.

Rejected as a standalone fix. Planner fairness can reduce monopolization, but it does not create a real concurrency boundary for outbound direct traffic. Unsafe overlap would still be possible if queue grouping becomes per-page again.

## Recommended design

Implement a shared request queue at the HTTP/request layer keyed by:

- `provider`
- `egressKey`

This queue is the safety boundary. Every outbound provider request must acquire the provider+egress gate before leaving the process.

### Required properties

- Cross-process: multiple workers must coordinate through Postgres, not only in-memory state.
- Fair: requests should be admitted in arrival order, or close enough to FIFO that one busy page cannot starve others.
- Held for full request lifetime: the gate must remain owned until the outbound request completes or fails.
- Layered with existing spacing: after the gate is acquired, the existing `sync_provider_rate_limits` reservation logic should still determine when the request may start.

### Why this is the right boundary

- It protects the real resource: provider traffic from one IP.
- It allows future queue-level concurrency improvements without losing safety.
- It works for both direct pages and proxy-backed pages using the same `provider + egressKey` identity model already present in the codebase.

## Target behavior after the future design

### v1 safety defaults

- Direct traffic: `maxInFlightRequests = 1` per `(provider, egressKey)`.
- Proxied traffic: also `maxInFlightRequests = 1` per `(provider, egressKey)` in v1.
- Any higher concurrency for a proxy is future-only and must be explicitly configured after measurement.
- No provider may bypass the request gate when executor concurrency is greater than 1.

### Queue/executor behavior

Once the request gate exists, queue grouping can safely move back to per-page groups:

- Use `provider:page:<id>` or equivalent page-unique groups.
- Keep pg-boss `groupConcurrency: 1` so the same page never runs in parallel with itself.
- Let multiple unrelated pages become active concurrently.
- Rely on the request gate, not the queue group, to keep same-IP traffic safe.

## Additional fairness fix required

The executor currently chains many local chunks for the same page before fully yielding, controlled by `MAX_LOCAL_EXECUTOR_CHUNKS`. That lets one page monopolize worker attention even when request pacing is safe.

Future change:

- After each chunk, prefer requeueing continuation work instead of looping for many local chunks.
- Target one chunk per job execution in normal operation.
- Preserve urgent continuation only for narrow cases where requeue fails and local progress is necessary.

This gives round-robin behavior across pages and reduces starvation, while the request gate keeps outbound traffic safe.

## Implementation plan for the future design

### Phase 1: add a request gate

- Add a new Postgres-backed coordination primitive for provider+egress request ownership.
- Gate acquisition must happen immediately before the outbound HTTP request.
- Release the gate after the request finishes, including failure paths.
- Keep the existing `sync_provider_rate_limits` reservation call inside the acquired gate.

Suggested storage model:

- a new table keyed by `(provider, egress_key)` for gate state
- a queue/lease record per waiter with creation order
- transaction-safe claim/release semantics

The exact schema can vary, but the behavior must be FIFO-like and cross-process.

### Phase 2: move queue grouping back to per-page

- Change `buildSyncPageExecuteGroupId` to page-unique groups.
- Leave proxied pages page-unique as well; safety now comes from the request gate.
- Keep `groupConcurrency: 1`.

### Phase 3: improve chunk fairness

- Reduce or eliminate long local continuation chaining.
- Requeue after each completed chunk when more work remains.
- Measure queue depth and per-page latency after rollout.

## Rollout constraints

- Releasing the queue-level direct serialization must not happen before the request gate is live.
- Fansly direct traffic should be rolled out first with strict `maxInFlightRequests = 1`.
- Only after observing stable request/error behavior should any proxy-specific concurrency increase be considered.
- Monitoring should include:
  - per-provider request latency
  - 429 / 5xx rates
  - per-page sync lag
  - queue depth and wait time by provider+egress

## Recommendation

Short term:

- keep `provider:direct` queue serialization for direct pages
- do not reintroduce direct per-page queue groups yet

Long term:

- build a Postgres-backed fair request gate at the HTTP layer
- then switch queue grouping to per-page groups
- then reduce executor continuation chaining to improve fairness

That sequence is the safest path that preserves the current abuse guardrail while still creating a real route to better overlap and less unnecessary blocking later.
