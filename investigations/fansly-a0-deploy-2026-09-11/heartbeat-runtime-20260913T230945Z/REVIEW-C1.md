# Independent C1 observation review — 13 September 2026, 23:20 UTC

**Passed; no open actionable findings.** Reviewed the retained C1
`followup-20260913T231017Z` report, summary and current STATE, plus the C1
paragraph and disposition in this shared REPORT. This review used local files
only; it performed no production query, provider request or mutation.

Independently recomputed all six report and manifest hashes, raw-receipt parity,
`read_only` / read-only transaction receipts, cursor transitions and frozen
window bounds. The reviewed reader's hash and explicit repeatable-read SQL match
the report. Each page is consistent; the drained timeline is not globally atomic.
The upper run bound is 745172; the last selected diagnostic run is 745115.

The raw pages contain 2,604 ordered unique runs, with all 2,493 prior rows
unchanged and 111 new rows. No selected run is unfinished or finishes after the
cutoff. Recomputed 421 valid decisions: 316 no-request, 99 mismatch-only and six
mismatch-plus-exhausted. Exported OR/count predicates and clean-queue increment
arithmetic agree. All 105 requests have exactly one later terminal for the same
page and requested revision, with matching generation/count proof. Hidden
checkpoint identity remains outside this export.

Recomputed 113 successful terminals, 66 valid terminal membership receipts and
47 historical missing receipts; one older nonterminal receipt brings valid
membership receipts to 67. The six new valid terminals contain four deactivation
and two grace-only occurrences. The report correctly avoids relation identity,
atomic active-after-update or presence-equivalence claims. The 59 partial and
one failed incremental runs without final decisions remain unknown, not negative
decisions. No new missing terminal receipt appears.

Only the first-page follower aggregates contribute to cost: 11,441 attempts,
32 retry ordinals, 687 unknown-byte attempts and zero failed/429 attempts.
Follower coverage has 2,604 runs and zero recorded unknown/boundary/unrecorded/
unfinished counters. Repeated page aggregates and cumulative populations are
not added. This does not establish attributable savings or event-to-reader latency.

The current C1 STATE figures and shared C1 paragraph agree with the retained
receipts. The shared unchanged-stage/quiet disposition makes no suppression,
presence-equivalence or acceptance claim. Runtime and other stages are reviewed
separately. Final review-pointer/completion updates are the coordinator's work.

[Verification receipt](review-c1-verification.json) pins the reviewed summary,
stage report, shared report and state hashes, with all six raw report hashes.
