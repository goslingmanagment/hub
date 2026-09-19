# Independent retained runtime review

Reviewer `/root/w0_role_tests`, 2026-09-14T05:18:47.411968+00:00.
Local analysis only; no production/browser calls, tests, code, Git mutations or flag changes.

**Verdict: internally consistent; no new runtime failure class or new owner action established. Recurring failures remain unresolved by this packet. Health does not prove the protected deployment gate.**

## Integrity and runtime

All four command receipts exited 0; all eight stdout/stderr hashes match raw
bytes. All stderr files are empty. Parsed Docker rows exactly match
`runtime.json`, the previous 23:09:47 UTC heartbeat and the audit
`production-post-merge-read` at 02:14:59 UTC (its hashes also verify).
The previous heartbeat's execution receipt has no per-command hashes; its raw
runtime hash matches its retained independent review and both later receipts.

At 05:08:25 UTC all three roles are running/healthy with zero restarts,
source label `380326368fe3`, common image
`sha256:c443947a356972cd2833c10a4e728fe1890e92e76a77fc2328f00ebca0af5c85`.
Container starts remain September 13 00:08:30.694541669 (API), 00:08:36.595201918
(worker), 00:08:30.691550475 (scheduler), UTC. No source/image/start-time
change is observed. The external release's protected deployment gate remains
**unknown**; these snapshots prove liveness only.

Loopback health/API/database checks are `ok`; database `latencyMs=1` is one
response field, not a percentile. Root disk has 18,266,872 KiB (**17.42 GiB**)
available, capacity 78%, down 479,400 KiB (0.457 GiB) from the last heartbeat.
All three retained disk checks remain below their 90% threshold; last 77.806%
at 04:15. No threshold crossing is shown.

## Bounded logs and failures

The command requests since September 13 23:09:55.160888 UTC with `--tail 3000`.
All 3,000 lines parse, spanning **01:30:03.319–05:08:24.567 UTC**. The tail limit
is reached; the earlier requested interval and some chunk beginnings are missing.

- Numeric levels: 949 info, 240 warning, **2 error**, 1,809 without numeric level.
  No warning/error message contains `diagnostic` or `sink`.
- Sync summaries: **1,369 partial, 236 success, 8 skipped, 0 failed**. Separately,
  they aggregate 6,763 physical attempts, 78 retries and **26 terminal failures**.
  All 26 are in 13 partial `media_stats` chunks. Zero failed sync status is not
  error-free. Summary attempts and raw attempt events must not be added together.
- Media totals: Lilly-2: 63 attempts / 47 retries / 16 failures; Lora-1: 39 / 29 / 10.
  Raw tail retains 24 terminal media failures (22 HTTP 500, 2 transport), 65 HTTP 500
  retry outcomes. The difference from whole-chunk totals is consistent with
  omitted chunk beginnings. Other four Fansly pages are outside this media tail;
  the separate cumulative A0 export owns the broader six-page accounting.
- Lora-1 reaches `callsToday=dailyCap=300` at 01:33:49.939; Lilly-2 at 01:36:51.614.
  Both then emit zero-attempt partials. Cap exhaustion supports later silence;
  **no later media success/provider recovery is demonstrated**. Last cycles still
  report 5,592/3,089 due items respectively. Their 2,198-day/16-day cycle estimates
  are logged runtime estimates, not measured completion latency.
- Two other transport retries concern Lilly-2 earnings and Lilly-1 group listing;
  neither stream has terminal failed attempts in retained summaries. Other sync
  work continues through 05:08.
- Both numeric errors are **OFAPI** chargeback reconciliation at 03:10:14/15,
  `lora-of` and `lora-vip-of`: `OFAPI list page continuation unavailable`,
  response status field 200. The completion record retains both pages failed
  with zero written rows; these are not Fansly HTTP 500 events.
- OFAPI link stats is partial for `lora-of` (`empty_unverified`, 04:45), while
  `lora-vip-of` reports written. Workboard reconciliation changes 101 of 67,033 rows.

The same OFAPI pages/reason, link-stats degradation, workboard drift 112 and
media terminal failures already occur in the retained September 13 morning packet
(media: 18 summaries, 144 attempts, 108 retries, 36 failures). This establishes
recurrence, **not resolution or comparable rates**. No new owner action follows
solely from these repeated classes; unresolved failures remain visible.

All 219 threshold warnings name only `obs_backlog_webhook_ofapi_v5`; none names
`sse_delivery` (previous tail: 3). No gauge or p95 values are present, so this
proves neither improved latency nor zero backlog.

Progress remains observable: 218 canonicalization sweeps append 9,539 events,
zero reported errors/partition blocks/binding conflicts; 185 archive sweeps
insert 429 and tombstone 0. Smoke frames rise 1,399,326 → 1,402,391, last 4,319 beyond
the previous heartbeat's last summary; retained gapCount 2,781 / duplicateCount 0
stay unchanged. Activity is not reader equivalence, loss proof or latency.

## Configuration semantics

The retained ordinary authenticated refresh reports desired versions A0 = 1
(original six labels), C2b = 1 (`lilly-1`), catch-up = 4 (`none`), with matching
`running.value` from all three active roles. Last-seen times 05:08:39–05:09:20,
response generated 05:09:34.958 / observed 05:10:13.966 UTC. This proves reported
current role values, **not exact per-role applied versions or uninterrupted
historical continuity**. Reviewer did not replay the browser observation.

Production-source `app-config-service.ts` confirms `runningState` summarizes
booleans for live keys. String allowlists yield `unknown` and
`desiredEffective=null`; this does not negate explicit matching string values.
`overrideVersion` is the desired DB override's version, not role acknowledgement.
Source SHA256 `576f7fb5224e81848b202b737b7d2dd9fe5816bf380ce73d40791ed28edb22ae` at
`380326368fe39a6a9d22eb73b0b955f8ecd7c3cc`.

## Disposition and hashes

Continue existing read-only observation/gates. No new action-changing condition
is established; recurring media/OFAPI failures are not certified resolved.
No ≥50% savings, reader latency, shadow acceptance or deployment approval follows.
Routine unchanged health or improved flag receipt detail alone is not a notification.

| Artifact | SHA256 |
|---|---|
| `execution.json` | `a0c7d2cb45a0a7ed10bf577a1505dbbfe5122a612b794e039eefc3c271eae84e` |
| `runtime.stdout` | `aa9289229160773ad4e085115e5c237c67986e4fcab2b9d7280169f021a8c8c1` |
| `runtime.json` | `6320a829e16d265043d1249cb1629fae52b470eeeb97e33dc5b9a256adf6a668` |
| `api-health.stdout` | `b0201c2553184030acd405ed2143f10dd642852e05933615ee2741b08136a991` |
| `disk.stdout` | `b4c5b395da1fc2140d4101c08bcabc601be061c8435bd567785f75e729d94914` |
| `worker-log.stdout` | `8b35258850324c8717458a72d7e77dcab45d4ce2c5b34f1bb9e0a11c219be93c` |
| `configuration-read.json` | `54fc062dd4347fcfe0f1ddbfd85f2530f0a2ec20fb37433feab72a7b6a523c96` |
| `worker-log-summary.json` | `106d2d19846e4b692dd11dc3e7c27c2163324619e91824db3bdd35f8fca5d3f5` |

All stderr: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
September 13 morning raw log: `2e1e5b392c484466e86f516a3e7b86c14c13e388dc0b0d87e3edc20a4b943542` in
`../heartbeat-runtime-20260913T050749Z/worker-log.stdout`.
Earlier audit: `../../fansly-migration-audit-2026-09-14/followup/production-post-merge-read/runtime.execution.json`.
Only named artifacts were reviewed; subsequent shared report/state edits are outside scope.
