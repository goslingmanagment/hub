# fix(fansly): retain C2b receipts after claim expiry

A Fansly earnings call that outlived its five-minute C2b claim retained its raw
response but lost the check or failure receipt, even while the page worker
still owned its lease. Renew the unchanged pre-fetch claim token and revision
inside the same owned transaction that settles the result. Keep the existing
expiry guard, raw-first capture and original provider error/Retry-After.

Renewal cannot replace another claimant, acknowledge a newer revision, recreate
erased state or survive page-lease loss. Daily target selection and HTTP requests
are unchanged. Decision 328 and the existing C2b runbook document the ownership
boundary; there are no new flags or migrations.

Validation:

- `pnpm check`: PASS, 3,420 unit tests passed / nine skipped; lint, strictness
  ratchet and dashboard build passed (45.84s).
- Serial Docker-Postgres: PASS, 49 tests in six suites / zero skipped, with
  `ALLOW_MISSING_TEST_PREREQUISITES=0` (12.39s). Covers raw-before-renewal,
  R/R+1, claim takeover/completion, real erasure, late 429 and page-lease loss.
- Deterministic negative control using the exact previous capture implementation
  reproduced both missing receipts; the reviewed fix passes those cases.
- Independent review has no outstanding findings. Compressed logs, exact
  commands, receipts and source hashes are retained alongside this draft.

The current branch also integrates main `a9794e60` and its verified UTC fixture.
The local check/Postgres receipts above were run on `a083dc6f`; every other
executable/test file remains byte-identical. Independent composition review
preserves D324 and the topic decision. No redundant local suite was repeated;
fresh PR CI validates the complete merge before merging.
