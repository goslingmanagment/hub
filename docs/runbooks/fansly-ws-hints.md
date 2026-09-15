# Fansly B1 addressed REST hints

Decision 344. Code and deployment are default-off. This runbook does not grant
activation or certify the live wire types. W0, seven accepted B0 shadow days,
type-specific corpus and a measured baseline remain entry requirements.

## Configuration

All settings use the existing audited live-config console.

| Key | Default | Meaning |
| --- | --- | --- |
| `fanslyWsHintsEnabled` | `false` | Admit addressed REST work |
| `fanslyWsHintsPageAllowlist` | empty | Exact comma-separated labels; no wildcard |
| `fanslyWsHintsTypeAllowlist` | empty | Individually accepted `message_created`, `group_created` |
| `fanslyWsHintsPolicies` | `{}` | Policy by exact page label |

B0 must also be enabled and allow the page. Each page policy requires:

- `generation`: the current verified W0/B0 generation digest;
- `activationAt`: an explicit ISO timestamp; earlier signals do not dispatch;
- `baselineAttempts24h`: measured physical attempts in the agreed comparable
  24-hour window, a safe integer of at least 20;
- `baselineReference`: the evidence identifying that measurement.

Missing or malformed policy, generation mismatch, empty allowlists and unknown
types grant no HTTP. The immutable baseline grants `floor(baseline/20)` extra
attempts per rolling 24 hours. Changing a flag/generation does not reset usage.
Prepare and review the real policy before an individually authorized flip.

## Execution and rollback

The minutely canonicalizer/projector routes only metadata from durable B0
frames. An event-ID receipt and subject dirty revision commit together.
Unknown children, decoder bounds and deletes remain explicit debt. A batch does
not discard valid siblings. Existing B0 envelopes without generation metadata
remain in the journal and cannot dispatch from an invented generation.

One `(page, fansly_ws_dm, group)` row absorbs bursts. The existing scheduler
can wake an idle DM stream for one addressed step; that event-only run performs
no ordinary polling. A queued ordinary request keeps its original custody.
Event-only settlement records a quality hold, preserving the ordinary stream's
freshness, failure streak and open recovery incidents. B1 progress has its own
receipts.
An ordinary DM chunk reserves at most one of its five physical attempts for a
hint. The shared page lease, proxy pacing and absolute provider cooldown apply.
The latency expectation for this route is **minutes**, measured under load.

Each hint attempt checks current live configuration and generation before
dispatch. `fanslyWsHintsEnabled=false` stops new hint HTTP; an admitted response
may finish capture and its fenced transaction. B0 capture and ordinary polling
continue. No cursor reset, credential rotation, session logout or manual data
deletion is required for rollback.

A partial message walk stores raw page IDs, never a partial hot head. Up to five
pages can be staged; only reaching the original boundary or proven exhaustion
allows an atomic hot apply. Existing hot versions beat older staged versions.
If five pages do not reach the boundary, the target backs off one hour and the
raw material stays captured; unchanged ordinary polling remains responsible
for large gaps. A newer revision arriving during a walk remains pending.
Every enabled message-created target must also exist as an active REST-derived
hot row. A stale REST response reaching the old boundary leaves
`target_unconfirmed` debt and retries from the head. Only contiguous material
can be applied; unconfirmed message receipts retain a null `hot_applied_at`.

An unknown group gets one addressed detail read and stays `membership_pending`
until ordinary discovery binds it. Neither visibility nor full-sweep generation
is inferred from the WS event or detail response. A vanished target does not
block unrelated history; 401/403/429 and ownership/capture failures keep the
normal page failure policy.

## Read-only verification

Use the existing `read_only` production role in a READ ONLY transaction. Never
fall back to the application role. Scope every query to the selected page.

```sql
begin read only;
select outcome, hint_type, count(*)
from fansly_ws_hint_status where page_id = :page_id
group by outcome, hint_type;

select group_ref, requested_revision, applied_revision,
       next_due_at, last_refresh_outcome
from fansly_ws_hint_status
where page_id = :page_id and routed_revision > coalesce(applied_revision, 0)
order by received_at limit 50;

select state, http_status, count(*)
from fansly_ws_hint_attempt_status
where page_id = :page_id and admitted_at > now() - interval '24 hours'
group by state, http_status;

select percentile_cont(0.95) within group (order by signal_to_hot_seconds) as hot_p95,
       percentile_cont(0.99) within group (order by signal_to_hot_seconds) as hot_p99,
       count(*) as applied_signals
from fansly_ws_hint_status
where page_id = :page_id and hot_applied_at is not null;
commit;
```

`:page_id` is a client bind placeholder, not interpolated user SQL. Limit the
measurement to the same generation/activation window when comparing samples.
`hot_applied_at` and `rest_raw_page_ids` identify the atomic hot-write proof.
They do not prove archive projection, Read Plane visibility or end-to-reader
latency. Measure those surfaces separately. Null HTTP completion in the attempt
view means unknown/crash/telemetry loss; the reservation still consumes budget.
Budget checks fail closed on DB failure. Provider calls never originate in the
projector, canonicalizer or diagnostic views.

## Repair and erasure

Do not truncate the subject queue, routing receipts or admission ledger.
Canonicalizer replay and projector-watermark replay are idempotent; resetting
receipt custody would create new paid work. Disabled receipts are retained as
disabled and do not retroactively grant dispatch after a config change.
Use a new accepted activation window for new live traffic; polling remains the
recovery authority for older signals.

The sanctioned erasure flow removes known fan/group queues and receipts, and
all B1 stores for a page/model. A late claimed writer cannot recreate removed
state. B0's unknown-exclusive mixed raw-envelope residual remains explicit;
B1 does not certify complete fan erasure from unknown group attribution.

## Required checks before activation

Verify default-off/no-page/no-type/no-baseline refusals, replay deduplication,
R+1 during R, expiry/restart, current generation and erasure fencing, and all
physical attempt admission paths. Verify a partial hint followed by B1 off
still allows ordinary polling to recover the middle of a large gap. Check
event-only wakeups after budget exhaustion make zero ordinary calls. Compare
history/discovery progress, physical HTTP volume and each required reader
against the unchanged polling baseline; a green unit suite is not live proof.
