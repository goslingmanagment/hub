# A0 advertised-head reader-state diagnostic

The candidate adds exact pre-apply Agent reader-state observations to A0 while
preserving its hot-table measurement, polling, business writes and candidate
stop. It does not complete the A0 gate or implement A1.

## Candidate and validation

Base: `4d9cac4acffbbf1cbb17b74cac0b4d76f01ce65d` (includes PR194).
Tested commit: `5f247b4312ea60ab2b81625a4ca49bd8046fb3cf`.
Decision 335 and additive migration 0194 belong to this topic. Applied 0192 retains
SHA256 `4c6a00a4d533562e6520de855454a68459d8ac80c50b376247b5a16a707cab1d`.
`evidence/composition-main-4d9.json` pins every changed source/test/doc file and
verifies exact prior-topic preservation apart from the incoming main decision
text and DB export additions.

- `pnpm check`: exit 0, 3762 unit tests passed, 9 existing skips, 327 files;
  typecheck ratchet, lint and dashboard build passed. The ratchet retains 1897
  existing errors in 120 debt files; this is not a claim of a debt-free tree.
  Completed 2026-09-14T15:52:11.147588Z in 48.618 s.
- Eight serial Docker-Postgres suites: exit 0, 84/84 passed, no skipped cases.
  `ALLOW_MISSING_TEST_PREREQUISITES=0`; one Vitest process, file parallelism off.
  Completed 2026-09-14T15:52:49.065059Z in 20.521 s.
- Independent source/docs review passed; `REVIEW.md` pins the unchanged tested
  implementation, exact main composition and final raw/compressed receipts.

Exact commands, environment, UTC timings, exit codes and raw/compressed hashes
are retained in `evidence/check-final.json` and `evidence/postgres-final.json`.
Compressed logs decompress to the recorded raw hashes without byte trimming.
Initial unsuccessful runs remain in `evidence/initial-results.json`: the scalar
cursor pin led to flat nullable counters; unsupported cold-event fixtures were
corrected; the new handler cases now verify actual thread-metadata writes instead
of wrongly expecting hot-body insertion. An earlier loop-variable typo was
caught by typecheck before these retained full-run logs.

## What the tests establish

The 13 new reader cases compare actual Agent transcript states with the classifier
for source precedence, pending/deleted dominance, archive-only heads, foreign
page/group rows, current cross-tombstone binding, missing candidates, duplicate
inputs and invalid page/batch limits. Historical capture debt does not override
current state. One real PostgreSQL snapshot test confirms READ ONLY, REPEATABLE
READ, a 500 ms remaining second-query allowance after 4500 ms elapsed, and stable
results despite a concurrent archive change. Another refuses the second read
when the shared allowance is exhausted; it does not pretend pool checkout can
be cancelled.

The 20 real-shadow cases include four new advertised-state variants before the
normal thread-head update. Flag-off executes no diagnostic reads; flag-on/off
HTTP, raw captures, business cursors, membership and queue state remain equal.
Existing interruption, loss, restart and legacy-unknown cases remain covered.
Pure tests preserve the scalar-only cursor and independent historical nulls.

The shared probe suite exercises 17 cases for each fixed function: EXECUTE-only
access, closed PUBLIC/table permissions, input caps and scope, literal quoting,
read-only/RR enforcement, caller deadlines, snapshot stability and real lock
cancellation. Parser tests pin each migration's EXPLAIN SQL to its runtime query.
Agent window/tombstone and migration/sweep suites cover their adjacent contracts.

## Remaining measurement and gate limits

No production query, deployment, provider request or flag change was performed
for this candidate. The new 0194 query has no production cost sample yet. The
already deployed 0192 sample belongs exclusively to its unchanged hot query.
After normal deployment, the runbook provides a once-only bounded read_only
measurement for the new query. Current stored-head EXPLAIN cannot recreate the
original provider-list population and excludes pool/network waits, report writes
and publication latency.

New counters describe advertised IDs only. They do not establish full transcript
or text/media/link parity, diagnose provider-side deletion, or prove pruning.
Old/resumed missing counters remain unknown; no retrospective reader credit or
A0 clock reset is permitted. The original seven-day, activity/churn/outage and
unexplained-discrepancy gates, realized >=50% savings and event-to-reader latency
remain separate and unproven by this change. No freshness or cadence change,
new stop policy, B2 work or new flag is introduced.
