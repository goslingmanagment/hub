# Independent PR196 final narrative review

Reviewed retained local evidence on 14 September 2026. No production calls,
network calls, tests, Git operations or observer-state writes were performed.
Only this review file was written. Initial reviewed REPORT.md SHA256:
`4e486aa42d76e4823c7b2281fd7c4d64cbb5415a92120006faf6573c853d7275`.
Final reviewed REPORT.md SHA256:
`f4013e49712b69c22e86a95d60f163dc3c2249e94a0f6ec937ad60af15e23340`.
**No outstanding findings.** Both P2 corrections below were made by the author
and independently checked against the final report and retained receipts.

## Resolved findings

1. **P2 — PostgreSQL identity exceeds the retained Docker evidence.**
   REPORT.md says “PostgreSQL's identity and 13 September start time are
   unchanged.” The before/after/follow-up samples retain the image, name,
   start time, running/health state and restart count, but no container ID.
   These observed fields are unchanged and the deploy log says PostgreSQL
   was preserved. The final report lists the observed image, start time,
   health and restart count and explicitly says no container ID was retained.

2. **P2 — Separate configuration override versions from role-reported values.**
   “All three active roles matching ... six pages/v1 ... Lilly-1/v1 ...
   none/v4” joins two different observations. The GET receipts retain matching
   role-reported values and configuration override versions 1, 1 and 4;
   they explicitly set `perRoleAppliedVersionObserved` to false. The final
   report separates the desired/reported values from override versions and
   explicitly leaves per-role applied versions and continuity unproved.

No other factual or material readability findings in this narrative.

## Independently checked evidence

- Merge receipt, exact CI head and all five successful required checks match
  the narrative. Local compressed logs contain 3,779 passed / 9 skipped unit
  tests and 84 passed PostgreSQL tests across eight serial suites. Existing
  independent source review supplies the correctness/readability assessment.
- Deployment execution exited zero; the log records final success at
  16:29:26 UTC and the wrapper finished at 16:29:31.792898. The retained runtime
  image/source, zero restarts, health samples, sync-health and dashboard
  verification, and production-pinned CLI update agree with the narrative.
- The after schema contains 190 migration rows. All 189 prior ID/timestamp
  pairs remain exact and only 0194 was added at 16:28:50.211272 UTC. Both
  diagnostic EXECUTE checks are true, reader-probe presence is true, and
  direct message-table SELECT is false. Exact live function bodies were not
  separately exported or hashed; the narrative does not claim otherwise.
- Verified all six raw cost stdout hashes against the summary, then compared
  each raw EXPLAIN planning time, execution time and shared hit/read count.
  Each sample contains 100 heads under read_only / READ ONLY / REPEATABLE READ
  with 5s statement and 100ms lock limits. The 4.818–143.473ms execution range
  and cache qualifications are accurate. No event-to-reader latency, complete
  runtime-path bound or savings measurement follows from these samples.
- Recomputed the first A0 reader cohort from raw report.json: 1,089 rows,
  833 complete / 255 incomplete / 1 running; every new field is absent in
  1,072 rows, null in one and known in 16. The 15 complete known rows cover
  all six pages and total 47,482 head checks, 38,179 materialized below-stop
  occurrences and two missing occurrences. The running row contributes its
  separate 500 checks. Generation and exclusion/flags statements match raw
  diagnostics. Lilly-2 G6916 is the sole sweep crossing the worker release
  and retains null reader fields. The snapshot's independent REVIEW.md also
  verifies the unchanged 1,009 preceding rows and non-atomic cutoff boundary.
- The narrative leaves historical recertification, A1 acceptance, continuity,
  provider loss, savings and event-to-reader latency unproved. It does not
  claim that two missing occurrences identify two distinct messages or that
  the flag-change occurrence is the missing object.

Observer-state numerical updates and the final release summary/manifest remain
outside this review and must retain their own provenance.
