# Scope Agent transcript tombstones before reading cold history

A Fansly transcript request should not scan an unrelated platform's retained
archive before discovering that the page has no OFAPI binding. Resolve the
current binding once and look up chatless tombstones by the existing
platform/account/message key. This separate pre-A0 query fix changes one reader;
Decision 282 and the reply-acceptance runbook are included. No flag or migration.

## Production evidence and limits

PR161 was independently reviewed, merged as 34d897779fd004336e114333501f284f1faeefc1,
and deployed with owner approval on 9 September. Its first exact lora-1 retry
still returned 503 in 14.545 seconds, 10:32:10.139–10:32:24.685 UTC, conversation
790634843078664193 / message 953135194070597632 / a 2 ms window. PostgreSQL error
logs identify the main list SELECT containing window_refs. The next count
statement failed because its transaction was aborted; archive-floor failure was
not observed for this request. No blind retry followed.

The normal read_only role denied even plan-only EXPLAIN on page_dm_messages.
The owner then replied continue to the concrete one-file exception request.
One EXPLAIN (FORMAT JSON), without ANALYZE, was executed through postgres in a
READ ONLY transaction with 10-second statement/2-second lock limits. It exited
0 at 17:34:16 UTC; the SSH command took 6.505 seconds (not SQL execution time).
No message SELECT was executed and no returned message bodies were read. No
role/grant/global-setting/flag/data mutation or additional privileged read was
performed. The one-use exception is exhausted. Exact SQL/hash/dispatch evidence
is retained here; the original approval and read_only denial are in the operator
workspace under investigations/fansly-pr161-deploy-2026-09-09/exact-plan-probe/.

That later estimated plan puts a message-ID-only scan of the cold archive before
checking the page binding: dm_message_archive_platform_account_message_uniq is
indexed by (platform, ofapi_account_id, platform_message_id), but the scan's
Index Cond contains only the last column. The pages binding check appears later.
The tombstone subplan costs 8018.34 of an overall 8239.04 estimated cost; units
are planner estimates, not milliseconds. No JIT section is present. The plan
was collected seven hours after the failed request with literal control values;
it is not that request's actual execution trace or a complete incident RCA.

## Local reproduction

The original small PR161 benchmark had an empty OFAPI archive. This fixture
adds 300000 unrelated OFAPI rows (30000 tombstones) to the same 10298 archive +
10298 hot Fansly history, with 2048-byte text fields and actual ASC ordering.
It uses real Postgres 16 and current production migrations, without changing
planner settings. The synthetic local planner chooses a sequential cold scan;
the production snapshot chose an index scan without leading key columns. Both
perform unrelated cold-history work before the absent binding is rejected.

| Measurement | Main 34d89777 | This change |
|---|---:|---:|
| Unrelated cold rows visited by tombstone branch | 300000 | 0 |
| Cold tombstones returned before binding rejection | 30000 | 0 |
| Repository list call, ms | 37.392 | 5.156 |
| Count call, ms | 2.684 | 2.708 |
| EXPLAIN ANALYZE, ms | 29.017 | 0.550 |
| Wide-window list, first 200 rows, ms | 103.712 | 52.823 |

Normalized narrow rows, message material, witnesses and count match exactly.
The same wide window returns identical first 200 rows. These are single local
samples, not production predictions, timing thresholds or latency percentiles.
The count call already prunes unused material in this fixture and is not claimed
to improve. The production sync-health timeout is a separate open incident.

To reproduce, copy benchmark.ts to tests/agent-transcript-tombstone-benchmark.integration.test.ts
and run that file with pnpm exec vitest run --no-file-parallelism, first on
34d89777, then on this change with BENCHMARK_TAG=bounded and
BENCHMARK_COMPARE=investigations/agent-transcript-tombstone-2026-09-09/baseline.json.
Remove the temporary test afterward. This measurement fixture remains outside
the default suite; baseline.json/bounded.json/wide.json include plans and outputs.

## Validation

`pnpm check` passed: strictness ratchet remains at 1908 existing errors across
121 files without a budget change; lint passed; 280 unit files / 3110 passing
tests / nine existing skips; dashboard build passed. `pnpm build:production`
and `git diff --check` passed. Existing pg concurrent-query deprecation and
bundle-size warnings remain; no test was skipped in the integration run.

Real Docker-Postgres integration validation passed: five files / 122 tests /
zero skips. Command:

```text
pnpm exec vitest run --no-file-parallelism \
  tests/agent-transcript-tombstone.integration.test.ts \
  tests/agent-transcript-window.integration.test.ts \
  tests/agent-read-operations.integration.test.ts \
  tests/agent-read-isolation.integration.test.ts \
  tests/agent-read-gates.integration.test.ts
```

The new two-case regression file was also run with the unchanged 34d89777 reader:
the cross-platform collision case failed as expected (other-platform became
incorrectly deleted). Its smaller unbound fixture already chose a cheap plan on
the baseline and passed; it is not claimed to reproduce the performance defect.
The separate mixed-platform benchmark above provides that work reproduction.
The first integration attempt exposed a duplicate fixture page label; labels
were made unique and the final complete five-file run passed.

Regression tests exercise unbound Fansly in a populated
OFAPI archive, actual executed row visits (without time thresholds), chatless
OFAPI deletion, cross-account and cross-platform isolation, includeDeleted/count
parity and clearing the current binding. Existing window/API suites cover source
priority, nulls, time boundaries, purchases, keysets, witnesses and read budgets.

## Release and remaining scope

Independent review is required before merge. No new production deployment is
authorized. Prepare an immutable reviewed revision, retain normal deployment
health/rollback gates, then obtain the deployment yes. After a successful deploy,
read the three original blocked lora-1 targets and finish its full 143-ID cohort
before the already approved Lilly replay scopes. Do not repeat already-v6 replay
to work around a serving failure. The previous code is the rollback; schema/data
are identical.

Original reply acceptance remains 266/994 across historical timestamped reads;
three lora-1 targets and 725 Lilly targets are unaccepted. The complete attachment
cohort, fresh capture/serving latency, unresolved known heads and lilly-2 recovery
remain open. A0/T0 has not started; no shadow clock, HTTP savings or fresh-event
latency distribution is claimed. W0/B0/B1/A1/B2 gates remain as defined in the
migration plan. Provider-deleted head repair remains outside A0.


At 17:43:46 UTC, production API/worker/scheduler were still healthy with zero
restarts on PR161's same image, 29 GiB free. The first loopback request used
/health and returned the dashboard HTML; it is not health evidence. The correct
route from the deployment script, /api/v1/health, returned status ok at
17:44:34.772 UTC with database latency 6 ms. No costly sync-health or transcript
retry was sent in this operation. These health checks do not close serving
acceptance or the earlier latency incidents.
