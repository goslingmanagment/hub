# PR162 review, release and pre-A0 acceptance preparation

PR162 final head 641d7a4fba1f439062ab5ca05b35bdb86ea5ca27 is independently
reviewed with no outstanding findings. The reviewer reran two focused real
Docker-Postgres files: five tests, zero skips. Whitespace and an evidence filename
pointer were fixed. Runtime/tests remain identical to reviewed 708585d2.
The full local pnpm check, production build and 122-test Docker-Postgres run
passed before PR opening. All five final CI checks passed in run 34386000613. PR162 merged at 18:09:54 UTC
as 8b25d57e5d1343271177426ee9caf644cb1ee5c0, tree-identical to the independently
reviewed final head. The clean worktree is detached at that exact merge; its
production build passed. New deployment remains unapproved and unstarted.

The owner's full implementation goal preserves the original migration plan,
separate production approvals and calendar/measurement gates. This turn continues
that goal and does not redefine completion as the query fix. The earlier turn
made progress: one approved estimated plan, a reproduced query improvement and
PR162. This turn adds independent review/fixes and fresh read-only evidence.

## Fresh production evidence (9 September UTC)

- 17:52:30: read_only / READ ONLY head-debt report completed. Lilly-2: 2933
  captured receipts, 104 pending. Pending includes hidden/excluded/unresolved
  identities; these categories overlap and cannot be subtracted independently.
- 17:54:18: a separate exact eligibility query found lilly-2 zero eligible
  pending IDs under the current visibility, identity and exclusion predicates.
  Other eligible counts: ari-1 1, lilly-1 4, lora-1 3, lora-2 1, lora-3 1.
  No exhausted entries. Lora-1 pending was 81 in this later snapshot versus 86
  earlier; the report is live and these are different read timestamps.
- The remaining ari ID is 953208142580178944 in conversation
  952822347599994880, four unconfirmed attempts, history complete. It is not
  accepted merely because a different ari head was captured.
- 17:53:55: original reply scopes still have lilly-2 826 and lilly-1 1695 pull/v5
  observations; all bodies exist. Lora-1/2/3 are 170/43/31 at v6. Event partitions
  are attached. This census is not serving proof or full freshness acceptance.
- A full original fixed-head raw capture census hit its existing 25-second
  statement timeout; no result was returned. The separate two-hour list-cohort
  freeze also hit its bounded 15-second timeout. A plan-only EXPLAIN through
  ordinary read_only succeeded; no privileged exception was used.
- The same immutable list receipt window was split into half-hour segments.
  Part 0 completed: 318 observations, 7408 distinct scoped heads, zero unavailable
  bodies. Part 1 timed out at 15 seconds and the script stopped. No full fixed
  head-corpus result or current lilly-2 capture acceptance is claimed. Keep the
  saved segment evidence and complete the remaining narrower reads before any
  recovery activation decision. No timeout was raised or failed segment blindly
  rerun.

Zero eligible live debt is useful progress by ordinary collection, not proof that
all original frozen heads reached raw capture/archive, and not evidence from an
activated lilly-2 recovery. The original head recovery gate remains open.

## Prepared next operation

DEPLOY-APPROVAL.md specifies the reviewed query fix, normal health/rollback gates
and original lora-1/Lilly sequence. Complete the exact merge revision after CI.
No PR162 deployment is authorized or dispatched. The original full 143-ID lora-1
cohort is prepared in after-tombstone-fix/, with 140 historical positive targets
and exactly three pending targets. It has not run. The existing sequential Lilly
reply permission persists only after full lora-1 acceptance.

No new replay, head-recovery activation, socket probe, A0/T0 or A1/B2 action
occurred. No HTTP savings baseline or fresh-event latency distribution exists;
the >=50% goal remains unproven. A0/T0 cannot start until pre-A0 acceptance closes.


## Fixed cohort progress after the first bounded failures

The failed half-hour segment was split into two fresh quarter-hour windows;
the remaining source windows also used quarters. All seven non-overlapping
segments completed with zero unavailable bodies at 18:07:23 UTC. The original
head set is now frozen locally: 7427 scoped heads, including lilly-2 5615,
lilly-1 1671, lora-1 43, lora-2 21, lora-3 13, ari-1 64. Counts match the
original cohort; this is source-list evidence, not message capture acceptance.

Matching that frozen set against retained message responses in a six-hour then
a one-hour window hit the 15-second statement limit and stopped without a
result. The captured source list is retained; do not restart it. Message capture
comparison is still incomplete. A plan-only read_only diagnostic of the failed
message matcher is being inspected before any further query attempt.
