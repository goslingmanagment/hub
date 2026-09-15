# Fansly addressed earnings targets

Decisions 345 and 348. Default-off C2c selection consumes existing C2b debt within an
ordinary earnings chunk. Daily spender rotation keeps its schedule and cursor.
Activation requires accepted C2b scope/coverage and an explicit cost budget.

| Setting | Default | Meaning |
| --- | --- | --- |
| `fanslyFanEarningsTargetsEnabled` | false | Enable addressed selection |
| `fanslyFanEarningsTargetsPageAllowlist` | empty | Exact page labels |
| `fanslyFanEarningsTargetsDailyAttemptLimit` | 0 | Extra physical attempts per page in rolling 24h, 0..1000 |

The base earnings stream must also be enabled and allow the page. Set the
reviewed page and budget separately before enabling. A budget of zero, empty
allowlist or either disabled flag admits no new target HTTP. An already
admitted response may finish durable capture and its owned receipt.

## Execution and proof

One chunk takes at most one extra endpoint, leaving two request slots for a
daily fan. There is no extra wakeup: dispatch latency follows ordinary earnings
work. No new per-fan maximum age is promised. Zero/negative/not-yet-discovered
fans are eligible through their native dirty reference; they do not enter the
positive-spender daily roster implicitly.

Lifetime and monthly have independent claims/receipts. Only a changed valid
snapshot settles a signaled revision. Empty, unchanged, malformed or rejected
responses remain debt with backoff; `last_checked_at` differs from
`last_changed_at`. A transient or semantic signal is not proof of a completed
provider recalculation.

The attempt reservation is strict and conservative: a crash after admission
still costs budget, retries cannot bypass the cap, and toggling flags does not
reset usage. Per-target 400/404/410 without cooldown do not block unrelated daily
work. A daily spender's own rejection still follows the original contiguous
walk policy. Global auth/cooldown and persistence failures keep their ordinary
executor handling.

Use only production `read_only` in a READ ONLY transaction:

```sql
begin read only;
select fansly_earnings_shadow_report(:page_label);
select state, http_status, count(*)
from fan_earnings_target_attempt_status
where page_id = :page_id and admitted_at > now() - interval '24 hours'
group by state, http_status;
commit;
```

The colon parameters are client binds. The existing shadow report supplies
per-endpoint freshness/debt and the last completed independent daily spender
walk. Additional attempts must be counted separately from that baseline; null
completion in the attempt view is unknown, not a successful HTTP response.
Read Plane/canonical convergence and zero/negative/unknown-fan max-age require
separate evidence. Neither this code nor one fresh fan certifies whole-page
freshness or reduced cost.

## Rollback and remaining C2c work

Disable the target flag or empty its allowlist. Daily selection remains active;
no cursor reset, receipt deletion, credential change or data repair is needed.
Keep pending revisions and budget reservations. Fan erasure removes known
subject custody; page/model erasure also removes admission rows.

No rotation interval increase exists here. The final C2c rotation decision and
acceptance still require quiet-correction coverage, per-fan/window maximum age
and measured cost. Retain the daily baseline until those requirements are met.


## Isolated daily recovery (Decision 348)

Additional gates are `fanslyFanEarningsRecoveryEnabled=false` and
`fanslyFanEarningsRecoveryPageAllowlist` empty. They also require the addressed
selection gates and a positive attempt budget. With recovery off the preceding
Decision 345 behavior remains unchanged, including the daily rejection stop.

When enabled, daily selection uses its own durable cursor and strict receipts.
A fan-scoped 400/404/410 without cooldown leaves endpoint debt and allows the
other endpoint and remaining daily fans to run. The cursor cannot cross failed
receipt persistence. Global errors preserve auth/cooldown handling. Both valid
and rejected responses retain their own checked/changed/failure history.

A completed roster with any tracked endpoint debt, stale/missing check, current
claim or unknown attribution uses `fan_earnings_unconfirmed_coverage` quality hold.
It preserves the previous certified full timestamp. `walkCompletedAt` means the
roster was traversed; `completedAt` remains the last certified result. Current
coverage can recover after a later valid response even if cumulative audit
counters still record a historical missing receipt.

Addressed selection adds known endpoints at age >=24h (or never checked), even
without new transaction/event signals. It stays within the existing rolling cap
and one extra physical attempt per ordinary chunk. No extra scheduler wakeup is
introduced. This is an eligibility threshold, not an accepted maximum latency:
cap exhaustion, backoff and undiscovered references can leave coverage overdue.
Quiet changes increment the existing `unsignaled_changes` receipt counter.

Turning recovery off, emptying its allowlist or removing addressed admission
restores the daily legacy walk from zero at its next chunk. Keep all captured
receipts and debt. In-flight admitted responses can finish owned capture.
Neither a clean default-off deployment nor simulated tests accept production
quiet-correction coverage, a new rotation interval, or HTTP savings.


### Status-only rechecks (Decision353)

A pending1 → posted2 transaction with every other semantic field unchanged still
requests both endpoint rechecks. Pending amounts may already be included in the
provider aggregates; unchanged valid content can settle this status-only revision
after a baseline. `earnings_content_revision` keeps prior money/type/binding debt
strict, including when status R+1 arrives during a fetch for money R. Check/change
counters and timestamps remain separate. Other statuses and empty/invalid bodies
do not use this exception.

Migration0201 conservatively classifies all old debt as content-changing. For an
already-known page/fan, use `fansly_earnings_refresh_status(page_label, fan_ref)` as
`read_only` inside READ ONLY to inspect exact revisions and receipt provenance.
Do not infer the cause from a single current transaction or aggregate response.
A legacy repair requires separately retained before/after proof covering all
outstanding signals, exact CAS preconditions and independent review; change only
the debt classification and due time, preserving provider retry deadlines. Never
write applied_revision, fabricate a changed receipt or move full-sweep freshness.
A subsequent normal claim and valid REST receipt performs acknowledgement.

Rollback to the previous runtime leaves the additive schema and evidence intact.
Old writers retain the strict reason, and new code carries those revisions
forward; rollback can restore conservative holds but cannot certify unconfirmed
content. Recovery/target flags disable only their C2c consumers; C2b baseline
receipts also use status-only settlement. Reverting this settlement behavior
requires the previous runtime; there is no separate status-only feature flag.
