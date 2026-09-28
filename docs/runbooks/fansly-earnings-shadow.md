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
page allowlisting and request budget still apply. Zero/negative and
missing-roster dirty targets remain visible debt. The receipts also let the
daily walk cross a deterministic fan rejection instead of stalling (see
[Crossing a rejected fan](#crossing-a-rejected-fan)); a page without this flag
keeps the contiguous-prefix stop. C2c owns the separately gated selection.

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

A changed snapshot acknowledges only the claimed R, leaving R+1. An unchanged
valid response acknowledges R only when the current baseline was first seen
after every content-changing (money/type/binding) signal: the read that first
saw that fingerprint was claimed at or after the signal's revision, so its
request followed the signal. The first baseline itself confirms nothing; the
next unchanged read does. A baseline seen before the signal stays unconfirmed
until the content changes, even if that earlier read already included the
purchase. Exact status-only signals keep their own rule (targets runbook).
Empty responses never mint zero. Invalid money or another fan's payload cannot
settle a check.
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

A generation that crossed a rejected fan was committed with a quality hold;
its reuse settles held again, never as success.

A newer explicit request or ordinary next scheduled generation still walks.
Partial progress carrying an older `completedAt` still continues. Reset/erasure
removes the applicable checkpoint through the existing path. There is no new
flag or operator action; rollback restores the possibility of repeated work
without changing persisted checkpoint format. This fix does not pass C2c or
establish any production savings or historical attribution.

## Signal and baseline times (migration 0217)

Each endpoint row records `earnings_content_signal_at` (when its current
content revision was signalled), `content_baseline_at` (when the current
fingerprint was first seen) and `content_baseline_revision` (the claimed
revision of that first read). `fansly_earnings_refresh_status` returns them as
`contentSignalAt`, `contentBaselineAt` and `contentBaselineRevision`. Null means
unknown: rows from before 0217 or from an older writer stay strict.

Migration 0217 proves existing pending debt from retained evidence only: the
endpoint row was created by its first signal's transaction batch, every content
revision since is one transaction insert for that fan, and every capture of that
endpoint for that fan since then is more than an hour after the newest insert.
It writes only the three fields above; the next ordinary claim and valid
unchanged receipt performs the acknowledgement, so no request is added.

## Crossing a rejected fan

On a shadow page without isolated recovery, a fan-scoped rejection normally
stops the daily walk at its contiguous prefix, and the executor retries or
blocks the stream. The walk instead crosses the fan when all of these hold:

- the rejection is HTTP 400 or 410, or a 404 that is that endpoint's third
  rejected receipt in a row (`consecutive_rejections`, migration 0217). Any other
  receipt resets that run, including a 5xx, a timeout or an empty or invalid
  answer. Normally the three are the first attempt and the executor's two
  `provider_404` retries of the same fan. When other failures came just before
  the 404s, the executor can block the stream (`provider_404_exhausted`) before
  the third rejection, and nothing is crossed;
- there is no provider cooldown (`Retry-After`);
- the endpoint's `rejected` receipt for this attempt is durable;
- fewer than three fans were crossed in a row in this walk since a fan was last
  read successfully. The checkpoint keeps this run (`consecutiveCrossings`)
  across chunks, because a default five-request chunk holds only two or three
  fans. A fresh-skipped fan makes no request and does not reset it.

The fourth rejected fan in a row stops the walk at its contiguous prefix, so a
provider-wide burst still blocks the stream. A retry resumes the same run and
stops on the same fan until that fan reads successfully.

The crossed fan is not retried in that generation and its other endpoint is
not requested; its receipt keeps the debt. Each rejection is a
`fan_earnings_fan_rejected` warning with `crossed`, `rejectedInRow` and
`consecutiveCrossings`. The generation keeps `crossedFans` in its checkpoint,
stamps no success on partial progress, and finishes with the
`fan_earnings_unconfirmed_coverage` quality hold, keeping the last certified
`completedAt`. The next generation starts a new run and reads the fan again.

More than three genuinely rejected spenders in a row cannot be crossed:
`retry` stops on the same fan, and `reset` walks the roster again and stops at
the same place. Such a page needs isolated recovery (targets runbook,
"Isolated daily recovery").

## Rollback and next gate

On diagnostic failures, capture/latency regression or unexplained discrepancies,
disable only `fanslyFanEarningsShadowPageAllowlist` with the audited UI. Preserve
pending revisions and receipts. Daily rotation continues; disabling shadow does
not roll back C2a v2 events or earnings projections. A code rollback must retain
the compatible C2a reader and additive schema. An older runtime ignores the
0217 signal/baseline fields and the crossing checkpoint state: it returns to the
strict unchanged-response rule and the rejection stop, and its reads leave those
fields stale in the conservative direction. Its receipts also leave
`consecutive_rejections` unchanged, so after rolling forward a 404's run can
still include rejections from before the rollback.

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
