# Independent runtime/config/log evidence review

Reviewer: `/root/w0_browser_discovery`. Reviewed locally at
2026-09-13T23:17:16.007182+00:00. Scope is the root-authored shared
runtime/config/log packet, including the Runtime and configuration section of
`REPORT.md`. This review does not assess C2b evidence authored
by this reviewer. No production queries, browser actions or provider requests
were performed during review.

**Verdict: passed; no unresolved actionable findings in the reviewed packet.**

## Finding fixed and rechecked

The original `errorCount: 0` label counted numeric log levels >= 50 while
omitting six `sync_http_summary` rows with `status=failed`. Root renamed this
field to `logErrorLevelCount`, added independently reproducible
`syncRunStatusCounts` and `failedRunSummaries`, and made the distinction explicit
in `failureScope`. I rechecked every final count and every field of all six
failed summaries against raw logs after the fix.

The six failed summaries are Lilly-2 Fansly `dm_conversations`, at 20:47:34.377,
20:49:19.561, 20:58:02.780, 20:59:20.260, 21:06:16.097 and 21:07:33.739 UTC.
Each has two recorded attempts, zero retry attempts and zero failed attempts.
The retained metadata does not establish why the sync outcome failed; no loss,
causality or absence-of-failures claim follows from numeric log levels alone.
The narrower claim of zero diagnostic-sink warning/error messages remains
supported by the sampled logs.

## Reproduced evidence and limits

- All four retained commands are read-only: selective Docker metadata, disk
  usage, bounded loopback health GET and tail-limited worker logs. Each receipt
  has exit 0. Command receipts give the remote command, not a full SSH invocation.
- `runtime.json` exactly reproduces the three JSON lines of `runtime.stdout`.
  API, worker and scheduler are running/healthy, restart count zero, common
  source label `380326368fe3` and image `sha256:c443947a356972cd2833c10a4e728fe1890e92e76a77fc2328f00ebca0af5c85`.
  The runtime objects equal the prior 17:07 packet. This proves the observed
  Docker metadata, not a protected deployment gate or semantic correctness.
- Loopback health reports status `ok`; API and database checks are `ok`.
  Database latency 0 ms is this response's field, not an interval percentile.
- Disk output reports 18,746,272 KiB available (17.88 GiB),
  capacity 77%. The response describes the root filesystem only.
- Configuration receipt records A0's six labels, C2b `lilly-1` and catch-up
  `none` at 23:10:46–47 UTC, and three active roles at 23:11:45 UTC. Its explicit
  false values for effective role acknowledgement/version and historical
  continuity are correct scope limits. This is review of the retained UI
  receipt; no independent browser replay or screenshot was supplied here.
- All 3,000 log lines parse. Their timestamps span 18:47:23.040 through
  23:09:15.706 UTC. The command requested logs since 17:07:13 with `--tail 3000`,
  so the earlier portion is not covered. Absence is not a full-interval proof.
- Numeric warnings reproduce exactly: 262 `golden-signal p95 over threshold`
  and 23 transaction early-stop warnings. Of the threshold warnings, 259 name
  only `obs_backlog_webhook_ofapi_v5`; three also name `sse_delivery`, at exactly
  the retained summary timestamps. They contain names, not gauge values or
  delivery percentiles. The prior 17:07 summary retained eight SSE-name warnings,
  supporting recurrence. No missed frames, new cause or event-reader latency
  is established by these warnings.
- Sync status counts reproduce exactly: 1,011 partial, 294 success, 10 skipped,
  six failed. These outcomes are kept separate from numeric error-level logs.

The shared report's runtime/config/log section preserves these distinctions:
current liveness, unknown effective flag continuity, tail-only log coverage, six
failed sync outcomes, and unmeasured SSE latency. Its 0 ms health value is
explicitly scoped to the probe resolution. No protected deployment gate is
claimed from current health; no such gate receipt is included in this packet.

## Reviewed hashes

| Artifact | SHA256 |
|---|---|
| `execution.json` | `85984209db62ff2f08bcdfbfc52509f3a112a17f1a57f241c0f2e867e0d758df` |
| `runtime.stdout` | `aa9289229160773ad4e085115e5c237c67986e4fcab2b9d7280169f021a8c8c1` |
| `runtime.json` | `6320a829e16d265043d1249cb1629fae52b470eeeb97e33dc5b9a256adf6a668` |
| `api-health.stdout` | `670ad1069d8456e73879de21e55f7ff23b305d340cbe0cc47163e7a3b975ace5` |
| `disk.stdout` | `36f4e70ac4410223920452e26da5e6463c109ac36a46cdf3d3bff0c6414c0b07` |
| `configuration-read.json` | `c780e95a62d1aea9d1c0315d6a4d19834b69eebf68278656e75fcebf44c51dd7` |
| `worker-log-summary.json` | `e82db1fc1385370c8154dd5779925a56610f6af9544fdd643241bfae2ecd129a` |
| `worker-log.stdout` | `9bea1ccb264cc0851f0615907ea22d89c89b7e70e45187c29b3bb9b7fcf1062e` |
| `REPORT.md` (runtime/config/log section only) | `b7abc6530d1dc59afc7c1477e04000bf4f4c1d0d9405c1674dbc885fcb08d585` |

Historical comparison sources: `../heartbeat-runtime-20260913T170716Z/runtime.json`
and `worker-log-summary.json`. Observation-results and disposition sections of the overall report, and any
subsequent packet edits, are outside this immutable-artifact review.
