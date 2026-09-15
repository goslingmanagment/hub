# Fansly addressed earnings targets

Decision 345. Default-off C2c selection consumes existing C2b debt within an
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
