# Fansly C2b: semantic earnings shadow

Authority: accepted events plan §6, cross-check DECISION §5 and Decision 289.
This prepares deployment and flag operations; it does not authorize them.

## Scope and prerequisites

`fanslyFanEarningsShadowPageAllowlist` is a live, comma-separated page-label
allowlist. Its environment fallback is
`FANSLY_FAN_EARNINGS_SHADOW_PAGE_ALLOWLIST`; both default to `none`. Empty and
`none` match no page. The runtime reads it per transaction page and earnings
chunk. A running chunk can finish its already selected work after a change.

The flag records semantic transaction revisions plus receipts for the two
ordinary earnings calls per selected spender. It adds no HTTP request, changes
no cadence and does not select dirty targets. Existing earnings enablement,
page allowlisting, request budget and contiguous-prefix rejection behavior
still apply. Zero/negative and missing-roster dirty targets remain visible debt.
The baseline rotation can still stall on a deterministic fan rejection; C2c
owns the separately gated selection and per-fan continuation policy.

Migrations 0180/0181 extend operational state and add a metadata-only reader.
0179 is reserved by C1 PR166; recheck unapplied numbers and decision reservations
against main before merge. The branch includes C2a PR165: starting its worker
activates v7 earnings reparsing even with this new flag off. Use the
[C2a runbook](fansly-earnings-correctness.md) for compatible API-before-worker
deployment, full retained replay/repair scope and rollback preparation.

## Record and enable

1. Record the exact approved source/image, migration state and current effective
   flags on API, worker and scheduler. Preserve ordinary per-page earnings cadence,
   last successful complete walk and the physical-request baseline. Keep A0/A1
   and every other flag unchanged. Deployment and this flag flip are separate
   owner gates; C2a replay/repair remains separately scoped.
2. After the approved deployment, read the report below before enabling. An empty
   endpoint list means no tracked scope, never zero missed corrections. Save raw
   JSON with the page label, export time, source revision and interval boundaries
   outside short telemetry retention. Restricted report access gives no access
   to base tables, fan IDs, monetary values or observation bodies.
3. After explicit approval, set only this allowlist to one exact page label using
   the existing audited configuration UI. Record its returned value/version and
   verify effective runtime state. Do not reset pending state on enable or disable.
4. Let ordinary transaction ingestion and daily rotation run. Retain subsequent
   reports at least across complete independent daily sweeps and compare deltas
   over recorded intervals. Include activity, expired claims, missing receipts,
   never-checked targets, stale windows, attribution debt and all scope gaps.
   Use A0/T0 physical-attempt telemetry for HTTP counts; endpoint visits cannot
   substitute for attempts or measure savings.

Use the established read_only connection to `agency_hub_core`; never substitute
the application user when this function has not been deployed:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT current_user, current_setting('transaction_read_only');
SELECT public.fansly_earnings_shadow_report('approved-page-label');
ROLLBACK;
```

## Interpret the report

Each endpoint has its own tracked scope, pending revisions, valid checks,
content changes, latest outcomes and age counts. The seven-day stale bucket
is a subset of the older-than-24-hours bucket. Neither bucket includes never
checked targets; inspect that count separately. `tracked_scope_complete=false`
is intentional: pre-enable, untracked and absent-roster history is not proven.
`last_completed_daily_spender_sweep` is the full spender walk, not a full fan
inventory. It survives a partial next walk and can predate enabling shadow.

`endpoint_visits` counts calls about to be attempted, not physical attempts or
successful responses. `receipts` includes recorded failures. Their difference
retains in-flight, unclaimed and missing receipt debt even after later success.
Lost/expired claims cannot overwrite a newer receipt; capture still survives.
An elapsed five-minute claim can be renewed only while its original token and
claimed revision still match, inside the same owned page-sync transaction that
settles the receipt (Decision 328). The page lease remains execution authority;
claim expiry permits takeover but does not discard a still-owned slow response.
Renewal occurs after raw capture, preserves the pre-fetch revision and never
acquires a replacement claim. A replaced/completed/erased claim or lost page
lease keeps its missing-receipt debt. No extra HTTP request is made.

If successful receipt settlement throws after raw capture, the runtime rechecks
the page lease outside the rolled-back receipt transaction. With ownership still
valid, the captured daily walk continues and the missing receipt remains debt;
it does not repeat the provider read. Lost ownership or an unavailable database
still stops execution. This isolation does not change pre-fetch claim, provider,
parser or capture failure handling.

Any erasure, restore, flag-off interval or counter discontinuity breaks a simple
before/after denominator and must be recorded, not treated as a negative delta.

`changes_without_signal_at_claim` observes a fingerprint change without a pending
transaction revision when the daily call was claimed. A first baseline is not a
change. Pending signals spanning multiple provider corrections can hide their
individual relation, so zero here does not prove complete correction coverage.
The report is cumulative metadata; no historical per-correction latency is
available from these counters alone. Preserve captures for a scoped later
attribution analysis through an approved read surface.

A valid bound nonempty response advances `last_checked_at` and its observation
pointer. Only a change against an existing fingerprint advances `last_changed_at`.
Those times are local checks, not the provider's undisclosed correction time.
The most recent attempt has a separate observation pointer, so a failed/empty
attempt cannot masquerade as the successful check's source.

The first baseline or an unchanged response after a signal remains unconfirmed;
empty responses never mint zero. Invalid money or another fan's payload cannot
settle a check. A changed snapshot acknowledges only the claimed R, leaving R+1.
Unknown/inconsistent transaction attribution is separate debt until a semantic
update resolves it. Retry state is stored with a fifteen-minute floor and a
longer provider Retry-After; current daily rotation is the only retry mechanism.
Corrections outside transaction lookback need that independent rotation.

## Retrying a completed generation

Decision 331 prevents a completed spender walk from running again when its
later scheduler settlement failed. Reuse requires the same page, stream and
request sequence, a completed zero cursor and current lease ownership. The
`reusedCompletedWalk` statistic reports zero fans fetched; the checkpoint,
`completedAt` and last successful read timestamp stay unchanged. Stream
settlement time is not a new provider-check time.

A newer explicit request or ordinary next scheduled generation still walks.
Partial progress carrying an older `completedAt` still continues. Reset/erasure
removes the applicable checkpoint through the existing path. There is no new
flag or operator action; rollback restores the possibility of repeated work
without changing persisted checkpoint format. This fix does not pass C2c or
establish any production savings or historical attribution.

## Rollback and next gate

On diagnostic failures, capture/latency regression or unexplained discrepancies,
disable only `fanslyFanEarningsShadowPageAllowlist` with the audited UI. Preserve
pending revisions and receipts. Daily rotation continues; disabling shadow does
not roll back C2a v2 events or earnings projections. A code rollback must retain
the compatible C2a reader and additive schema.

C2c may change selection/rotation only after measured quiet-correction detection
within the existing freshness bound or a separate owner decision on max-age.
One fresh fan, no visible changes, or successful local tests do not pass that
gate. A0 still needs its own seven full days; A1 and live socket stages keep
their own approvals. No request savings or production latency is claimed here.

## Roster max age (Decision 368)

`fanslyFanEarningsRosterMaxAgeHours` (env `FANSLY_FAN_EARNINGS_ROSTER_MAX_AGE_HOURS`,
integer 0-168, live, default 0) lets the daily roster skip a spender on a SHADOW
page without any HTTP call while BOTH of its earnings planes were validly checked
inside the window, are not dirty (`requested_revision <= applied_revision`), are
not mid-claim, carry `observed` as their last receipt and are not inside a
cooldown (`retry_after_at`). A missing plane row is never fresh, so dirty,
failed, half-covered and never-checked fans are still read every day.

- `0` (default) — today's behavior: every spender is read on every walk.
- `1`-`47` — treated as `0`; the daily cadence already re-reads within 24 hours.
- `48`-`168` — the rotation is on. Owner-approved value: 48.

**Prerequisite:** the page must be in `fanslyFanEarningsShadowPageAllowlist` —
full stop, in the ordinary walk and in recovery alike. Receipts are what the skip
reads, but only a shadow page writes transactions through
`upsertFanslyTransactionWithEarningsDirty`, the sole writer that dirties an
earnings plane; on a recovery/target page without shadow the receipts would exist
while nothing could interrupt a skip. A non-shadow page is read in full
regardless of the key, and even on a shadow page the savings start on the SECOND
daily walk after the first receipts appear.

Rollback: set the key back to `0`. The next walk reads every spender again;
nothing is deleted and no state needs repair.

Latency: a quiet Fansly-side correction is seen within the window PLUS one daily
cadence (a walk landing just short of the window skips, the next is a day later),
so at 48 the practical bound is about 72 hours.

Verification — `fan_earnings` attempts per UTC day should roughly halve or better
one walk after the flip. From ordinary `read_only` psql:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT a ->> 'day' AS day,
       a ->> 'page_label' AS page,
       sum((a ->> 'attempts')::bigint) AS attempts
FROM jsonb_array_elements(
       fansly_events_measurement_report(
         '2026-09-15T00:00:00Z', '2026-09-22T00:00:00Z') -> 'attempts'
     ) AS a
WHERE a ->> 'stream' = 'fan_earnings'
GROUP BY 1, 2
ORDER BY 1, 2;
COMMIT;
```

The per-walk view is the chunk stats: `fansFresh` counts skipped spenders and
`fansFetched` the ones actually read; their sum is the roster size.
