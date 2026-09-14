# C2b expired claim receipt — local candidate

14 September 2026. Base `b78752d0`; branch
`fix/fansly-c2b-claim-expiry-20260914`. Decision 328 is a local coordinator
reservation, to be checked against main before publication.

Audit finding 12 is reproduced against the original capture code: the pre-fetch claim expires
in five minutes; the capture helper later passes a new checked-at timestamp to
settlement, which rejects any claim with an earlier deadline. Raw capture is
retained, but both successful and failed long calls can lose their endpoint
receipt despite unchanged claim identity and continuing page ownership.

The accepted plan and Decision 289 require the pre-fetch revision R, settlement
of at most R, separate endpoint outcomes, raw-first capture and visible lost
claims. They do not require the five-minute claim deadline to invalidate an
otherwise still-owned completed response. The claim TTL permits takeover; the
page-sync lease remains execution authority.

The candidate adds one update-only renewal helper matching page, fan/window,
token and claimed revision. The runtime renews and settles together inside its
existing owned page transaction. The settlement expiry guard remains intact.
No claim is moved after fetch or recreated; no extra HTTP request or selection
change occurs. R+1, erased state, replacement ownership, capture ordering,
checked-at provenance and the original provider failure path remain protected.

Added local PostgreSQL regressions cover:

- Injected expiry first rejects ordinary settlement; unchanged renewal then
  acknowledges only pre-fetch R and leaves a concurrent R+1 pending.
- Replaced tokens, mismatched revisions and already completed claims cannot
  renew; real fan erasure also cannot recreate its claim row.
- Expiry during an actual capture completes with one request and one receipt.
  A database trigger verifies raw capture precedes renewal.
- A late 429 retains its failure receipt, original error and Retry-After.
- A takeover during fetch preserves captured bytes and visible receipt debt.
- Losing the page lease during fetch preserves capture but blocks renewal.

Validation in `validation-20260914T005143Z` is complete:

- Negative control used exact `b78752d0` capture code with the new fixtures:
  the long success and long 429 each lost their receipt, producing exactly two
  expected failures; takeover and page-lease loss passed. No five-minute wait
  was used. The reviewed implementation was restored before final validation.
- Final `pnpm check` passed: 3,420 unit tests passed, nine skipped; lint and
  dashboard build passed. The existing strictness ratchet passed with 1,901
  known errors in 121 files within its unchanged budget. Duration: 45.84s.
- Six serial Docker-Postgres suites passed all 49 tests, zero skips, with
  missing prerequisites treated as failures. Duration: 12.39s. The suites were
  claim expiry, receipts, capture, erasure, dirty intent and page-lease fencing.
- All seven reviewed source/document hashes were unchanged after validation.
  `git diff --check` and the offline frozen install passed.

[Independent review](REVIEW.md) has no outstanding findings. Its SQL ordering
qualification correction was applied before the frozen source manifest and
all final checks. `source-manifest.json` retains the original preparation
snapshot; `VALIDATION.json` records final test state. Logs are compressed
losslessly; receipts retain their decompressed SHA-256 values.

No production measurement or action, push or PR was performed here. Delivery
is a local topic commit and draft `PR.md`; Decision 328 remains reserved for
coordinator confirmation before publication. No new flags or migrations exist.
Rollback preserves data and may restore the avoidable missing-receipt behavior.
