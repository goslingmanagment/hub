# Independent review — C1 retained Lora-3 follow-up

2026-09-14. Reviewer: `/root/w0_browser_discovery`, independent of packaging and
the C1 implementation. **No actionable findings.**

Reviewed the prepared candidate in `/Users/dmitriy/.codex/worktrees/hub-fansly-c1-followers`
against premerge HEAD `3a6eace148c1b9a238aaf50302f5de3e5e9f4749` and main
`0a08365fbefa545397f4e91a2eae3fca7c36c444`. `MERGE_HEAD` is that main revision;
the merge remains uncommitted. This review ran no application tests, committed
nothing and made no production calls. Only this review artifact was written.

## Merge and implementation preservation

The delta from premerge HEAD contains main's A0 regressions plus the C1 evidence
package, STATUS update and prepared PR description. The C1 executor handler,
repository, migration 0185 and membership tests/helper are byte-identical to
premerge HEAD. Main's newly integrated A0 source tests/helper and investigation
artifacts are byte-identical to main; the decisions diff against main contains
only the branch's existing C1 diagnostic refinement.

Migration `0185_fansly_followers_membership_read.sql` also exactly matches local
production source commit `380326368fe39a6a9d22eb73b0b955f8ecd7c3cc`, SHA-256
`bd9c2ee7987815ef6fd0f517a0783ead45954a2eb6ad7b5553c0075859940cb0`.
Its existing bounded diagnostic reader and access restriction remain intact.
No new policy branch, provider request, flag or cadence change was added by this
follow-up. This comparison does not establish a current production revision or
full release parity; the candidate explicitly retains that separate release task.

## Independent evidence checks

Verified every retained-file hash in PROVENANCE, the original manifest hash,
all seven original reviewed-artifact hashes, and the original review hash against
the source directory. REVIEW, SQL, execution and runtime copies are byte-exact.
The REPORT copy differs only by removal of trailing blank lines, as declared.

Decompressing the retained gzip reproduces the original 426,785 raw bytes, SHA-256
`a612e75f8b4242abe0d1427258f8254a0808ab11b1f82cc8374029441ca6c57a`.
The full receipt contains 334 unique ascending run IDs, upper bound 737812 and
`nextRunId: null`. Source identity is `read_only`, READ ONLY, repeatable read;
the exact window, asOf, SQL timeouts and successful execution receipt agree.
Historical runtime metadata is consistently labeled historical.

The nine selected objects match the full raw records exactly, including their
order and the declared run IDs. The subset preserves source-window metadata
separately and does not present itself as an exhausted nine-row query. Recomputed
Lora-3 totals are 39 records: seven successful incremental runs, two successful
reconciliation terminals and 30 partial chunks, all finished before the cutoff.

- Clean-queue requests 1524 and 1525 arise from count mismatch alone and correspond
  to the terminal runs' leased revisions.
- Generation 775 has one grace-only protected relation, zero candidates and zero
  actual deactivations; generation 776 has one candidate and one actual
  deactivation, with all protection buckets zero.
- Both generations have valid single membership receipts, exact-generation proof,
  16 chunks, consistent adjacent before/after checkpoints, 76 fetched pages and
  7,565 observed members. Generation timestamps and revisions remain consistent.
- The five subsequent incremental comparisons have equal provider/active counts,
  no requested work, and the processed counts recorded in REPORT.

These observations support closing the named natural follow-up. They do not
identify a specific relation across generations, provide an atomic active-after
count, establish that other walks are redundant, or prove presence equivalence.

## Claims and remaining gates

STATUS and PR correctly distinguish completed diagnostic implementation and
retained historical evidence from the unresolved C1 policy/presence gate. They
retain the three historical missing receipts as unknown through the dated report,
make no suppression, savings or latency claim, and do not combine overlapping
windows. The report/review are clearly dated, so their former pending-follow-up
context is not represented as a current runtime observation.

Fresh `pnpm check`, the requested serial PostgreSQL suites and final candidate
validation remain required before publication; STATUS and PR explicitly mark
them pending rather than borrowing the prior branch's pass counts. This review
approves the inspected merge/evidence slice and does not certify those tests,
a deployment, complete production parity or a C1 acceptance gate.

## Reviewed snapshot

SHA-256 of these sorted UTF-8 `sha256  path` lines with a final LF:
`5668dcf2ef8989fa71d667fe6675298c3f1b73206eb0faa70b8ad5680632b550`. Unrelated untracked historical logs are outside this review.

```text
f5cc826b7f8b63dc262ec58201fb580aa910eddc32980d18ff4fadb1520444f8  apps/runtime/src/services/sync/executor-handlers.ts
cf0faf68072105ca8fdd2dc56a13b9e82a8697df42b6fa6e2bc4f611ad53fb32  docs/decisions.md
656052148e8b1d41fb50f0894e2cc812fa00f4b84f062f1daa4a4e4fc37f1f88  investigations/fansly-a0-head-regressions-2026-09-13/PR.md
2bfcc318daeb9670e0c32bebe574af2063c4d7fad36ab661397932df869cbd56  investigations/fansly-a0-head-regressions-2026-09-13/REVIEW.md
52d4ee9a40e985d2b0dabb4c7d48c9681e5294de6cf8597487b659fc4a07f1fc  investigations/fansly-a0-head-regressions-2026-09-13/STATUS.md
5b403d52c5c20d0f487e30f4dd17b18ad1cdee5dfd34caac5968752a527320d6  investigations/fansly-a0-head-regressions-2026-09-13/evidence/validation.json
98612eb797d75154cf81ceb4e3f487f611d2bc83a3e9eaf0075c53a3348463b4  investigations/fansly-c1-followers-2026-09-10/PR.md
700f421c612a526f8b8e17460435fca5b9b363042f83142222f66a2adb60cdb5  investigations/fansly-c1-followers-2026-09-10/STATUS.md
dabc129fd4859c21ebdd8d453a9629fe64bec26732af760ddb9a7fc79f16ffcc  investigations/fansly-c1-followers-2026-09-10/evidence/lora3-followup-20260913T000235Z/PROVENANCE.json
5357706d629b2fa9b22b60d7a7de17966a44eb5d576f564be56dea3fa3bee313  investigations/fansly-c1-followers-2026-09-10/evidence/lora3-followup-20260913T000235Z/README.md
4d708b2631fdc40a8ac505f7ef802ba45d95254e5c1cc281c63b3f3c9d2c7a94  investigations/fansly-c1-followers-2026-09-10/evidence/lora3-followup-20260913T000235Z/REPORT.md
1afe59ba1a5ea6763316c927b8535cb089b790439dceb17a9be5c68ba58be174  investigations/fansly-c1-followers-2026-09-10/evidence/lora3-followup-20260913T000235Z/REVIEW.md
5f364414b9dccca0731d42d8a3be37aec3bef498cca182092ba14b4c1c6541bd  investigations/fansly-c1-followers-2026-09-10/evidence/lora3-followup-20260913T000235Z/execution.json
7731063b17a8d24378511612bbb185b0fd2c786bcf2a840e6bcff9007c71acb8  investigations/fansly-c1-followers-2026-09-10/evidence/lora3-followup-20260913T000235Z/read.raw.json.gz
3c4f04d12ddbb48a6f27d1ed09ea36fb880f5494dd8b8d9b735078902f9b98b1  investigations/fansly-c1-followers-2026-09-10/evidence/lora3-followup-20260913T000235Z/read.sql
2f5c693b1300b1d2b2c61cb3220563b8092c5899130f2acae474895a28344b1a  investigations/fansly-c1-followers-2026-09-10/evidence/lora3-followup-20260913T000235Z/runtime.json
fe457ad9c90209acdaf4f6caebd34219a0e1faad8471d9d2af2011a83d486f83  investigations/fansly-c1-followers-2026-09-10/evidence/lora3-followup-20260913T000235Z/timeline-subset.json
bd9c2ee7987815ef6fd0f517a0783ead45954a2eb6ad7b5553c0075859940cb0  packages/db/migrations/0185_fansly_followers_membership_read.sql
771877d7bf6cd15588b6eb7ab4418c9372f70160ee28c788d0e0d5b4c6874950  packages/db/src/repositories/fans.ts
08d37d0864860c5b70f00920a0f439c8262cc82025c602d1b11660d013892fb6  tests/dm-shadow-corpus.test.ts
ac3033d8b3bdd2ff3c352125c982579014f1a1c17c5b7a7e5cd0a9a98b990c81  tests/dm-shadow.test.ts
8008413d2ea78c42649c7fad2e9e28261cbcc1b2b49866580b559233afc2a4a4  tests/fansly-dm-shadow.integration.test.ts
71bfbb5b940395bd9627c2d2a9c5481a010e29f2d3a9b2e5e8253a4a74123c84  tests/followers-membership.integration.test.ts
f71a09a1d2833106c18f626b591d6703b36078ba216eae8cf1cf318178d4441c  tests/helpers/fansly-dm-sweep.ts
a9de1854744c06566222b56afbc8c31a7d0acb1606368b3f30e19fd00d31f77f  tests/helpers/followers-membership-fixture.ts
4cdd2ea0ad4c9f00a4e492731d81c5b7700c36f51cd6387264c155825f4de26a  tests/sync-handlers.test.ts
```

## Validation follow-up — 14 September 2026

After the independent review above, the same reviewed inventory was verified
unchanged and the requested validation was executed. `pnpm check` passed 3,366
unit tests (nine existing skips); eight serial Docker-Postgres suites passed
102 tests. Initial lint errors came only from two pre-existing untracked probes;
both were temporarily moved and restored byte-for-byte. No application change
was required. The exact commands, initial failure, successful logs and restoration
receipt are in `evidence/audit-followup-validation-20260914/`. STATUS and PR were
then updated to report these results while retaining the policy/presence gate.
