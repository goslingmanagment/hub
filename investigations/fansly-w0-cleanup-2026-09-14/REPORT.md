# PR198 release evidence — 14 September 2026

**PR198 is merged; the operator cleanup correction is validated. W0 has not
passed.** This packet preserves the 16 original release/validation artifacts
byte-for-byte from the cleanup worktree. Packaging performed no new tests,
provider/browser actions, production changes or proxy inspection.

## Merge and CI

The saved GitHub receipts identify base `1d0ed3cf8232c24f659d37db9ceda21d65d09dd3`,
reviewed head `1efe1cb42ba730d9cdcb4b7d74d139d87d3abb60` and merge
`b5900cfcf41a5a29d45a7c8c7c8ee0b2a76dce3e` at **20:34:22 UTC**.
[PR198](https://github.com/goslingmanagment/core/pull/198) is recorded as MERGED
in `MERGE-VERIFIED.json`; the earlier OPEN snapshots retain their original times.

All five gating jobs succeeded on that head: Static checks, Integration 1/3,
Integration 2/3, Integration 3/3 and Quality Gate. **Publish checked production
image was SKIPPED**, not successful or published. See `CI-PASSED.json` and the
retained CI watch output. The four changed source/document files at the local
head match every hash in `REVIEW.md`. The merge object was not available locally
during packaging; merge status is verified from the saved GitHub receipt, not
claimed as a fresh local comparison of the merged source tree.

## Validation and retained failure

- Final `pnpm check`: **3,821 passed, 9 skipped, 333 test files**, exit 0.
  Typecheck ratchet, lint and dashboard build passed; the ratchet retains
  **1,897 known errors in 120 files**, so this is not a zero-type-error claim.
- Serial Docker PostgreSQL context suite: **16 passed**, exit 0.
- Independent offline Python launcher review: **25 passed** (10 short,
  11 continuity, 4 binding), with no actionable source findings.
- The local Docker receipt confirms both automatic removal and explicit
  owned-container removal, with successful empty absence checks.

The initial fullcheck is preserved with exit 1: **1 failed, 3,820 passed,
9 skipped**. Its failure was the existing public-permission receipt fixture
unexpectedly being accepted. `validation/initial-run-note.md` records the
wrapper's inherited umask 077, which masks requested mode 0644 to 0600; the
final receipt explicitly records child umask 022 and success. Initial, final
and PostgreSQL receipts retain the same before/after reviewed diff SHA-256:
`0c2676368f8eb651cdda8f898cb580f07abc6170c99cc6d92421df98cb7ee070`.
The failed log/receipt was neither removed nor rewritten.

## Live scope and interpretation

This changes only the operator launcher; runtime deployment is unnecessary.
The corrected helper was subsequently used in the separate
[bounded WS attempt](../fansly-w0-continuity-2026-09-14/paired-preparation-20260914T202652Z/server-output/report.json).
That attempt ended with `transport_error`, zero received frames and zero REST
requests. Its [execution receipt](../fansly-w0-continuity-2026-09-14/paired-preparation-20260914T202652Z/server-output/execution.json)
confirms cleanup. Cleanup success does not prove WS compatibility, fan-out,
presence, continuity, gap recovery, latency, savings or W0/B0 acceptance.

Historical `PR-BODY.md` starts with a more definite causal statement than the
evidence supports. The original identity preflight's cleanup stderr was not
retained. A **later** inspect produced the lowercase diagnostic rejected by the
old helper; separate later listings confirmed absence. The final interpretation
preserves that distinction, the original `cleanupConfirmed: false`, and the
absence evidence. The later WS attempt is separate from the pre-publication
STATUS/PR text saying that no receiver had yet been started by this correction.

`SHA256SUMS` seals every packet file except itself. No provider credentials,
private correlation key or raw correspondence are included; the failure log's
account `123` and repeated-letter generation are synthetic test fixtures.
