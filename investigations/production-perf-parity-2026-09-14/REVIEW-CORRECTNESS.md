# Independent correctness review — 14 September 2026

**No open actionable findings.** Reviewed the combined staged, unstaged and new
candidate files against `origin/main@0a08365fbefa545397f4e91a2eae3fca7c36c444`,
using production reference `380326368fe39a6a9d22eb73b0b955f8ecd7c3cc` and the
twelve source commits in `transfer-steps.json`. This is a static correctness and
test-design review of performance restoration, not approval to deploy or a claim
that the candidate contains the entire production release.

The reviewer ran no tests, production queries, provider calls or deployment
actions, and changed no implementation files. The 49 reviewed source/test/doc
files are pinned in [review-correctness-sources.json](review-correctness-sources.json),
SHA-256 `bc1e31893b8c4859a6ec8844a97f1986f39db4447272a9b2fdc3f775af3466ab`.
The snapshot was taken at 2026-09-13 23:40:35 UTC.

All imported source/test paths match the identified production bytes except
`fans.ts`, which deliberately retains main's C1 membership surface, and the
Compose tests, which retain main's newer deployment coverage. The alias-order
addition in `fans.ts` remains complete and has no dependency on omitted C1
protection counters. The two applied SQL identities match production exactly:

| Migration | SHA-256 |
| --- | --- |
| 0185_fansly_followers_membership_read.sql | bd9c2ee7987815ef6fd0f517a0783ead45954a2eb6ad7b5553c0075859940cb0 |
| 0186_ops_metrics_recent_series.sql | 8fde039eb9e8f0d211ab419f0cd7264e5186aa79d9e223c6a4a42a083d571b7e |

The migration runner and its ordering checks remain unchanged. The new unit
pins prevent accidental identity/content substitution. The integration case uses
the real runner on a database migrated through 0186, verifies unchanged ledger
rows, and advances through 0187–0191. It exercises restored-history continuity;
it does not claim to repair an arbitrary divergent database. The 0186 concurrent
index retains invalid-index recovery and its deployed rollback-compatibility
declaration. The current deployment script gains only that allowlist entry.

Critical paths checked:

- Both cleanup UPDATEs repeat `sr.outcome = 'running'` on the target, preserving
  a worker result committed while cleanup waits. The integration tests establish
  real lock contention and cover terminal outcomes, rollback and reverse order.
- HTTP admission cancellation is scoped to async chunk execution. It interrupts
  admission/retry waits, rechecks after asynchronous admission hooks, and releases
  an unused OFAPI collection reservation. It does not attach the lease signal to
  an in-flight response. Tests distinguish cancellation, response capture,
  independent page scopes and fallback pacing-chain ordering.
- Capture and positive-version replay use separate cursors and disjoint floors,
  share the original page/time allowance, retain their reserved turns, and do not
  resume a pass after its cursor wraps. Tests cover odd/even budgets, overshoot,
  restart fairness, missing/unparseable/unmapped debt and ordinary replay modes.
- The empty-head optimization probes the existing version/source/kind index in
  the same statement snapshot. Exact, continued, account/time-scoped and
  source-free calls retain their selector. The plan tests compare actual query
  results and heap work with the legacy SQL, including sparse/negative versions,
  an occupied head and fresh capture after an empty result.
- Earnings validation and drafts share one observation-local parse result;
  whole-observation refusal, diagnostics, fingerprints and stamps remain intact.
  Payload batching is limited to eight small pointer bodies for proven unmapped
  webhook waits. Mapped, ambiguous and export rows retain their own read boundary;
  large bodies and batch failures fall back to the existing reader. Tests include
  governed erasure, binding repair, body repair and duplicate references.
- Recent metrics retain all stored series and one statement snapshot, with
  bounded prefix reads. Seed counts are omitted only where existing-state or
  onboarding paths do not consume them. Their integration tests cover output
  parity and relevant query work; alias concurrency and DM-preview scope have
  focused regressions.

Main's D316 CI/Docker/deployment helpers, D318 earnings export and D320 A0 tests
remain byte-identical. C1 `executor-handlers.ts` also remains unchanged. Historical
D301–311/315 and new D321 identify the restored scope without replacing main's
decisions. The implementation adds no new flag or migration-runner exception.

The coordinator's retained `validation/check-execution.json` reports `pnpm check`
exit 0; `check.log` reports 304 unit files, 3,414 passed and nine skipped. This
review inspected that receipt but did not independently execute it. Required
serial Docker-Postgres results were not yet available at review time and remain
a publication gate. Production performance measurements quoted in historical
decisions are not new measurements of this candidate.

C1 membership writers/receipts and dashboard feature controls remain separate
production/main differences. They must be reconciled before deploying main as
a replacement for this production release. A0/C1/W0 acceptance and a production
deployment are not established by this review.
