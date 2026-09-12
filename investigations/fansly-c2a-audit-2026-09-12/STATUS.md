# C2a retained snapshot audit — 12 September 2026

The missing read-only comparison is prepared on the original C2a branch and
worktree. It is not deployed, and no production projection parity or repair is
claimed. PR165 already merged. On 12 September the owner approved the additional
PR and deployments ("да все разрешаю"); the original stage branch and worktree
are retained.

Main synchronization on 12 September integrates `c76c6db0`. The unpublished
audit now reserves Decision 312 and migrations 0187–0189, avoiding occupied
release-branch numbers. All three SQL bodies and twelve TypeScript source/test
files are unchanged. Combined checks pass: 3262 unit tests, nine existing skips,
and 44 serial Docker-Postgres tests with no skips. Current evidence is
recorded in [MAIN-SYNC-20260912.md](MAIN-SYNC-20260912.md).

## Scope

Three additive SQL readers freeze one page's retained observation cohort and
full earnings projection in one repeatable READ ONLY transaction. The local
exporter uses the existing v7 parser, checks exact source receipts and preserves
unknown data, rejected bodies, detached rows and lag. It writes private evidence
and a hash manifest. An interrupted export cannot produce a successful report.
There is no flag or change to a provider request, writer, scheduler or rotation.

The largest implementation module has 176 lines. Each migration is under 150
lines. Independent correctness and code-quality reviews are recorded in REVIEW.md.
The original validation is retained in VALIDATION.md; the main-sync record
contains the current combined-tree checks.

## Production evidence and limits

The original implementation turn made no production calls or mutations. Its
starting evidence is the retained 12 September preflight in the main checkout:
`investigations/fansly-c2a-c2b-preflight-20260912T122314Z/REPORT.md`.
At that cutoff, all 281,525 retained earnings observations were stamped v7;
the projection and actual watermark were inaccessible to read_only. C2b's
allowlist was `none` on API, worker and scheduler.

Compressed bodies are explicitly unavailable. Valid captures can therefore
remain unverified; a matched subset cannot compensate for those exclusions.
The local scale checks do not measure SSH overhead, production query latency,
provider freshness or HTTP savings. No explicit replay or rebuild ran.

Read-only catalog checks at 19:30–19:32 UTC confirm that the three audit readers
are absent and none of its migrations is applied. All three runtime roles remain
healthy on `31b73a96`, with zero restarts. These reads do not inspect projection
parity or run the audit. No production state changed.

## Next action

Publish the prepared change with its validation and independent review results.
Before deployment, assemble a release that preserves current production ancestry
and every applied migration. Then run the
bounded report on production, retain every result and resolve its actual gaps.
At 20:45:46 UTC a read_only READ ONLY query confirmed 182 applied migrations,
including 0186. Current production is 96a86c1fcdde; its code and migration bytes
must be retained in the audit release. The earlier predecessor-order gate is
resolved. C2b activation still depends on C2a verification and its staged checks.
