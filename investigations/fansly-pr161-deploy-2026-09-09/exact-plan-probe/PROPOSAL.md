# One exact plan-only diagnostic: approved and completed

PR161 is deployed as 34d897779fd004336e114333501f284f1faeefc1. The first exact
lora-1 transcript still timed out. PostgreSQL log pid 799 at
2026-09-09T10:32:24.550Z identifies the main list SELECT; the following count
statement was rejected because its transaction was already aborted. The archive
floor was not the failing statement in this request. No blind retry followed.

The normal role was tried once for the prepared plan-only probe. It returned:
`ERROR: permission denied for table page_dm_messages` (psql exit 3).
No EXPLAIN plan was returned, no query result or message body was read, and no
role or grants were changed. The connection closed and rolled back its read-only
transaction. The repo agreement and original task require psql as read_only;
using postgres therefore needs an explicit, narrowly scoped owner exception.

## Exact requested exception

Run this one fixed file through the existing postgres role, in a read-only
transaction, once. It contains EXPLAIN (FORMAT JSON), without ANALYZE. The
message SELECT is planned, not executed; the output is an estimated execution
plan and contains no returned message bodies. Transaction-local limits are
10 seconds for planning and 2 seconds for lock waits. The file ends in ROLLBACK;
ON_ERROR_STOP closes and rolls back the connection if a statement fails.
No permanent grants, runtime flags, global settings, schema, messages or other
business data are changed. No deploy or replay is part of this exception.

```sh
ssh root@45.8.230.111 \
  'docker exec -i agency-hub-postgres-1 psql -X -v ON_ERROR_STOP=1 -U postgres -d agency_hub_core -At' \
  < investigations/fansly-pr161-deploy-2026-09-09/exact-plan-probe/probe.sql \
  > investigations/fansly-pr161-deploy-2026-09-09/exact-plan-probe/approved-plan.json
```

File: probe.sql
SHA-256: ea6dff84b72825ced6d02abbfe5c3e690774b7e193a7f95a1552932221b32d1c
Scope: page 1 / Fansly / conversation 790634843078664193 /
[2026-09-07T00:04:57.999Z,2026-09-07T00:04:58.001Z), ASC, limit 200,
includeDeleted=true, no cursor or optional filters. These are the actual failed
request's defaults and scope. The 31 parameters are control values, not message
material. The parameterized statement was extracted from the timeout log and
matches the reviewed repository query after accounting for ASC (the earlier
local benchmark used DESC). The saved statement SHA is in preparation.json.

The exact file passed a real local Docker-Postgres 16 validation (one test,
zero skips); it produces a JSON plan and leaves the local connection outside
the read-only transaction after rollback. See local-validation.log and
local-plan.json. Copy validation.integration.test.ts into root tests/ to rerun;
its import resolves relative to that location. The first preparation deliberately
stopped on the ASC/DESC mismatch; an early fixture attempt failed because no
probe file existed. After correcting that documented difference, the final
validation passed. The original preparation did not exercise a privilege exception; the dated execution below records the later approval.

An estimated plan cannot establish actual runtime by itself. Use it to identify
whether production chose a materially different join/scan/JIT plan from the
local fixture, then reproduce that choice locally before proposing another code
change. Do not disable a health gate, increase the Agent API timeout or start
Lilly work while the original lora-1 acceptance remains open.


## Approved execution, 2026-09-09

The owner replied `continue` to the exact exception request. The fixed SHA-256
file ran once at 17:34:09.507–17:34:16.012 UTC, exit 0; command duration 6.505 s.
Output contains BEGIN, SET, SET, the JSON estimated plan and ROLLBACK; no
ANALYZE or message result was requested. dispatch.json prevents repeat dispatch.
The one-use privilege exception is exhausted. The later plan snapshot identifies
unrelated cold tombstone work before the missing OFAPI binding is checked; it
does not instrument the earlier timeout. A local mixed-platform reproduction
and query fix are in worktree hub-agent-transcript-tombstone, branch
fix/agent-transcript-tombstone-lookup. No new deployment or replay is authorized
by this diagnostic exception.
