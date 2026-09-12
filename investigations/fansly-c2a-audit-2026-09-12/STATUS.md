# C2a retained snapshot audit — 12 September 2026

The missing read-only comparison is prepared on the original C2a branch and
worktree. It is not deployed, and no production projection parity or repair is
claimed. PR165 already merged; a follow-up PR would be an exception to the
owner's one-stage/one-PR instruction and has not been opened.

## Scope

Three additive SQL readers freeze one page's retained observation cohort and
full earnings projection in one repeatable READ ONLY transaction. The local
exporter uses the existing v7 parser, checks exact source receipts and preserves
unknown data, rejected bodies, detached rows and lag. It writes private evidence
and a hash manifest. An interrupted export cannot produce a successful report.
There is no flag or change to a provider request, writer, scheduler or rotation.

The largest implementation module has 176 lines. Each migration is under 150
lines. Independent correctness and code-quality reviews are recorded in REVIEW.md.
Final validation results are recorded separately in VALIDATION.md.

## Production evidence and limits

This implementation turn made no production calls or mutations. Its starting
evidence is the retained 12 September preflight in the main checkout:
`investigations/fansly-c2a-c2b-preflight-20260912T122314Z/REPORT.md`.
At that cutoff, all 281,525 retained earnings observations were stamped v7;
the projection and actual watermark were inaccessible to read_only. C2b's
allowlist was `none` on API, worker and scheduler.

Compressed bodies are explicitly unavailable. Valid captures can therefore
remain unverified; a matched subset cannot compensate for those exclusions.
The local scale checks do not measure SSH overhead, production query latency,
provider freshness or HTTP savings. No explicit replay or rebuild ran.

## Next action

After the additional PR is permitted, publish the prepared change with its
validation and independent review results. Before deployment, assemble a release
that preserves current production ancestry and applied 0182–0185. Then run the
bounded report on production, retain every result and resolve its actual gaps.
C2b activation still requires a separate flag decision after C2a verification.
