# Earnings completion/settlement gap reproduced

**Confirmed on main `1fe9dbe74daa8a4fbfd452ac352f7f290a60b1e4`: one
scheduled request generation can perform the full spender walk twice if its
checkpoint completes but the subsequent generation settlement fails.** This
establishes a local failure case, not the cause of Lilly-2 traffic on 12 September.

The isolated PostgreSQL test uses the real scheduler, lease acquisition,
`executeFanEarningsChunk`, checkpoint/journal repositories, `completePageSync`
and `retryPageSync`. The fixture pauses unrelated streams and seeds two spenders.
The adapter is a response stub; it records endpoint invocations and makes no
network requests. The harness invokes the handler/settlement boundary directly;
it does not boot the full worker or claim to exercise its error-classification
and notification paths.

| Case | Retained result |
| --- | --- |
| Healthy settlement | One scheduled generation, four endpoint invocations, completed checkpoint, settled sequence; another same-slot scheduler tick leaves it idle. |
| Settlement failure | First walk completes and commits cursor zero plus completedAt. A test-only PostgreSQL trigger rejects the subsequent applied-sequence update. The checkpoint survives. Real retry/reacquisition uses the same requestSeq, leasedSeq and lastScheduledSlot; both fans' lifetime/monthly endpoints run again. Eight observations are retained, four for each endpoint kind. |

The trigger is installed only after the checkpoint commits and removed in
`finally`; no runtime hook or runtime source change is needed. A prior scheduler
admission is not lost or duplicated. The defect is the missing association
between completed walk material and its still-unsettled execution generation.

Validation: **2/2 Docker-Postgres cases passed, no skips**, command wall time
4.543 seconds, completed 2026-09-14T01:23:47.588329Z. Mandatory Docker was enforced
with `ALLOW_MISSING_TEST_PREREQUISITES=0`, one Vitest process and
`--no-file-parallelism`. The initial run passed the healthy control but stopped
at a test assertion: the driver wraps the trigger error in `cause`. The final
test matches the precise PostgreSQL message and P0001 code, then completes the
reproduction. Both attempts and exact source hashes remain under `evidence/`;
raw logs are preserved and compressed copies are byte-hashed. No full `pnpm
check` is claimed for this diagnostic-only step.

The result does not establish production occurrence, outage frequency, per-fan
freshness or savings. It provides a focused fix target without changing the
daily cadence: retain completion identity for the owning generation so its
settlement retry can finish without restarting an already completed walk.
Explicit newer generations and unfinished continuations must still execute;
lease ownership and erasure/reseed behavior need to remain guarded. Detailed
implementation review follows separately. No cadence cap, flag, production
query or provider call was added.
