# Independent review: PostgreSQL bind logging fix

**Verdict: APPROVE the implementation. No correctness, regression, architectural, or code-quality blocker found in the reviewed diff.** Coordinator runtime verification and production acceptance remain separate gates; this review does not claim a completed deployment.

Reviewed the actual uncommitted diff in `/Users/dmitriy/code/goose/.worktrees/hub-perf-logging-20260912` against `31b73a9691f32f8c33c3fe479bca68533c7048d6`, rather than relying on the author's explanation. Scope is exactly `docker-compose.production.yml` and `tests/compose-config.test.ts`.

## Why the change is correct

- [Compose line 13](/Users/dmitriy/code/goose/.worktrees/hub-perf-logging-20260912/docker-compose.production.yml:13) passes both settings to the actual `postgres` server command. The PostgreSQL entrypoint, existing `postgres_data` mount, image, healthcheck, and 60-second shutdown grace period are preserved. Independently rendering Compose without environment resolution or interpolation produced exactly the intended five arguments; it started no containers.
- The two settings cover separate paths. `log_parameter_max_length=0` disables bind values in successful statement logs, including slow-query logs. `_on_error=0` disables the separate error bind context. Neither disables query templates, durations, or lock-wait diagnostics. Both zero values also avoid their optional parameter-copy/format overhead. These are PostgreSQL 16's documented semantics, not an inference from the static test. [PostgreSQL logging settings](https://www.postgresql.org/docs/16/runtime-config-logging.html)
- The error canon already prohibits raw SQL parameters in server logs ([line 387](/Users/dmitriy/code/goose/.worktrees/hub-perf-logging-20260912/docs/error-handling.md:387)). Applying the boundary at PostgreSQL is the appropriate layer: application logger redaction cannot intercept this separate container's stderr.
- Command-line defaults override `postgresql.conf` and `postgresql.auto.conf` without replacing those files. No Decision 293 buffer, checkpoint, WAL, parallelism, durability, or slow-query-threshold setting is restated or changed. Database, role, and session overrides can still supersede these defaults; this is not a security boundary against a privileged client deliberately changing its own settings. [PostgreSQL setting precedence](https://www.postgresql.org/docs/16/config-setting.html)
- No SQL schema, business data, capture custody, transaction boundary, worker concurrency, or external API behavior changes. SQL literals and values embedded in arbitrary PostgreSQL error text remain outside this narrow bind-logging fix; the author correctly makes no broader sanitization claim.

## Deployment and rollback

The normal release artifact includes Compose ([deploy line 361](/Users/dmitriy/code/goose/.worktrees/hub-perf-logging-20260912/scripts/deploy-production.sh:361)). The release recreates the full stack ([line 1608](/Users/dmitriy/code/goose/.worktrees/hub-perf-logging-20260912/scripts/deploy-production.sh:1608)), so the server receives the new command during the already-existing PostgreSQL restart. No additional restart mechanism or startup wrapper is needed.

Automatic rollback restores previous release files and recreates the stack ([lines 843 and 848](/Users/dmitriy/code/goose/.worktrees/hub-perf-logging-20260912/scripts/deploy-production.sh:843)). Consequently rollback to the pre-fix release removes the safeguard while the volume's slow-query setting persists. This is a known rollback consequence, not a new rollback failure. Preserve these two settings in an application-only rollback when feasible, and recheck effective settings after any rollback. Existing logs must not be deleted as part of this fix.

## Verification reviewed and still required

Independently completed here:

- Read `CLAUDE.md`, Decision 293, the server-log error boundary, Stage 25, production Compose, deployment/revert paths, and the pool construction path.
- `git diff --check` passed.
- `docker compose -f docker-compose.production.yml config --format json --no-env-resolution --no-interpolate` rendered the intended command and preserved the mounted volume, logging, healthcheck, and shutdown interval.
- Inspected the coordinator's [unit result](./logging-unit.log): 39 tests passed in one suite. The new test is a configuration boundary pin consistent with the existing suite, not proof of PostgreSQL runtime behavior.
- Inspected the coordinator's [read-only override snapshot](./logging-overrides-before.json) and its [probe implementation](./logging-overrides-probe.py): no catalog overrides for the two names; `PGOPTIONS` absent in API, worker, and scheduler. Requested that the DSN probe additionally record whether `options` is empty or contains either setting name, because its original `-c` regex alone could miss a long-option/quoted representation. No production access was performed by this reviewer.

Coordinator acceptance before deployment:

1. In disposable PostgreSQL 16, start with nonzero/full bind logging in `auto.conf`, prove a synthetic slow-bind marker and error-bind marker are logged, then reuse the volume with the exact patched server command. Both values must report zero from the command line, unrelated `auto.conf` tuning must survive, result/error behavior must match, slow/error statements must remain visible, and fresh bind markers must be absent. Recreate once more to verify persistence.
2. Run the normal integrated release checks. This reviewer ran no Vitest, Testcontainers, database process, production command, or source mutation, per coordinator serialization.
3. After deployment, use `read_only` to check effective values, the existing 2000 ms threshold, lock/durability settings, and fresh aggregate log output following actual slow statements. Mere absence of slow traffic is not proof of suppression.

## Alternatives considered

An `ALTER SYSTEM` change would reduce the need for a restart in an isolated emergency, but would add a separately managed mutation and would not place this existing application logging policy in the reviewed release. A mounted replacement configuration would enlarge the risk of losing existing tuning. A nonzero truncation length still exposes raw value prefixes. Disabling all slow-query logs would discard useful performance evidence. The two startup settings are the smallest durable release change for this topology.

## Reviewed file hashes

```text
ef6cc00af08e29d6b2ade6b39d086470680dd3e0bcd68f128c16b0f8cb777ea9  docker-compose.production.yml
ae7d71e69756403e77ca18edf5864fae22f881537d1bfbd9a4949081de01bf5e  tests/compose-config.test.ts
```

If either file changes after this review, reassess the actual delta before treating this approval as current.
