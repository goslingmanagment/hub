# A0 deployment and T0 production measurement

Latest: [13 September, 17:07 observation](activation/20260910T225618Z/snapshot-20260913T170727Z/REPORT.md).
The cumulative report has **787 sweeps: 542 complete, 245 incomplete, zero running**.
All previous 713 rows are unchanged. New rows: 70 complete and four Lora-1
incomplete comparisons. Two recorded overlap guards (G4864/G4872) are each
followed by an incomplete row with a null comparison boundary (G4865/G4873);
subsequent G4866/G4874 are complete. Zero unknown material and
completeCoverage=true do not override incomplete status.

Four completed comparisons add one exclusion-reason occurrence each on
Lora-1 G4866/G4867/G4874 and Lora-3 G7676, all below stop 9. The subtype was
already known on Lilly-2; no thread, value, direction or causal attribution is
established. Reason coverage is 248 known, 538 absent and one null. Historical
unknown material remains 403,215; DM lost reports remain eight and unknown runs
one, while DM failed runs rise from 26 to 28 on Lora-1.

Cumulative HTTP attempts are **86,625** (+6,956); retry ordinals 3,217 and failed
outcomes 1,037 are unchanged. Four HTTP unknown runs and three boundary runs
remain. Do not sum snapshots or treat this as attributable migration savings.
Lora-1 G4830 remains **2,364 runtime occurrences versus 2,363 raw clearings plus
one pre-apply unknown**. Early-stop remains **NO-GO**, full polling continues,
and the earliest seven-day report stays 17 September 22:58:33.610 UTC.
Runtime/configuration receipts are updated separately by the coordinator.
Independent [review](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T170716Z/REVIEW.md) passed with no open actionable findings.

The [11:08 observation](activation/20260910T225618Z/snapshot-20260913T110823Z/REPORT.md)
is historical; its independent [review](heartbeat-runtime-20260913T110856Z/REVIEW.md)
passed. Exact pre-update local documents are backed up in the new snapshot.
The separate [completed-day traffic measurement](../fansly-cost-latency-measurement-20260913T094049Z/MEASUREMENT.md)
records load change without proving migration savings or event latency.

Shared [17:07 runtime and 17:08 configuration evidence](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T170716Z/REPORT.md)
shows the unchanged healthy image and visible allowlists. Per-role application,
continuous history and the current protected deploy gate remain unverified.

Previous snapshot (historical): [13 September, 05:08 observation](activation/20260910T225618Z/snapshot-20260913T050855Z/REPORT.md).
The cumulative report has **641 sweeps: 400 complete, 241 incomplete, zero running**.
There are 58 new complete rows; two prior running rows completed and all 581
prior terminal rows remain unchanged. Lilly-2 G6838 supplies the first positive
retained exclusion-reason counter (one occurrence); three additional flags
occurrences belong to the already known discrepancy class. There is no thread,
value, direction or content-loss attribution and no changed operational action.
Each added reason field is known on 102 rows (97 complete, five incomplete),
absent on 538 and null on one. Unknown material remains 403,215; eight DM lost
reports and one unknown DM run remain. HTTP unknown runs are six, including
new scheduled fan_earnings unknown buckets for Lora-2 and Lilly-2.

Lora-1 G4830 remains 2,364 runtime head/rollback occurrences versus 2,363 paired
raw clearings plus one pre-apply unknown. The early-stop candidate stays **NO-GO**;
full polling, the original seven-day clock and all acceptance gates remain.
The [05:07 runtime receipt](heartbeat-runtime-20260913T050749Z/runtime.json)
shows the same image/source label `380326368fe3`, all roles healthy, zero restarts;
ordinary API/database health is ok with an 11 ms database probe. This is not a
protected deployment gate. The [05:08 Chrome attempt](heartbeat-runtime-20260913T050749Z/configuration-read.json)
was unavailable. The 01:00:36–41 UTC visible configuration receipt remains
historical; no fresh effective-value or uninterrupted-continuity proof is claimed.
The A0-only notification recommendation is quiet; independent artifact review is pending.

Previous snapshot (historical): [13 September, 00:15 observation](activation/20260910T225618Z/snapshot-20260913T001518Z/REPORT.md).
The cumulative report has 583 sweeps: 340 complete, 241 incomplete and 2 running.
Lora-1 generation 4830 contains 2,364 changed-head/rollback occurrences; these
are not unique losses, and the row has no new reason counters. The subsequent
[raw comparison](lora1-4830-20260913T003537Z/REPORT.md) identifies 2,363 persistent
list-pointer clearings missed by all nine candidate policies; the extra runtime
occurrence remains unknown. The current early-stop candidate is NO-GO; full
polling and the original A0 clock remain. The [authenticated UI read at
13 September 01:00:36–41 UTC](flags-current-20260913T010036Z.json) shows the
exact six-page A0 allowlist, C2b `lilly-1` and head catch-up `none`, with all three
roles active. Versions and per-role configuration acknowledgements were not
shown; uninterrupted historical flag continuity remains unverified.
Source label `380326368fe3` was healthy on all roles
at 00:15 UTC. The original seven-day clock and open acceptance gates remain.

Previous observation (historical): [12 September, 18:37](OBSERVATION-20260912T183741Z.md).
The cumulative report has 276 complete and 236 incomplete sweeps; all 87 new
sweeps have complete diagnostics. Four new generic state discrepancies remain
unexplained after retained-metadata comparison. Historical gaps remain explicit.
The three runtime roles were healthy on `31b73a96` at 18:38 UTC. Both independent
reviews are clean. A0 acceptance, physical savings and fresh-event latency remain
open; the earliest seven-day point stays 18 September 01:58:33 Moscow.
The following dated release records are historical.

At 19:48 UTC, runtime was `66d6ac1a`: the owner-approved combined C1 release with
merged [PR172](https://github.com/goslingmanagment/core/pull/172) and PR171.
The standard deploy exited **0** at 11 September **19:47:07 UTC**. Protected
sync-health returned **200** with all eight pages, after two 150-second timeouts;
the successful request took **133.3 seconds**. Its latency remains unresolved.
API, worker and scheduler were healthy with zero restarts at 19:48, their
compiled files matched the approved build, and the production-pinned CLI passed.

The [deployment report](../fansly-c1-deploy-2026-09-11/health-deploy-20260911T191946Z/REPORT.md)
retains the actual exit, response bodies, log timings, image/CLI evidence and
independent review. The exact approved tree had 3251 passing unit tests, nine
existing skips, 81 real Postgres tests without skips and all five CI checks.
All 179 migration files were retained; no flag was changed.

The first new-runtime window ends at 19:49:43 UTC: C1 has two valid no-request
decisions. A0 has one incomplete sweep, three running, none complete and 1100
unknown material checks; DM coverage includes one lost-report receipt in an
intersecting run, which cannot be attributed to the release. These are coverage
gaps, not distinct lost-message counts. This window is not added
to older snapshots. The original A0 clock and all other stage gates remain.
The approved deployment and earlier one-use EXPLAIN permissions are consumed.

The following dated records retain the earlier deployments and observations.

A0 [PR164](https://github.com/goslingmanagment/core/pull/164) was initially deployed at
`a3caa0e9f7b37a5cde83485613d8a059c0050aca`. Deployment finished on
10 September at 22:03:36 UTC (11 September, 01:03:36 Moscow).
The physical-attempt baseline and historical corpus exports are complete;
their checksums and nine-policy summary were independently verified.
The historical comparison found changes below every candidate stop policy.
Runtime shadow was **enabled on all six pages** at 10 September 22:58:33.610 UTC
(11 September 01:58:33 Moscow); the last full configuration check was 23:01:04 UTC.
Recent shadow activity exists on all six pages, but the exact allowlist after
the worker restart is unverified. The owner-approved enable and observations
are recorded in [SHADOW-OBSERVATION.md](SHADOW-OBSERVATION.md). The seven-day
observation period is in progress; the earliest report point is 18 September
01:58:33 Moscow.

The historical runtime read at 11 September 00:33 UTC found all roles on
main `32478124`, including C2a/C2b code; its deployment was not observed here.
The later owner-approved C1 diagnostic release changed the source to
`d47dc9b09f87`. The earlier **17:06 UTC** read confirmed that source on all
three healthy roles; the latest 19:00 read is recorded above. The worker restarted once at 03:08 after a pg-boss pool
checkout timeout; API and scheduler have zero restarts. Its protected sync-health
deployment gate remains failed. Replay completion and C2b enablement are unverified.
The cumulative A0 cohort contains material-check timeouts and incomplete
comparisons; see SHADOW-OBSERVATION.md. No completeness or savings gate is passed.

The [latest observation](OBSERVATION-20260911T170708Z.md) has 206 sweeps:
21 complete, 182 incomplete and three running, with 318,615 unknown material
checks. This is a non-atomic read completed at 17:07:21, including late updates.
Of 66 newly started sweeps, none is complete. An incomplete Lora-1 sweep adds a
state-change observation below the virtual stop; DM lost-report receipts rose
from three to six. These are coverage failures, not distinct lost-message counts.

## Deployment verification

- The owner approved the concrete inert A0 deployment with “давай там делай”.
  No flag flip, socket, replay or A1 action was performed.
- At this initial deployment, API, worker and scheduler all ran image
  `sha256:148188403f92bef8d8804cad6358abf841805f2245a6d91ffca8cb966704fea2`,
  source label `a3caa0e9f7b3`, dependency checksum
  `f4612198158624cc37aaff52d11d72c4ef3f679d41df7386f52d039e29b74bee`.
  All three were healthy with zero restarts at 22:03:37 UTC; disk had 27 GiB free.
- Standard API, worker, scheduler, capability, protected sync-health and
  same-origin dashboard gates passed. The local Hub CLI was rebuilt and its
  production capability check passed. Image garbage collection was disabled.
- The initial dist-only attempt correctly stopped before build/runtime changes:
  A0's root `pg` dependency changes the lockfile checksum. The same approved
  source was then built and deployed with the standard full-build path.
- Migrations 0174–0177 are applied. `sync_runs_finished_idx` is valid and ready.
  `read_only` can execute both new readers and select the diagnostic view;
  direct reads of `sync_raw_payloads`, `sync_http_attempts` and `sync_runs`
  remain denied. The diagnostic view contained zero rows while shadow was off.
- At 22:05:37 UTC, the authenticated Configuration UI showed all three roles
  active, `fanslyDmShadowPageAllowlist=none`, head catch-up `none`, and no
  differences in existing editable controls. No save was performed.

Evidence: [dispatch](evidence/full-build/deploy-dispatch.json),
[deploy log](evidence/full-build/deploy.log),
[result](evidence/full-build/deploy-result.json),
[runtime](evidence/post-deploy/runtime.txt),
[image labels](evidence/post-deploy/image-labels.txt),
[READ ONLY database checks](evidence/post-deploy/database.txt),
[configuration](evidence/config-after.json).

The additive diagnostic schema remains installed on rollback. The deployment
script does not classify 0174–0177 as automatically rollback-compatible;
its schema guard was preserved. No rollback or database repair was needed.

## Tests and independent review

The deployed tree is identical to reviewed head `964f5102`. The pre-PR local
checks recorded in PR164 passed: `pnpm check`, 3,134 tests in 284 files with
nine existing skips; lint/dashboard build pass; strictness ratchet unchanged
at 1,908 known errors across 121 existing files. Six serial Docker-Postgres
suites passed 44 tests with zero skips in 15.11 seconds.

They cover shadow/off sweep parity, continuation and a two-hour outage,
guard rejection, failed diagnostic sinks, exact hot-head receipts, retries,
sources, boundary losses, restricted readers, bounded corpus export and page
erasure. Query-plan tests use 50,000 runs and attempts. The local evidence
does not establish production query latency or discovery-to-reader latency.
All five PR CI checks passed; independent implementation review closed all
findings before merge. The full production image build passed in this run.

The independent reviewer also checked the operational export helpers and
recomputed the actual baseline. Output-path resolution, READ ONLY session
defaults, cancellation and signal handling findings were fixed. Four local
Docker-Postgres cases verify cancellation and completed export/analysis.
Details are in [REVIEW.md](REVIEW.md).

## T0: six historical UTC days

Window: **1 September 00:00 UTC through 7 September 00:00 UTC**, half-open.
The bounded report was read between 22:05:29 and 22:05:46 UTC on 10 September.
The SHA-256 manifest and independent recalculation agree.

| Measurement | Recorded result |
|---|---:|
| Physical-attempt rows | 183,416 |
| Mean recorded attempts per day | 30,569.3 |
| Attempts with retry ordinal greater than one | 5,241 |
| Rows in terminal failed state | 1,709 |
| Rows in success state | 176,466 |
| Rows in retry state | 5,241 |
| Known captured-payload bytes | 12,888,887,748 |
| Attempts with unknown captured bytes | 9,100 |
| Overlapping runs | 42,839 |
| Runs with unknown loss counters | 42,839 |
| Runs crossing the report boundary | 3 |

Retry ordinals and the `retry` state are different dimensions; their equal
totals here are coincidental. The ordinal>1 rows include 102 successes,
3,436 retry states and 1,703 terminal failures. Bytes describe the captured
JSON payload, not compressed/wire traffic. Unknown bytes are not zero bytes.

| Fansly page | Recorded attempts | Retry ordinals >1 |
|---|---:|---:|
| ari-1 | 4,245 | 1,232 |
| lilly-1 | 16,097 | 1,137 |
| lilly-2 | 69,550 | 928 |
| lora-1 | 41,708 | 743 |
| lora-2 | 28,839 | 784 |
| lora-3 | 22,977 | 417 |

The `dm_conversations` stream has 94,125 attempts: 93,110 `messaging_groups`,
681 `account_lookup` and 334 `messages`. Other large streams are
`fan_earnings` (34,349), `followers_reconcile` (20,881) and `media_stats`
(10,500). All 17 Fansly streams appear. Sources: scheduled 151,803;
anomaly 19,420; recovery 12,189; manual 4.

This is retained instrumented sync telemetry, **not a proven complete census**.
Historical loss counters did not exist; all 42,839 overlapping runs therefore
remain unknown for that dimension. Browser/extension traffic, future socket
handshakes, and requests outside this instrumentation are uncovered.
Shadow reports and receipts are absent because shadow was off. Their absence
does not mean zero discrepancies. No measured savings are claimed.

Completed baseline: [report](evidence/t0-2/baseline.json),
[manifest](evidence/t0-2/baseline.json.manifest.json),
[recalculated totals](evidence/t0-2/baseline-summary.json).
The manifest's `records: 0` counts shadow sweep records; the report separately
contains 1,602 physical-attempt groups and 627 HTTP-coverage groups.

## First observation after deployment

Between 22:03:00 and 22:12:34 UTC: 176 recorded attempts, zero retry ordinals,
zero failed or open-started attempt rows. There were 42 overlapping runs;
39 had known loss counters, three remained unknown, and two crossed a window
boundary. Known lost-insert and unfinished-update counters were zero.
No shadow sweep report was written. This short window establishes ordinary
HTTP progress only; it is not a sweep-completeness or freshness test.

[Fresh report](evidence/post-deploy/fresh-report.json),
[summary](evidence/post-deploy/fresh-summary.json).

## Historical corpus: completed comparison, unsafe early-stop candidates

The export ran 22:18:02–22:39:13 UTC and the unchanged analyzer finished at
22:40:03 UTC. It retained **93,130 list-page envelopes**, covering all six
pages, through pinned raw ID 2,794,341 in 5,589 disjoint ranges. The reader
reported 2,096,570 scanned envelopes, including nonmatching streams/dates.
SHA-256: `4427fc91ce476e936df767aa51a0f784b9f098ae133776a9b4d6a055d3194992`.

The independent check verified every exported ID, timestamp, line count and
hash. Scanned nonmatching envelopes are recorded by the reader's receipts;
their count cannot be independently reconstructed from the filtered corpus.
The export is a sequence of bounded timestamped reads, not an atomic snapshot.
Its 93,130 raw envelopes are a different population from T0's 93,110 physical
`messaging_groups` attempts; those counts are not interchangeable.

Each of the nine policies has the **same** denominator: 1,478 complete raw
comparisons, 214 priming sweeps and 98 incomplete sweeps. There are also 1,046
invalid/unattached records: 67 fail the metadata schema, and 979 valid pages
arrive without an active reconstructable sweep. The 67 schema failures lack
offset/limit/sortOrder; the inspected examples belong to failed runs. The 98
incomplete results comprise 64 unverified runs, 33 invalid-record interruptions
and one end-of-window continuation. None enter the successful denominator.

| K / overlap | Pages below virtual stop / 78,582 complete-cohort pages | State-change occurrences below stop | Sweeps with such changes |
|---|---:|---:|---:|
| 1 / 0 seconds | 76,022 | 42 | 40 |
| 1 / 60 seconds | 76,022 | 42 | 40 |
| 1 / 300 seconds | 76,015 | 42 | 40 |
| 3 / 0 seconds | 70,907 | 28 | 26 |
| 3 / 60 seconds | 70,907 | 28 | 26 |
| 3 / 300 seconds | 70,907 | 28 | 26 |
| 5 / 0 seconds | 66,268 | 16 | 16 |
| 5 / 60 seconds | 66,268 | 16 | 16 |
| 5 / 300 seconds | 66,268 | 16 | 16 |

These are hypothetical excluded list responses in one retained cohort,
**not actual HTTP savings**. Counts are repeated observations, not unique
messages or nine independent samples. The stop page itself remains in cost.

Default K=3 / 60 seconds, by page:

| Page | Complete | Priming | Incomplete | State changes below stop |
|---|---:|---:|---:|---:|
| ari-1 | 250 | 38 | 0 | 0 |
| lilly-1 | 247 | 38 | 8 | 0 |
| lilly-2 | 250 | 32 | 42 | 10 |
| lora-1 | 241 | 35 | 20 | 14 |
| lora-2 | 246 | 35 | 14 | 2 |
| lora-3 | 244 | 36 | 14 | 2 |

The 28 changes comprise 25 flag observations, one group absent from the
previous full comparison and two list/embedded head conflicts. In those two
responses the embedded ID, sender and timestamp change while the list-message
ID stays stale. This is not evidence of an in-place sender change on the same
message. The concrete non-flag examples were reconstructed from their
certified predecessor sweeps and independently checked:

- Lilly-2, 2 September 20:50:28 UTC: virtual stop at page 4; a group absent
  from the predecessor appears at page 34. Its message timestamp is older;
  this is not a claim that a new message was sent at discovery time.
- Lilly-2, 3 September 16:24:52 UTC: list/embedded head conflict at page 28,
  after a virtual stop at page 4.
- Lora-3, 4 September 02:45:27 UTC: list/embedded head conflict at page 15,
  after a virtual stop at page 14.

There are also 3,061,782 invalid-marker occurrences below the default stop.
The raw comparison has 7,781,157 unknown material checks and zero material-lag
samples. It cannot prove material completeness, visibility, pending-history
age or event-to-reader latency. Mutable-offset deletion/insertion can escape
both walks; zero changed-head-ID or rollback counters do not prove its absence.

Evidence: [manifest](evidence/corpus-compressed/corpus.jsonl.manifest.json),
[nine-policy results](evidence/corpus-compressed/sensitivity.json),
[summary](evidence/corpus-compressed/summary.json),
[counterexamples and rejected-record inspection](evidence/corpus-compressed/inspection.json).
The 2.23 GB metadata corpus remains local with mode 0600; it contains no
message text or media bodies and is not uploaded to the PR.

## Deployment checks and subsequent activation

At 22:40 UTC, all three roles remained healthy on the pinned A0 image, with
zero restarts and 27 GiB free. The 22:42:06 UTC API health check returned OK.
At 22:42:08 UTC a new `read_only` / READ ONLY transaction succeeded, with zero
other reader sessions and zero shadow reports. Configuration still showed
all roles active, shadow `none`, head catch-up `none` and replay `off`.
The first final curl used `/health` and returned the dashboard; the corrected
`/api/v1/health` result is retained separately and is the API-health evidence.

[Runtime](evidence/post-deploy/runtime-final.txt),
[API health](evidence/post-deploy/health-final.json),
[reader check](evidence/post-deploy/reader-final.txt).

The historical-pass prerequisite is complete as an investigation. It did
**not** pass the A0 exit or safe-stop gate. The owner subsequently approved measurement-only activation. The allowlist
changed from `none` to `ari-1,lilly-1,lilly-2,lora-1,lora-2,lora-3` and was
verified on all active roles at 22:58:33.610 UTC. A read-only heartbeat now
collects reports through the >=7-day observation gate. Full polling continues. Rollback is
the same setting back to `none`; no cursor reset, cadence change or replay.

A1 additionally requires sufficient activity, explained discrepancies and an
accepted freshness/stop contract. The current historical candidates miss
state changes; increasing K alone did not solve that. Provider-side head
rollback/deletion is counted, not repaired by A0. B2 remains a separate
decision. No fresh-event latency or >=50% physical savings goal is established.

## Stage state at this handoff

| Stage | State | Remaining work / gate |
|---|---|---|
| Pre-A0, PR157–162 | Fixes deployed; bounded repairs verified | Lilly-2 canary had 0 eligible targets / 0 recovery attempts. Eight selected messages were captured before activation; efficacy is unmeasured. Old discrepancy bounds remain explicit. |
| A0/T0, [PR164](https://github.com/goslingmanagment/core/pull/164) | Deployed; shadow enabled on six pages; baseline and historical analysis complete | >=7 full days from 10 September 22:58:33.610 UTC, discrepancy/activity review. |
| C1, [PR166](https://github.com/goslingmanagment/core/pull/166) | Diagnostics running; draft; protected deploy gate failed | Twenty-five valid decisions and four completed generations. Lilly-2's second completion is followed by matching counts and no request; no suppression fix is justified by this cohort. |
| C2a, [PR165](https://github.com/goslingmanagment/core/pull/165) | Code present in production | Approved v7 replay completion and projection verification/repair remain unverified. |
| C2b, [PR169](https://github.com/goslingmanagment/core/pull/169) | Code present in production | C2a prerequisite, separate shadow enable and correction/max-age measurements remain unverified. |
| C2c | Gated | Quiet-correction detection in the existing freshness window. |
| W0, [PR167](https://github.com/goslingmanagment/core/pull/167) | Draft; offline diagnostics ready | Approved Management Session live binding/fan-out/presence and >=6-hour continuity. |
| B0 -> B1 | Gated | W0, then >=7-day durable shadow, parity, request budget and latency. |
| A1 | Gated; current candidates miss changes | A0 evidence and separate explicit owner decision. |
| B2 | Not built | Separate owner decision. |

Physical HTTP savings and fresh-event latency remain unmeasured on every new
stage. The baseline above is measured workload; excluded pages are an unsafe
hypothetical scenario, not achieved savings.

## Observation follow-up — 11 September 02:58 UTC

That cumulative export contains **17 complete, 25 incomplete and one
running sweep**, with **49,215 unknown material observations**. Twenty-four
incomplete sweeps lack certified complete diagnostics; one hit the overlap
guard. Two DM runs report lost diagnostic receipts. Repeated observations
are not distinct missing messages. This is a material coverage problem and
does not meet the A0 exit gate.

The [observation record](SHADOW-OBSERVATION.md) retains the per-page counts,
manifest and runtime boundaries. The same C1 diagnostic source was healthy at
02:52 UTC; protected sync-health remains unresolved. No production change was
made in this follow-up. The seven-day minimum remains 18 September 01:58:33
Moscow; adequate activity and explained coverage/discrepancies are still required.

## Observation — 11 September 05:07 UTC

The cumulative report now contains **18 complete, 49 incomplete and two running
sweeps**, with **85,915 unknown material observations**. Forty-five sweeps lack
certified diagnostics and four hit overlap guards. Two DM runs report lost
diagnostics, three have unknown receipts and eleven failed. One state-change
observation below the virtual stop is retained in an incomplete Lilly-2 sweep;
its subtype is not exported, and the sweep remains outside acceptance.

The same-source worker restart is recorded as a process boundary, preserving
the original observation window. The immediate pool checkout timeout is known;
the underlying cause and any connection to the failed health gate are not.
No runtime change, flag action or privileged EXPLAIN was performed by this
heartbeat. The [observation record](SHADOW-OBSERVATION.md) retains the hashes,
coverage limits and current per-page counts. Savings and fresh-event latency
remain unmeasured.


### Shared runtime/config read — 13 September 11:12 UTC

All three roles remain healthy on `380326368fe3` / `c443947a3569`, with zero
restarts. The signed-in UI shows A0 all six pages, C2b `lilly-1` and recovery
`none`; role application/version and historical continuity remain unknown.
See the [shared observer report](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T110856Z/REPORT.md) for bounded logs, disk,
health and C2b transition-sweep limits. No production or gate change occurred.
