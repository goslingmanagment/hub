# Independent second review: earnings completion settlement

Reviewed 2026-09-14T01:46:08.918491+00:00 at `f29b0784ecf0b74393f462670b0a385b5808ddad`, composing topic `a56f309209677542d2eb973cdc6fbc898c9f97d4` with main `4ecbfc839fa47a5951d785f374774e4fa9942ba7`. Independent runtime, test and documentation inspection; no tests or production actions by this reviewer.

## Verdict

No outstanding actionable findings. The initial clock-expiry claim below was incorrect and is withdrawn after inspecting the actual lease writer. Runtime, test design and final composition are approved subject to the separately retained validation and fresh PR CI.

## R1 — withdrawn: fixture-clock expiry claim was incorrect

This reviewer initially claimed that the fixed logical scheduling time would make
normal test leases expire after noon on 14 September. That claim was based on
incorrectly treating `acquirePageSyncLease`'s input.now as its lease clock.
Inspection of `page-sync.ts:2095–2096` shows that the writer instead stamps
heartbeat and expiry from PostgreSQL `clock_timestamp()` plus the TTL. The
input timestamp controls scheduler/eligibility and reporting fields, not the
lease deadline. Therefore the predicted calendar failure is not established;
it was a review error, not a proven defect in the prior passing candidate.

The author changed the fixture to capture current logical scheduling time per
beforeEach and retain a relative +60-second retry. Static re-review confirms
this small change preserves each scenario, while the deliberate expiry case
still sets its deadline to year 2000. It is compatible, but must not be described
as a fix for the withdrawn expiry claim. The final test SHA-256 is
`764673a9defb2ad8b75cc844b6e06478555c83bf9dc69b2ee4c2a96eaa235bdf`.
The runtime remains unchanged. The author is retaining validation for this
final fixture separately; this reviewer runs no tests.

## Runtime and counterexamples

- The new branch reuses the already-loaded checkpoint and adds no checkpoint query, mutation, provider request or policy abstraction. It requires the input page, actual fan_earnings execution context, exact leased request sequence in `cursorSeq`, numeric cursor zero and a finite parsed completion timestamp. The existing state cast is unchanged; it does not hide a newly widened contract.
- The current earnings writer stamps owned execution sequence through the checkpoint repository. Full completion writes zero plus a timestamp; successful partial progress writes a positive fan ID, including when an old completion timestamp is retained. A first-fan rejection leaves the prior sequence untouched. Those states do not authorize skipping new work.
- The executor supplies leasedSeq, not an assumed latest requestSeq. If newer work is queued while an old lease remains active, normal completion applies only the old leased sequence and leaves the newer request pending. A newly acquired later generation cannot reuse the old checkpoint.
- The lease assertion checks token, sequence, running status and database-clock expiry before reuse. The final completePageSync write repeats that fence, so ownership loss between read/return and settlement cannot certify the stale lease. Reset atomically clears the lease/checkpoint and requests a new generation; page erasure removes both cursor and queue state. The branch creates neither object and cannot restore deleted material.
- Missing execution context follows the previous walk. Legacy checkpoint insertion has null cursorSeq and therefore cannot satisfy the equality. The generic unscoped UPDATE can preserve a pre-existing cursorSeq, so this is not a blanket provenance guarantee against hypothetical arbitrary checkpoint writers. The current production earnings checkpoint writes are confined to this handler; no redesign of the generic repository is required here.
- The fast return leaves checkpoint, provider-read timestamps, observations and endpoint receipts untouched. Ordinary scheduler succeeded_at/finished_at still record settlement time. D331 and the runbook explicitly distinguish that from a new provider check, retaining cadence and freshness gates.

## Coverage and composition

The eight real-Postgres cases meaningfully exercise a triggered settlement failure and same-generation retry, healthy same-slot control, queued newer work, partial continuation with old completedAt, first-fan rejection, missing context, lease loss and checkpoint removal. The failed-settlement case compares the entire checkpoint and exact endpoint/observation counts. The harness calls the real handler/settlement boundary with a recording transport stub; it does not boot the full executor or establish the historical production traffic cause. The retained original reproduction is clearly separate from final validation. The logical-clock follow-up preserves these cases and adds no runtime requirement.

Independent comparisons verified all three topic source/test/runbook blobs and full patches survived the main merge unchanged. Removing only D331 and its index row reproduces incoming main decisions; the D331 body is unchanged and follows D330. Existing DM history, metadata and voice fixture changes remain in main. No production savings, C2c acceptance or deployment follows from this review.

## Initially reviewed fingerprints

| File | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/sync/fan-earnings.ts` | `0cfa7c51a5934adb1b5ab01a4bb5d78fa425180cc7fc75690495988d6a37fe0d` |
| `tests/fan-earnings-completion-settlement.integration.test.ts` | `27741462f746888b94df2ba28311533b510ffe549a0b0f82fd9baf7e0c13d67f` |
| `docs/runbooks/fansly-earnings-shadow.md` | `7e41406d69ffcbd12a62cf898bc1a66ffde807e143d30e58850a7d0061901ceb` |
| `docs/decisions.md` | `db7ca1f3393dbe11270452a1a19a1f636b0c24d5caab998e805cae1b7bf56a18` |

## Final fixture follow-up

Reviewed 2026-09-14T01:47:15.532893+00:00. The only post-merge source/test delta replaces the two fixed logical timestamp constants with per-beforeEach values after fixture construction. The real lease writer and real ownership predicate are unchanged. Request sequence, same-slot controls, forced settlement failure, exact endpoint counts, checkpoint equality, rejection/expiry/removal cases remain intact. No further actionable findings.
