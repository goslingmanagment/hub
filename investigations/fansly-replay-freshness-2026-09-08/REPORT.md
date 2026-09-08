# Fresh capture during sync-pull v6 replay

The approved reply repair exposed a pre-A0 freshness blocker: new captured
facts share an ascending observation-ID traversal with old facts made eligible
by the v6 version bump. New raw capture succeeds, but canonicalization waits
for the historical replay to reach it. The fix passed local checks and independent review; deployment requires
a separate owner approval for the final reviewed revision.

## Production evidence

At 2026-09-08 13:48:35 UTC, production had 1,422 never-parsed sync-pull
observations behind 295,738 observations at version 5:

| Kind | Version 0 | Version 5 |
|---|---:|---:|
| dm_messages | 507 | 49,169 |
| earnings_transactions | 23 | 15,562 |
| fan_earnings_monthly | 446 | 109,646 |
| fan_earnings_stats | 446 | 109,649 |
| purchase_history | 0 | 11,712 |

The oldest unparsed DM receipt was 12:08:40.856 UTC, while the historical
cursor was still processing July. The original ari canary target already had
an exact raw/hot receipt but remained at parse version 0 and was served from
`page_dm_messages`, not the archive. This corroborates the code path; it is not
an inference from total backlog alone. `dm_conversations` is a raw-only kind
and its zero parse stamps are not counted as this canonicalization failure.

Evidence is content-free: [version split](evidence/parse-lanes.txt),
[reproducible read-only SQL](evidence/parse-lanes.sql),
[new captures](evidence/fresh-capture-1348.txt) and
[replay progress](evidence/replay-1345.txt). Production SQL used `read_only`
inside `BEGIN READ ONLY`, with a 20-second statement timeout. No production
mutation or provider probe was performed for this follow-up.

At 14:06:36 UTC, all three runtime roles still reported revision
`b47f552abb97`, healthy with zero restarts. Loopback health was OK (database
check: 1 ms), with 31 GiB free on the host. This is a deployment preflight,
not evidence that fresh materialization has recovered; see
[runtime snapshot](evidence/runtime-preflight.txt).

## Correction

Only `pull:sync` opts into a new-capture pass in the existing sweep. Its
version-zero selection has an independent durable cursor and still applies
and stamps the current parser. The original versioned replay cursor retains
its key and position. The first pass receives at most half the remaining time
and family page allowance; the second receives the unused allowance. There is
no additional queue, migration, runtime flag, provider request or increase to
the existing 20-page family limit and 600-second run budget.

A namespaced turn cursor is saved through CAS before work: `1` means replay
is owed, `null` means new capture starts. Thus a single slow page, budget
overshoot or process restart gives the opposite pass first turn next time.
When both passes get their turn, the next run starts with capture again.
Unmapped/unparseable facts remain unstamped and their scan cursor advances
and wraps normally. Existing event dedup, reply clocks, projection writes,
explicit CLI/dry-run ordering and other families are unchanged.

The initial regression test failed on the deployed implementation: the sweep
processed two old facts and left the new one pending. Independent review then
found a page-overshoot edge in the first patch that could still starve replay.
That finding was fixed with the durable turn marker; unit and real-Postgres
tests verify capture → restart → replay → restart → capture under repeated
overshoot, as well as an unmapped head and independent history progress.

## Validation

- Original regression reproduced before the fix: [test output](evidence/regression-before.log).
- Focused control-flow suite: 17 tests passed.
- Docker PostgreSQL: **50 tests in eight suites passed, zero skips** (45 in
  sweep/dedup/partition/reply/archive/media suites, then five in fan earnings
  and harvest glue). These include the real cursor store and downstream
  sync-pull consumers.
- `pnpm check` passed: 280 unit files, 3,110 tests passed, nine existing skips;
  lint and dashboard build passed. The strictness ratchet passed with 1,908
  existing errors in 121 files; this is not a zero-error TypeScript run.
- `pnpm build:production` passed: [build output](evidence/production-build.log).

Tests prove bounded scheduling, durable continuation and existing material
semantics in controlled cases. They do not establish production freshness,
HTTP savings or complete reply-corpus recovery.

## Deployment and acceptance

Deploy only after independent review, green checks and the owner's explicit
yes for the exact reviewed revision. Keep the head catch-up allowlist `none`.
Record process revision, health, disk, version-zero count/oldest receipt,
historical progress and projection durations across successive sweeps. Verify
the exact recovered head through Agent transcript and complete the reply
source-to-serving comparison; raw or parse stamps alone are not acceptance.

Rollback requires its own owner approval. Reverting this code restores old
ordering but retains raw, v6 facts/stamps and cursor records. No reset,
destructive rebuild, manual replay or lilly-2 activation is included. Slow
projection work may remain even after new facts can canonicalize; its latency
must be measured independently.

A0/T0 remains unstarted until all three original diagnostic prerequisites
have production acceptance. Savings and event latency remain unmeasured.
