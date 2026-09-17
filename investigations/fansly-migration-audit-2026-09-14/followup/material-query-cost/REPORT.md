# A0 material-query cost: authorized measurement blocked

At 2026-09-14T00:55:47.308519+00:00, production `read_only` lacks table SELECT on all three objects required for this slice: `page_dm_threads`, `page_dm_messages` and `fansly_dm_head_debt`. The read-only privilege preflight succeeded; sampling and EXPLAIN were deliberately not attempted. **Actual material SQL cost remains unmeasured.**

| Measurement | Result |
| --- | --- |
| Page samples / head IDs | 0 / 0; no message bodies read |
| EXPLAIN ANALYZE statements | 0 |
| Material planning/execution time and buffers | Unknown |
| Runtime hot-path p95 / event → reader latency | Unknown |
| API / worker / scheduler | Running, healthy, zero restarts at 00:56:17 UTC |
| Container source / image | `380326368fe3` / `c443947a356972cd2833c10a4e728fe1890e92e76a77fc2328f00ebca0af5c85` |

## Exact access and bounded execution

`preflight.sql`, raw stdout/stderr and `preflight.execution.json` retain the full command and hashes. PostgreSQL independently reported `current_user=session_user=read_only`, `transaction_read_only=on`, repeatable-read isolation, a 5 s statement timeout and a 100 ms lock timeout. `pages` SELECT is granted; the other three table SELECT checks are false. This is a privilege preflight result, not a caught query permission error, timeout or slow plan. No app-user DSN, alternate role or privilege fallback was used.

The only SQL data statement executed was the role/settings/privilege catalog SELECT. Its SSH/process elapsed time is not database query execution time. The remote process was bounded to 8 s (+1 s kill grace), with a 20 s local outer timeout, within the 45 s overall query allowance. The separate read-only Docker inspect records health/source metadata only; it does not expose environment variables, credentials or provider connections.

## Prepared measurement and limits

`sample-prepared-not-executed.sql` selects at most six Fansly pages and their newest 100 visible current head IDs using the existing page/visibility/message-time index. It does not enumerate archived messages, raw observations or bodies. The plan is deterministic current-state sampling, biased toward recent visible conversations; it is not a random or complete provider-list sample. Those samples remain unexecuted because the required privileges are missing.

`material-prepared-not-executed.sql` preserves the deployed query's VALUES relation, exact hot-message EXISTS predicate and debt left join. Per-page values would be substituted as typed bigint/text pairs, with at most 100 heads, then one `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` run per page. The committed production source is retained and hashed in `summary.json`; it uses the 5 s material timeout and separate 500 ms report-write timeout. The current local checkout's older 500 ms material source was not silently used as production truth.

Even a successful run would measure one current read-only probe per sample. Sampling can warm shared data; without a cache-state experiment it cannot certify cold behavior. Current stored head IDs are not provider responses captured before list apply. EXPLAIN execution excludes app connection/transaction waits, serial pipeline scheduling, report writes and reader publication. It cannot establish the hot-path p95, event-to-reader latency or capture completeness. No ≥50% saving or A1 acceptance follows.

Next concrete prerequisite is an explicitly authorized way to run this exact bounded read without bypassing standing role policy. The templates and privilege receipt are ready for that decision. No privileges, configuration, deployment, data, socket or credentials were changed. The original audit report and its evidence were preserved; this packet is added only under `followup/`.
