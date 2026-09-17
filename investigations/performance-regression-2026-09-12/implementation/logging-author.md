# PostgreSQL bind-log suppression: author handoff

Status: implementation ready for independent review. No commit, push, database process, production access, or production mutation was performed by this author.

Worktree: `/Users/dmitriy/code/goose/.worktrees/hub-perf-logging-20260912`, based on production revision `31b73a9691f3`.

## Patch

Only two tracked files change:

- `docker-compose.production.yml`: run the existing `postgres:16` image as `postgres -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0`.
- `tests/compose-config.test.ts`: pin both independent bind-logging paths to zero and ensure the command does not replace the volume's other tuning.

The existing PostgreSQL entrypoint, image, volume, shutdown grace period and healthcheck are preserved. The command controls the server process, not a runtime client session. Command-line values override `postgresql.auto.conf`; all other settings from Decision 293 remain in that file, including the current 2000 ms slow-query threshold. This preserves the SQL statement template, duration, and lock-wait diagnostics while suppressing separate bind values. It does not sanitize literal text embedded in SQL or arbitrary data in PostgreSQL error messages.

The `_on_error` value is already zero in the observed production snapshot. Pinning it alongside the non-error setting makes both sides of the existing error canon durable and prevents an auto.conf override from reopening the second path. No threshold, buffer, WAL, parallelism, durability, or retention setting changes.

## Proposed decision note for the coordinator

### PostgreSQL bind values stay outside server logs

Performance diagnostics retain the existing slow-query threshold and SQL templates, but PostgreSQL must not append bound parameter values to its server logs. The production Compose command pins `log_parameter_max_length=0` and `log_parameter_max_length_on_error=0`. A positive truncation length is insufficient because it still exposes part of a raw value. These server startup settings take precedence over volume-level `postgresql.auto.conf`; the other Decision 293 tuning remains there. This is a bind-logging boundary, not sanitization of literal SQL or arbitrary PostgreSQL error text. Apply through the normal stack recreation and verify effective settings and a slow parameterized statement. Retain existing logs according to the repository's evidence/retention rules; this change does not delete historical output.

## Verification performed by the author

- Read `CLAUDE.md`, the Decision 293 production-load and fan-writer entries, the error-handling server-log boundary, and Stage 25's deployment/metrics topology.
- Inspected `scripts/deploy-production.sh`: the normal release path invokes Compose `up -d --remove-orphans --force-recreate --no-build`, so the PostgreSQL command is applied during the normal deploy. No deploy-script change is required.
- `git diff --check` passed.
- `docker compose -f docker-compose.production.yml config --format json --no-env-resolution --no-interpolate` passed without starting containers or resolving production secrets. The resolved PostgreSQL command contains exactly the five intended arguments. Existing volume, healthcheck, logging driver and 60 s shutdown grace period remain intact.
- Vitest, TypeScript, ESLint and PostgreSQL runtime validation were NOT executed; the coordinator serializes all test and database processes.

## Coordinator verification

Run from the final integrated checkout after offline dependencies are installed, with no other Vitest/Testcontainers suite active:

```sh
pnpm exec vitest run tests/compose-config.test.ts --maxWorkers=1 --no-file-parallelism
```

For a runtime counterexample, use only a disposable local PostgreSQL 16 cluster and a Node `pg` client (which sends extended-protocol binds). Do not use SQL `PREPARE`/`EXECUTE` with literal markers: that tests SQL literal logging instead of bind logging.

1. Start baseline PostgreSQL without the new command arguments. In that disposable cluster, persist `log_parameter_max_length=-1`, `log_parameter_max_length_on_error=-1`, `log_min_duration_statement=50`, and `work_mem=16MB` in `postgresql.auto.conf` using separate `ALTER SYSTEM` commands, then reload. The 50 ms threshold only shortens the local check and is not a production change.
2. Send `client.query("select $1::text as redaction_probe, pg_sleep($2::double precision)", ["LOCAL_BIND_SLOW_MARKER", 0.1])`. Confirm that the result returns the marker, the query duration is logged, and `DETAIL: parameters:` contains that marker.
3. Send `client.query("select $1::text as redaction_error_probe, 1 / (s.value - $2::integer) from generate_series(1, 1) as s(value)", ["LOCAL_BIND_ERROR_MARKER", 1])`. Confirm SQLSTATE `22012` and a bind-parameter detail containing the error marker. The generated-series denominator avoids constant-folding the error before execution.
4. Recreate only this disposable PostgreSQL container with the same volume and the exact command from the patched Compose file. Verify `pg_settings` reports both parameter limits as `0` with `source = 'command line'`, while `log_min_duration_statement=50` and `work_mem=16384` remain from the configuration file. Re-run steps 2 and 3 using fresh synthetic marker strings. Require the same returned result/error, an observed slow-statement duration and error statement, and absence of the fresh markers in this container's logs.
5. Optionally restart/recreate that same disposable container once more and recheck the effective settings; destroy only the disposable fixture and its volume afterward.

Read-only production post-deploy verification, after the coordinator's normal health gates:

```sql
SELECT name, setting, unit, source, pending_restart
FROM pg_settings
WHERE name IN (
  'log_parameter_max_length', 'log_parameter_max_length_on_error',
  'log_min_duration_statement', 'log_lock_waits',
  'fsync', 'full_page_writes', 'synchronous_commit'
)
ORDER BY name;
```

Expected: both parameter limits `0` and `source='command line'`; slow-query threshold `2000` ms; lock-wait logging unchanged; durability settings on; no pending restart for these settings. Execute SQL only as `read_only` under the established production diagnostic policy. If investigating overrides, inspect only the matching setting names in `pg_db_role_setting`, and verify working connections do not supply a per-role/session override: PostgreSQL role/database/session values can take precedence over global startup defaults.

Inspect a fresh aggregate PostgreSQL log sample after a real slow parameterized statement has occurred: duration/SQL-template records remain and new `DETAIL: parameters:` records are absent. A sample containing only fast queries does not demonstrate the boundary. Do not dump raw old bind values into the report or remove historical logs.

## Risks and rollback

The setting change takes effect on PostgreSQL recreation; this deploy already recreates the database and retains the existing 60-second shutdown grace period. No schema migration or data rewrite is introduced. Reverting to the old Compose command reopens the observed logging path while slow-query logging remains enabled, so an application-only rollback should preserve the redaction command where feasible. Generic deployment rollback restores previous release files, including Compose; explicitly inspect the effective settings after any rollback. Role/database/session overrides and SQL literals are separate from this fix and must not be described as blocked by these global defaults.

## Primary references

- [PostgreSQL 16 logging settings](https://www.postgresql.org/docs/16/runtime-config-logging.html): zero disables parameter logging; normal and error paths use separate limits.
- [PostgreSQL 16 setting precedence](https://www.postgresql.org/docs/16/config-setting.html): server `-c` values override configuration files/ALTER SYSTEM; role and session defaults can override global startup values.
