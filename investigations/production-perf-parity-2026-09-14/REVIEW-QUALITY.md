# Independent quality review — production performance restoration

2026-09-14. Reviewer: `/root/w0_browser_discovery`; independent of the implementation.

**No actionable findings in the reviewed candidate.** The names, boundaries and
integration scope are appropriate for restoring the deployed performance fixes.
This is approval of the reviewed code-quality/scope slice, subject to the root
agent's required `pnpm check` and Docker-Postgres validation. I did not run tests,
contact production, or edit application code.

Reviewed the combined staged, unstaged and new source/test files against main
`0a08365fbefa545397f4e91a2eae3fca7c36c444` in
`/Users/dmitriy/.codex/worktrees/hub-production-perf-parity-20260914`.
The comparison production source was local immutable commit `380326368fe39a6a9d22eb73b0b955f8ecd7c3cc`;
this review does not independently establish the current deployed revision.

## Scope and source preservation

- Reviewed 49 changed/restored source, migration, documentation and test files.
  Forty-three are byte-identical to the production source. The two new files are
  the migration-history unit and integration tests. Four deliberate differences
  from the production tree were examined individually:
  - `fans.ts` adds only the deployed alias lock ordering. C1 protection/writer
    changes remain outside this PR.
  - `deploy-production.sh` retains current main and adds only 0186 to its
    rollback-compatible migration list.
  - `compose-config.test.ts` keeps main's deployment checks and adds the
    production bind-log and index-rollback assertions.
  - `docs/decisions.md` preserves all existing main decision bodies, restores
    decisions 301–311 and 315 verbatim, and adds decision 321.
- The imported code/tests agree with the final production content of the source
  commits listed in `transfer-steps.json`. The manifest identifies each original
  change and reports clean application; content comparisons were performed
  independently rather than accepting that report alone.
- Compared every path changed from `605b931f^` through current main. Only the three
  expected docs/deploy/test files above differ; the newer earnings-audit code,
  migrations and tests, A0 regressions, CI changes and prompt-cache changes remain
  byte-identical to main. The A0 material-check edit corrects a misleading comment;
  its SQL timeout, unknown-evidence behavior and real sweep semantics are unchanged.
- Both restored migrations exactly match production source bytes and retain their
  original filenames. 0185 restores diagnostic SQL history; it does not import the
  separate C1 writers. 0186 uses the existing concurrent-index migration protocol.
  The additional index is compatible with running the previous application image.
- Decision 321 accurately limits this to deployed performance behavior and exact
  migration history. It does not claim full production parity, deploy approval,
  event savings, or A0/C1/W0 acceptance.

## Design and readability

- Lease cancellation is scoped to a chunk through one small AsyncLocalStorage
  helper, with explicit checks around asynchronous admission hooks and waits.
  The signal fences new dispatch/retries while preserving an in-flight response.
  Adapter predecessor gates still drain after cancellation; no competing request
  can bypass an earlier gate. The collection cancellation callback releases the
  unused OFAPI reservation.
- Canonicalization uses a private result with named page/EOF fields to share the
  existing allowance. Capture/replay remain disjoint; borrowed capacity resumes
  the forward cursor only after both reserved turns and never reenters an EOF
  wrap. Single-pass earnings parsing is represented by a discriminated family
  contract, with the parsed result local to one observation.
- Payload prefetch remains a page-local resolver with eight-reference groups and
  a 512 KiB per-body threshold. It retains the ordinary reader's failure semantics
  and releases each retained result after use. Eligibility is restricted to
  webhook rows unable to append under the frozen binding map; mapped/export rows
  preserve their original read-to-erasure boundary. No cross-run body cache or
  general-purpose loader framework was introduced.
- Metrics and pending-replay optimizations stay in their repositories and preserve
  the existing result contracts. Their recursive prefix probes address documented
  query-plan behavior without introducing a separate series registry or mutable
  cached negative result. Non-head/exact/account/time replay scopes keep the
  existing selector.
- Alias ordering, seed counting, preview monitor scoping and finalizer guards are
  narrow changes at their existing ownership boundaries. The reused source files
  include large existing modules, but these edits do not introduce another giant
  module or require an unrelated extraction. Production type assertions follow
  the existing database row boundary; I found no new cast hiding an incompatible
  application contract.

## Test assessment and limits

The tests exercise behavior beyond restating the implementation: PostgreSQL races
wait for an observed blocking PID before releasing the competing transaction;
HTTP cancellation uses deferred hooks/fake timers and proves physical dispatch
counts and in-flight-body preservation. Canonicalization tests cover reserved and
borrowed capacity, sparse/negative versions, poison rows, cursor wrap and repair.
Payload tests cover batch failure, repaired references, duplicate value isolation,
mapping changes, dedup/dry-run, and the governed erasure race. Query tests compare
actual results with the prior selectors and bound rows visited rather than using
fragile elapsed-time thresholds. Preview tests retain old physical debt and active
sibling behavior when unrelated monitor streams are omitted.

The new migration unit test pins the restored immutable SQL bytes. The integration
test applies the historical prefix through 0186, runs the real migrator to current
main, verifies that restored history was not reapplied, and verifies 0187–0191.
This is a meaningful migration-continuation test; it does not claim that the
production filename-only ledger contains SQL hashes. Execution results belong in
the root validation receipts and PR; no pass count is asserted by this review.

## Reviewed content fingerprint

SHA-256 of the following sorted UTF-8 `sha256  path` lines, each terminated with LF:
`02af9254353d596a5d0286c7b349ca45635c5b2d342d71bd8e5d6f6d5de02768`. Investigation artifacts, including this review and live validation
logs, are excluded. Changes to the reviewed files after this snapshot require an
appropriate review update.

```text
27b0a7eee47f25d503f23953efd9d2d401cf7f040272d54e63ffbcf0d8f83e32  apps/runtime/src/services/canonicalize-driver.ts
a1c593768edcd2f7d810b933aac349e91aefdaf4f06ae972666207b1442f0f59  apps/runtime/src/services/canonicalize/fansly-earnings.ts
e5fce8283a7c6f02eb63142fc4b56b52502f1f1ded56adfd1b67d4875afbbccd  apps/runtime/src/services/canonicalize/index.ts
b8d2467b6d26c7702b7c8a7a223e1f6efa82649044b4bda218817e22b41f4245  apps/runtime/src/services/canonicalize/types.ts
ad9433793138dfd13a8211a8d2bb4b2c09b55982f8ca3945e87ba2e6ce6131a5  apps/runtime/src/services/conversations.ts
f10f19da9abc9c91200a9179695373603d5a8692203f98e682bc15f770c6006e  apps/runtime/src/services/ofapi.ts
0410a027e11e010f15c22f3b389c976e9726b58b6c0a049d78509ba5e7aa3db3  apps/runtime/src/services/payload-reader.ts
7d1cd2847c03865aa5c02b755ec8daaf9e67c55a964998cf75af97f34e4c55a5  apps/runtime/src/services/sync/executor.ts
0b5ff0216677b272f920ea81c311ffc84019876e0db66b39a92fef0c0eddf8db  apps/runtime/src/services/sync/rate-limiter.ts
ef6cc00af08e29d6b2ade6b39d086470680dd3e0bcd68f128c16b0f8cb777ea9  docker-compose.production.yml
509a5308c6fcccea4c39a80d30dc30ab83149ff8133520d31b351d52349c5807  docs/decisions.md
4a95d2c169878da4a110ca1f1c390ac744593fd8886f7e7f4143b5d83a88a1d4  docs/error-handling.md
bd9c2ee7987815ef6fd0f517a0783ead45954a2eb6ad7b5553c0075859940cb0  packages/db/migrations/0185_fansly_followers_membership_read.sql
8fde039eb9e8f0d211ab419f0cd7264e5186aa79d9e223c6a4a42a083d571b7e  packages/db/migrations/0186_ops_metrics_recent_series.sql
9c269b250a1840a803937a95e3187d65a1d05a7e34edcb99eed6f9237695f3b6  packages/db/src/index.ts
b5b01661b6effbe9fe6cb60adb625f0f47e09f78429a88d016657191af933dbf  packages/db/src/repositories/capture-payloads.ts
66840f0208b377716f30ffc9905498b55daa18737c393fe56f53843ca59c1957  packages/db/src/repositories/domain-events.ts
c22be7efeac721503629dccc6cbee5b41ebc151c6c5c0f096ee85926b7ec27b4  packages/db/src/repositories/fans.ts
620f6ce53bdb8c221c57450a78c4b929a9e11ff9baabb9c31a1666d91d68ffe7  packages/db/src/repositories/fansly-dm-shadow.ts
788c7ca54ce4b65f29d0d42b09a47c28916bc367d92171a43ea031ee2e46fb38  packages/db/src/repositories/ops-metrics.ts
599f79ed1df6f3a281f86771e61ecb36dddf1533cc2a9532bf5a6c91f011f1d4  packages/db/src/repositories/page-sync.ts
ef8996c703bb7da1bcb92ac6f04b43d442d5217ba5f8a6d723bc7f35ecf885e1  packages/db/src/repositories/sync.ts
ba0c6ded1ba3bc17ee3ab6bd1d31ecfa1210ace0ea9e882efbc670063e72653a  packages/fansly/src/adapter.ts
0f9ad10ff57b7416cef11a805dc2e52cbd48c014551cd8bf1464414d7096089f  packages/shared/src/http-request-scope.ts
db18a89420db1d8b2e76ea3fc7214406ce11df7cfe2573e13941bfc55e29de18  packages/shared/src/http-request.ts
94731077cdf7cd7a57da9b21b2b2a716b54f628b6c11867793582155b3c1813c  packages/shared/src/index.ts
f1e90a5f148bd1c1ffac6de19ae50efbdee8e753d2ae0a37cd6275726d3e924b  scripts/benchmark-ops-metrics.mjs
92dba119fd4876c323b6f06f106aa8ae2ffec1a7abe3e65e154a28dcd817f8ff  scripts/deploy-production.sh
137fe8b42267d35abffefc5d03a3ca71b9fac9eb0f4c87e8d8ee8ff2c0530127  scripts/platform-branch-budget.json
5d100699792b083df8573188832b0e9e909b02ef4f226cc928ef3bae0a13f1a4  tests/adapter-request-cancellation.test.ts
122fcd1ba163d020307116962d925f4e4c1ab2c7bdafde77e811dbc099f636c9  tests/canonicalize-budget.test.ts
0df76f4af956d969ef3369332d18438f6dd2a030039208be71b6331919d1efea  tests/canonicalize-earnings-single-pass.test.ts
ab61ff4dc8e4328baec146d797ee999eec2a08c99119f2b79bba447da201991d  tests/canonicalize-pass-partition.integration.test.ts
ba8d07aefb51623742637731592df1b17aeee622d6ac9cb2ee3784addf82f4c2  tests/capture-payload-barrel.test.ts
2fed7a626e4561e088be2e6cff1ea79eb58cf51c5266cc134f153b1cb4c836e4  tests/capture-payload-batch.integration.test.ts
458de6ecba293ac99d33001aa539a9c2cf193acf90b93e359305032621960b6c  tests/compose-config.test.ts
b9de8710566c4db62b8416ce688c1aa863a58871929d6383fe6fdd29cfe84da8  tests/fan-alias-concurrency.integration.test.ts
be3666cdd4abe858ced35284e288bf4f0b1e1121067bb66321704b8d409982e1  tests/http-request-cancellation.test.ts
38152cb30642bf9a0e214916a00f7037938fe00f557a7fcb269316f15712093b  tests/observations-replay-head.integration.test.ts
08ec6d56f9032441e616a553e033a5cce6cf4de5da15aad63f1dba2092aaeb6f  tests/ops-metrics-recent.integration.test.ts
1464d967889b87395c79cfd812951d210b77e0768c958cd44d106661cd553502  tests/page-sync-seed-count.integration.test.ts
1c32c0634fec2f1183e73100857a807a310b71e71b9d9ecc8ec9ac89ea72b02a  tests/production-migration-history.integration.test.ts
5bccb2fc39743d0cba376fad31bc1604abdd7bd747e0e957be676fe31179c834  tests/production-migration-history.test.ts
8dcea1add5a631e114c30f3e105ef15bfdc44edffbd75a859e23193c16065196  tests/runtime-page-services.test.ts
f31912d71c5167e0a56a8f60c3c9de26d5fd7d6bc27ac282cae4ddad81bc67e9  tests/sync-executor.test.ts
09dc325b0eec45448adbb53694c6229812d200efa923da264e2a374f11bca882  tests/sync-finalization-race.integration.test.ts
4e45c3fc90e89360f18bdedd475323c1f8ef454b3bb16974dc4c369c9aec13ce  tests/sync-monitor.integration.test.ts
51f35382cdc80260743327ba64f3804abf290746146834e2eb84cc1075ac1c29  tests/sync-rate-limiter.test.ts
a381f5b0678ef28d8960ca3be0abc55e2c74aba4ccabeb11d2205dccd81f6c96  tests/sync-status.test.ts
```

## Follow-up: migration test connection ownership

Reviewed the sole source/test change after the snapshot above:
`tests/production-migration-history.integration.test.ts`. Its former `databaseUrl` call still evaluated runtime
`loadConfig()` in the migration runner, so the initial PostgreSQL run failed on
missing application environment configuration before exercising continuation.
The root validation receipts retain that failure; this review does not erase it.

The test now checks out one client from its fixture pool, calls the existing
`runMigrations({ db: client })` seam, and releases that client in `finally`,
matching the integration helper and preserving the session-scoped advisory lock.
Typed migration-ledger rows improve the assertions without changing their intent.
This is the correct narrow harness fix; no runtime, SQL or other reviewed source
file changed. No actionable follow-up finding. Root owns execution results.

Updated file SHA-256: `76f9e58082ec91649a55a25d0450747be87cbb511a8b67f51540c7698a7dca6d`.
Updated complete 49-file fingerprint, using the same inventory and algorithm as
above: `c5a58ccd4aa217fb194e7091be27d7723d16ed0400eb1da77ba0e54d902ac5d7`. All other file hashes in the original snapshot still match.
