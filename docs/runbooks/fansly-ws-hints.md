# Fansly B1 addressed REST hints

Decision 344; Decision 364 adds a bounded early canary approved by the owner;
Decision 366 makes hints the permanent mode on every Fansly page. Code and
deployment are default-off; production enables them through the audited console.

## Permanent mode (Decision 366)

Every Fansly page carries a policy without `expiresAt` and without
`attemptLimit24h`, so the five-percent rolling allowance is the only cap. The
policy stays pinned to the page's generation. When a chatter's session or the
page proxy rotates, `fansly_ws_connections.generation` changes, receipts start
reporting `disabled`, and hints stop for that page until the policy is re-pinned
to the new digest (read it from `fansly_ws_connections` under `read_only`, edit
the policy, verify all-role convergence). Nothing is lost meanwhile: the bounded
walk still discovers new messages within 30 minutes and the certified full within
its interval. The sections below record the original canary procedure.

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

Optional bounds (both required for the early canary):

- `expiresAt`: an ISO timestamp strictly after `activationAt`. At the deadline
  policy resolution and physical-attempt admission refuse new work, even if
  the enabled flag stays true. A request already admitted may finish capture
  and fenced settlement. B0 and ordinary polling continue.
- `attemptLimit24h`: a positive integer that can only lower the five-percent
  allowance. The effective cap is `min(floor(baseline/20), attemptLimit24h)`.
  Existing attempts from every policy/generation count against it; editing the
  policy, restarting or toggling a flag does not replenish the rolling budget.

Missing or malformed policy, generation mismatch, empty allowlists and unknown
types grant no HTTP. The immutable baseline grants `floor(baseline/20)` extra
attempts per rolling 24 hours. Changing a flag/generation does not reset usage.
Prepare and review the real policy before an individually authorized flip.

## Bounded early canary (Decision 364)

The owner approved reducing serial waits on 2026-09-16. The first exception is
**Lilly-1, `message_created` only, at most 60 minutes and 10 additional physical
attempts**, further limited by the measured five-percent allowance. Keep the
full polling cadence, history budget, daily earnings rotation and other feature
flags unchanged. This experiment grants no other page, type, polling reduction
or direct WS business writer. Use the existing approved session and page proxy.

Entry evidence is checked once and reused while the relevant code/configuration
is unchanged:

1. Retain the matching identity/generation receipt and accepted paired DM/Away
   presence evidence. Finish the already running W0 continuity/gap scenario and
   confirm its cleanup; do not start another six-hour run just to repeat it.
   A transport/auth/generation failure must be resolved before B0 activation.
   A quiet receiver gap remains unproven recovery; it does not bar this additive
   experiment while ordinary polling remains authoritative. It cannot justify
   later polling reduction or a completeness claim.
2. Enable B0 alone through its audited settings. Verify current ownership and a
   durable, decoded `message_created` from the accepted generation, with no
   unexplained capture failure or pending decode for that selected event.
   Verify the B0 kill-switch once and retain the receipt. Automated regressions
   cover duplicate/reorder, restart, DB failure and fencing; do not wait for
   natural production failures or manufacture them in production.
3. Use a complete retained per-page HTTP baseline. Prepare exact generation,
   `activationAt`, `expiresAt = activationAt + 60 minutes`,
   `attemptLimit24h: 10` and the original baseline reference. Keep B1 off while
   configuring the page, type and policy separately; verify each setting, then
   enable. No synthetic baseline, historical event re-routing or new test DM.

After the deadline, one read checks the admitted-attempt count, retained debt,
ordinary history/discovery progress and the exact selected message in both hot
storage and the Agent Read Plane. Confirm no admission at/after `expiresAt`,
then disable the B1 flag through the audited console; expiry already prevents
new work if that cleanup is delayed. Leave raw and receipts intact. Stop early
on an unexplained loss, generation/ownership failure, 401/403/429 or a regression
in ordinary progress; existing provider cooldown and failure handling remain.

If no qualifying event arrives, report an inconclusive sample and let the
policy expire. Do not extend it automatically or repeat live messages. A short
successful sample proves only this route and rollback; it does not establish
coverage, p95/p99 latency or savings. Continue the broader seven-day B0 observation
in the background. A0/A1 and polling-reduction gates are unchanged. Do not poll
unchanged experiment status repeatedly or rerun green checks without a change,
failure or specific uncovered risk.

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
