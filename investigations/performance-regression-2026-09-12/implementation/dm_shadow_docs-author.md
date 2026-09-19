# DM shadow timeout rationale — author handoff

Worktree: `/Users/dmitriy/code/goose/.worktrees/hub-perf-dm_shadow_docs-20260912`.
Base: `31b73a9691f32f8c33c3fe479bca68533c7048d6`.
Changed file: `packages/db/src/repositories/fansly-dm-shadow.ts`, comment at lines 57–60 only.
No runtime changes, commits, push, production access, suites or database runs.

## Incorrect claim and replacement

The old comment claimed that cancellation of the material check “forced the full
sweep each time.” Decision 293 repeats that causal attribution. It is incorrect:
the material result belongs to shadow diagnostics and never chooses an early stop
for the real provider traversal.

The replacement states that 5 s gives the diagnostic read more time under load;
a timeout leaves material evidence unknown while normal pagination continues.
The SQL scope and real sweep stop conditions stay unchanged, and the report
writer keeps its separate 500 ms statement timeout. Historical Decision 293 is
untouched; the coordinator will append a correction after independent review.

## Current code path independently traced

- `fansly-dm-shadow.ts:50–86`: the input is at most 100 conversation/message heads.
  The query is a VALUES input, `EXISTS` over exact non-deleted hot messages and a
  LEFT JOIN to head debt. It has no window function or MATERIALIZED CTE.
  The same SQL runs under `SET LOCAL statement_timeout = '5s'` in its own
  transaction. No query or timeout literal changes in this patch.
- `dm-shadow-material.ts:9–14`: a read error is caught and returns `null`, which
  means unknown diagnostic evidence.
- `fansly-dm-conversations.ts:575–582,864–880,920–924`: the result feeds
  `materialConfirmed`, capture lag and `advanceDmShadow` only.
- `dm-shadow.ts:52–126`: the candidate stop updates diagnostic counters and
  `stopPage`; the function contract explicitly keeps the caller's full sweep.
- `fansly-dm-conversations.ts:1220–1231`: unknown material prevents a certified
  complete shadow report. It does not prevent the business page from applying.
- `fansly-dm-conversations.ts:421–428,925–932,1078–1115,1368–1374`: actual traversal
  follows provider completion, chunk budgets and checkpoints. Membership
  certification and provider-total evidence govern destructive finalization.

This agrees with Decision 284: the full sweep continues past the virtual stop.
The higher timeout can produce more diagnostic evidence at the cost of waiting
longer; it does not establish provider-request savings or narrower PostgreSQL
work. The input cap does not independently prove a maximum number of physical
rows the database will examine. Pool acquisition is outside the statement timer,
so this is not a five-second wall-clock bound on the whole operation.

## Validation

- `git diff --check`: pass.
- Static comparison against HEAD after removing standalone `//` comment lines:
  all remaining content is byte-identical.
- Diff contains exactly four removed comment lines and four added comment lines.

No tests are added or run for this wording-only correction. The reviewer can
inspect the single hunk and independently retrace the control path above.

## Proposed append-only decision

Correct the DM shadow timeout rationale in Decision 293. Its statement that
500 ms cancellations forced full provider sweeps was inaccurate. The material
check supplies diagnostic evidence for the candidate early-stop report; a read
failure records unknown material and prevents certification of that report.
Under Decision 284, the real provider sweep continues beyond the virtual stop
and follows its existing pagination, chunk-budget and membership-certification
rules. The 5 s statement timeout gives the same diagnostic SQL more time to
complete under load, with a possible increase in per-page wait. It is not evidence
of fewer provider requests, narrower SQL scans or a five-second total operation
deadline. This correction changes comments and rationale only: the 5 s material
read timeout, 500 ms report-write timeout, SQL and runtime behavior are unchanged.
