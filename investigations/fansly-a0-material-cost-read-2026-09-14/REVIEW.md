# Independent review — A0 material-query cost read

Reviewer: `/root/w0_role_tests`. Base:
`4e18d130ea6ca4b834141789265cce8442f8fcae`.
Scope: all six staged files and the unchanged runtime material query.
The working files matched the staged bytes below at review time.

**Verdict: no actionable source findings.** This review did not run tests, call
production or modify source. `git diff --cached --check` passed. The author
subsequently supplied passing full-check and serial Docker-Postgres receipts;
the log hashes and summaries were independently verified below.

## Boundary and correctness

The definer accepts a page label and a 1–100 sample limit. It resolves a Fansly
page itself and selects only visible, nonempty stored heads from that page.
The secondary conversation-ID ordering makes equal timestamps deterministic.
Empty selection remains explicitly unmeasured, with a null plan.

All base relations are qualified with `public`; the function fixes its search
path to `pg_catalog, pg_temp`. The dynamic SQL has a fixed SELECT shape, and
internally selected IDs enter only through quoted `%L` literals with bigint/text
casts. Caller text is not SQL. PUBLIC execution is revoked and the existing
`read_only` role receives only EXECUTE; no base-table grants are added. The
migration follows the existing conditional-role pattern, so a role created only
after migration would need normal read-plane provisioning.

The material statement matches `readFanslyDmShadowMaterial`: typed VALUES,
non-deleted exact-ID hot-message EXISTS, exact-ID debt join and the same lag
expression. The AST test pins that statement independently of whitespace and
schema qualification. Reading current stored heads changes the sample boundary,
not the material predicate. The plan exposes identifiers and planner metadata,
not selected message bodies, usernames or credentials.

The transaction must already be READ ONLY and REPEATABLE READ. The function
checks configured statement and lock limits before relation reads. The documented
separate SET commands establish deadlines before the SELECT; the lock-contention
test exercises a real caller-established statement cancellation. These checks
are not a standalone resource quota against a caller that changes settings
inside an already-running SQL statement. The runbook correctly requires the
SET-before-SELECT protocol and separate process/overall limits. This review does
not claim an adversarial caller-proof wall-clock bound.

## Tests, operating claims and rollback

The new PG cases meaningfully cover scoped deterministic sampling, empty and
invalid input, restricted table access and PUBLIC ACL, unsafe transactions and
timeouts, SQL-looking stored IDs, repeatable-read visibility during a concurrent
write, and cancellation while the sample relation is locked. The state comparison
covers debt rows; the READ ONLY transaction protects the other persistent tables.
The isolated test role exercises definer access without depending on broad local
read-only-role grants. The actual conditional grant is reviewed in the migration;
this suite does not independently prove an existing production login's ACL.

The code remains small and direct: one SQL function, a focused integration suite,
and a short query-fidelity test. There is no runtime hook, provider call, flag,
new index or broad table privilege. Adding this inert function to the existing
application-rollback allowlist is consistent with its additive schema effect;
rollback can leave it unused.

Decision 332 and the runbook correctly exclude current-head sampling/cache effects
and non-query waits from a latency guarantee. The plan neither returns predicate
results nor proves archive/reader completeness, event-to-reader percentiles,
A0 acceptance or 50% savings. Existing clocks and stage gates remain unchanged.
No production cost measurement or deployment of this migration is claimed here.

## Reviewed SHA-256

- `docs/decisions.md`
  `9c864875d619496eb938827a3c8c8ee05404baeabb827e9028551cb99e66c7fb`
- `docs/runbooks/fansly-events-shadow.md`
  `2476240a099a8ec51259a6013ee922734ebc6ddd52077d85dbd0053979af074b`
- `packages/db/migrations/0192_fansly_dm_shadow_material_probe.sql`
  `4c6a00a4d533562e6520de855454a68459d8ac80c50b376247b5a16a707cab1d`
- `scripts/deploy-production.sh`
  `32fc18684293827955ac31e8132436f0db37f5ced2da7cc763f85751ae882729`
- `tests/fansly-dm-material-probe.integration.test.ts`
  `52faf44297e409ab3c667312a1e457e6ed127241d8e76166d600731aa51f68e2`
- `tests/fansly-dm-material-query.test.ts`
  `d5497b366c0bbcc3cee961b7f57062eab90e8a659701dceb80833f147bfbe5c6`
- `packages/db/src/repositories/fansly-dm-shadow.ts`
  `620f6ce53bdb8c221c57450a78c4b929a9e11ff9baabb9c31a1666d91d68ffe7`

## Validation receipts inspected after source review

The author's source remained unchanged. `evidence/check-initial.json` reports
`pnpm check`, exit 0, 15:04:29–15:05:36 UTC. Its log records 3,753 passing tests,
9 existing skips and 325 passing files, followed by a successful build.
`evidence/postgres-initial.json` records one Vitest process with
`--no-file-parallelism`, exit 0, 15:05:54–15:06:10 UTC: 45 tests across five
Docker-Postgres suites, including 17 new material-probe cases. The other suites
cover DM shadow, events measurement, production migration history and the
migration runner. Both runs required test prerequisites.

Verified original log SHA-256:

- `check-initial.log`
  `1b004f50333e098581c186dd52a50efefafa47e040e68f3fc4547f530bba650d`
- `postgres-initial.log`
  `0c38120d80c2f563ef2093e75edbc49304566df7965f9ee932c881f30994091a`

No duplicate test run was performed by this reviewer.
