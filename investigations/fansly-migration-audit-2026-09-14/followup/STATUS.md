# Audit follow-up, 14 September 2026

The original audit and raw evidence remain untouched. This file records the
follow-up work and does not certify completion of the migration.

| Topic | State | Evidence / remaining action |
| --- | --- | --- |
| Production performance and exact 0185/0186 history | Merged PR183 | Two independent reviews; 3,414 unit / 144 serial PostgreSQL and transport tests; CI green. Main preserves the restored layer. |
| C1 generation 776 receipt | Merged PR166 | Original 334-row receipt, exact nine-row subset and provenance committed. Final composition: 3,414 unit / 102 PostgreSQL tests. Policy/presence equivalence remains open. |
| Provider deadline erased by queued work | Merged PR184 | Both race orderings, dispatch refusal until deadline and actual DM follow-up covered; 3,420 unit / 64 PostgreSQL tests and CI green. |
| Long provider cooldown | Included in PR184 | A delay greater than 30 minutes opens the existing incident on the first failure. The provider deadline is preserved as required by D275; no premature retry. |
| Dashboard production parity | Merged PR185 (`1fe9dbe7`) | Source restored, two long lines formatted with emitted AST equality. Initial composition: 3,574 unit / 153 PostgreSQL tests; independent review clean. Final main composition passed 3,580 unit / 179 PostgreSQL tests at 4 GiB; production-source reconciliation is clean; final PR CI passed all five required jobs. |
| Recorded physical attempt remeasurement | Completed retained-data analysis | See [cost report](cost-remeasurement/REPORT.md). Six-day baseline: 30,569.33/day; September 11–12: 30,699.5/day (+0.426%). Unmatched windows and incomplete loss counters do not establish causal savings. |
| Exhausted head debt blocks history | Merged PR188 (`2e4a5b8e`) | Real message execution proves older-history progress and retained exhausted discrepancy; 3,420 unit / 41 PostgreSQL tests. Allowlist unchanged. |
| Snapshot metadata write-back | Merged PR187 (`ce0a44b0`) | Narrow guarded exclusion preserves current state; negative control reproduced original overwrite. 3,420 unit / 48 PostgreSQL tests; all five final CI gates and independent merge-composition review passed. |
| W0 WebSocket egress lint boundary | Merged PR167 (`4d432608`) | 3,588 unit tests including 72 parser cases; 37 PostgreSQL tests. The source policy and main composition are reviewed; live gate remains open. |
| OFAPI midnight CI fixture | Merged PR186 | Original 132-versus-92 negative control reproduced. 3,420 unit / 26 PostgreSQL tests; five deterministic UTC-boundary cases; review and CI green. |
| Expired C2b claim | Merged PR190 (`1a567b1c`) | Renew unchanged pre-fetch token/revision within the owned settlement transaction. Old code reproduces two missing receipts; 3,420 unit / 49 PostgreSQL tests. |
| Voice fixture settlement | Merged PR191 (`4ecbfc83`) | Main CI exposed a detached voice settlement racing the next fixture reset. Wait for committed completion using the existing suite helper; 3,580 unit / 43 PostgreSQL tests, independent review and CI passed; runtime unchanged. |
| Earnings money constructors | Merged PR189 (`4e18d130`) | Existing shared mills codec, unchanged safe-integer refusal and fingerprints; 3,423 unit / 26 PostgreSQL tests. |

A0 remains NO-GO. The original observation clock starts September 10 at
22:58:33 UTC; September 17 at that time is the earliest first seven-day report,
not automatic acceptance. September 11 contains 234 incomplete sweeps out of
275 (225 uncertified plus nine overlapping). No automatic replacement acceptance
date of September 19 is established. The hot-only head counter cannot alone
prove reader availability, and query timeout is not measured query latency.

Still uncovered: actual A0 material-query cost and reader coverage, historical physical
earnings-walk generation/completion provenance,
W0 live binding/fan-out/presence/six-hour continuity, and eventual B0/B1/A1/C2c
gates. B2 needs its own decision. Preferred transcript-source selection before
time filtering remains the explicit existing contract.

No production mutation, flag change, socket probe or deployment was performed in
this audit-follow-up turn. The final fresh read-only production snapshot retained
here is September 14 at 02:14:59 UTC: source 38032636, all three services healthy
with zero restarts. Root storage was 78% used with 18 GiB reported available;
no images, volumes or temporary files were deleted. These dated receipts live
in `production-post-merge-read/`. The 50% savings objective has not been
established, and event-to-reader latency remains unmeasured.

The bounded material-query probe stopped at its access check: `read_only` has
no SELECT grant on the three required base tables. Zero heads were sampled and
zero EXPLAIN queries ran; see `material-query-cost/REPORT.md`. No more privileged
role was used. [Rotation contract](ROTATION-CONTRACT.md) separates one scheduled
generation per slot from physical walks and documents why a rolling completion
cutoff would change freshness and continuation semantics.

A deterministic local PostgreSQL reproduction now confirms the completed-checkpoint /
unsettled-generation gap: the same leased request repeats four stubbed endpoint
calls after a failed settlement (eight retained observations). The healthy control
does not repeat. A narrow generation-bound reuse fix has passed 3,580 unit and 39 PostgreSQL
tests and is merged in PR192 (`00e13cf1`) after independent reviews and all five CI gates; this does
not attribute the September 12 production traffic to that failure.

All 12 follow-up PRs are now merged. Final main
`4e18d130ea6ca4b834141789265cce8442f8fcae` has exactly the independently reviewed
and locally tested tree `372b84f04df46c3cb607d5d5eef9c8a7c401bb62`.
The combined `pnpm check` passed 3,751 unit tests (nine existing skips); all
96 tests in 13 related Docker-Postgres suites passed without skips. The final
PR189 five-gate CI passed on its exact published head before merge. All PR
merge/check receipts are retained in `final-pr-receipts/`. Main CI run
34798541588 is pending at this closeout snapshot; its image publication is
separate from the already completed PR checks and from deployment.
