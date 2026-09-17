# Independent runtime/log review — September 14, 11:06 UTC

Reviewer `/root/w0_role_tests`, 2026-09-14T11:10:13.864827+00:00.
Local retained-artifact review only; no production/browser calls, tests, code,
Git, state, flag or automation changes.

**Passed: raw evidence and summary agree. No current runtime/configuration change
or new required owner action is established. One separately retained capture
warning remains visible; the interval is not described as error-free.**

All four commands exited 0 and all eight stdout/stderr hashes verify. Stderr is
empty. Parsed Docker output exactly equals `runtime.json` and the previous
05:08 packet: API/worker/scheduler running and healthy, zero restarts, unchanged
starts, source `380326368fe3`, image `c443947a3569`. This is liveness evidence;
the external release's protected deployment gate remains **unknown**.
Loopback API/database health is `ok`; the database field **0 ms** is one probe,
not a percentile. Disk has **18,352,444 KiB / 17.50 GiB** available, capacity 78%,
85,572 KiB more than the previous snapshot. All six logged disk checks remain
below their 90% threshold (last 77.707%).

The command requested logs since **05:08:26.382933 UTC** with `--tail 3000`.
All **2,803** returned lines parse, spanning **05:08:27.039–11:06:32.754 UTC**.
The tail limit was not reached. This establishes no tail-limit truncation,
not guaranteed completeness of upstream telemetry or every physical request.

| Retained log measure | Result |
|---|---:|
| Numeric info / warning / error | 1,011 / 389 / 0 |
| Records without numeric level | 1,403 |
| Sync partial / success / skipped / failed | 977 / 384 / 11 / 0 |
| Summary physical attempts / retries / terminal failures | 5,601 / 1 / 0 |
| Diagnostic/sink warning or error messages | 0 |

The one raw retry is Lilly-1 monthly earnings timeout at **10:46:56.715 UTC**.
Same run **748990** later records a partial chunk with five attempts, one retry
and zero terminal failures at 10:47:06.578. Partial chunk status is distinct
from HTTP outcomes; the request and summary representations are not added.

One **OFAPI capture transport failed** warning at **06:33:20.514 UTC**, page 8,
records a body-read timeout after 65,003 ms: response header status 200,
88,508 of 105,397 declared bytes read. The body did not complete. No same-job
recovery appears in the retained logs. This is a newly retained warning,
separate from the prior continuation-unavailable failures; zero numeric error
logs or failed sync summaries does not erase it. The packet does not prove a
continuing outage, its cause, successful repair or a required owner action.

There are **no media_stats chunks, HTTP 500 events or daily-cap logs** in this
packet. Prior media failures and capped runs remain unresolved historical
observations; absence of new calls cannot certify recovery or current freshness.
The previous OFAPI continuation/link-stats failures do not recur in this returned
interval, which likewise does not prove that they are fixed.

Threshold warnings repeat **358** times, all naming only
`obs_backlog_webhook_ofapi_v5`; none names `sse_delivery`. No gauge or p95 value
is supplied. Thirty other warnings are the existing transaction early-stop
message. No latency improvement or backlog clearance follows from these counts.

Work continues: **358** canonicalization sweeps append **3,843** events with zero
reported errors, partition blocks or binding conflicts; **212** message archive
sweeps insert **1,356**, tombstone zero. Smoke frames advance to **1,404,107**,
**1,716** beyond the prior packet's last sample; gap count stays **2,781** and
duplicate count zero across retained samples. These are activity counters, not
reader-equivalence, loss or event-to-reader latency measurements.

Lilly-1 earnings work is independently visible in this same retained log:
**50 chunks, 49 partial then one success**, from run **748966** at **10:44:27.247**
to run **749059** at **10:53:41.800 UTC**. Lifetime has **99 attempts**, monthly
**100 including one retry**, with zero terminal failures. This corroborates the
separate C2b endpoint delta and later daily completion; it is not based on a
completion timestamp alone. Logs expose **no generation, lease/request sequence,
request source or explicit full-walk start**. First partial timestamp/duration
cannot establish the full start; no observed runtime/config boundary cannot
prove uninterrupted instrumentation history. Gate assessment belongs to C2b.

The ordinary authenticated configuration response generated **11:07:52.603 UTC**
(observed 11:08:10.924) reports the same A0 six labels/version 1, C2b
`lilly-1`/version 1 and catch-up `none`/version 4. All three active roles report
matching string values, last seen **11:07:20–11:07:42 UTC**. Desired versions
are not per-role applied-version acknowledgements. The non-boolean allowlists'
`runningState=unknown` / `desiredEffective=null` do not negate their reported
string values; this production-source behavior was verified in the prior review.
Historical continuity and exact applied versions remain unproved. No clock reset,
new gate acceptance or attributable savings follows.

| Artifact | SHA256 |
|---|---|
| `execution.json` | `8bb63b9d3c75f6b60b546d1be8ee15d73db59959dc66c5968ca2048c3a2692dc` |
| `runtime.stdout` | `aa9289229160773ad4e085115e5c237c67986e4fcab2b9d7280169f021a8c8c1` |
| `runtime.json` | `6320a829e16d265043d1249cb1629fae52b470eeeb97e33dc5b9a256adf6a668` |
| `api-health.stdout` | `46316d5b54a031f903514915723fe4461d7048beb6374aac2ecb4057bde8ea85` |
| `disk.stdout` | `672184f99885f1281af9edd2c868b6e2ac4eec8f736e635e3b437788df698a93` |
| `worker-log.stdout` | `56ffa3d85771bf9734c871a4a060b06d4e5f03c0dd9b9bc786caf246cfc283b1` |
| `worker-log-summary.json` | `27df45decf83f6e17c3de114169c5f7c68b298a2d221f8233e07603bcdacf0e7` |
| `configuration-read.json` | `3cb1db6d686ef3ac80f10749eb9f19376001fd209976030dfe9a47c7fc694f92` |

All stderr hashes are `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
Comparison: `../heartbeat-runtime-20260914T050824Z/runtime.json`,
`worker-log.stdout`, `configuration-read.json` and `REVIEW-RUNTIME.md`.
Scope excludes later report/state edits and the separate A0/C1/C2b measurements.
