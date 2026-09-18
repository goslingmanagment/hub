# Retained reply replay — all six page cohorts accepted

PR162 is deployed on all three roles at `8b25d57e5d1343271177426ee9caf644cb1ee5c0`.
Every authorized replay is complete, and the final Lilly-1 gate passed at
9 September 2026 21:16:10 UTC. All original **994 positive reply IDs** and
**27 attached messages** match retained source material. All **2893 original
message observations** were confirmed v6 with no unavailable body in the
successive per-page censuses. No replay was repeated to resolve a serving delay.

| Page | Original observations at v6 | Original positive IDs | Attached messages |
|---|---:|---:|---:|
| ari-1 | 128 | 9/9 | 0 |
| lora-3 | 31 | 54/54 | 1 |
| lora-2 | 43 | 63/63 | 2 |
| lora-1 | 170 | 143/143 | 1 |
| lilly-2 | 826 | 409/409 | 13 |
| lilly-1 | 1695 | 316/316 | 10 |
| Total | 2893 | 994/994 | 27 |

Each page retains its full original ID set. Checks cover archive source,
parent/root and canonical parent/root, normalized text, media count, stable
metadata and direct raw media refs. Earlier positive reads keep their own
timestamps. This is not an atomic snapshot, full threads, all later changes or
explicit clears, a media-file preservation audit or fresh-event percentiles.
All six original diagnostic examples freshly passed at 20:53–20:54 UTC,
including the already populated Lilly-2 parent. Ari's original nine IDs also
freshly passed at 19:16–19:17.

Lilly-2: replay 1094.234 seconds, 826 scanned/stamped, 9963 appended and
14127 deduplicated. One serving transport error was retained; only unfinished
or unmatched groups continued after health recovered. Five roots lagged until
ordinary archive progress; all409 passed serving by20:02:55 and material by
20:03:31. Historical repair confirmation bound: 50m52s from write start,
32m38s after write finish. It is not a fresh-event latency target.

Lilly-1: replay 1665.770 seconds, 1695 scanned/stamped, 14192 appended and
22783 deduplicated. Post-write source census passed at20:37:46. Eight initial
reply mismatches fell to five, then three, then zero. All316 passed by21:15:25;
all112 exact source receipts and full material checks passed at21:16:03,
including10 attached messages. Historical repair confirmation bound: 66m40s
from write start, 38m54s after write finish. All scope writes had zero errors,
skips, binding/partition blockers and no truncation.

The original null-root comparator was retained and superseded by
check-material-v2.mts: null replyMetadata is equivalent to a null root only for
an actually returned message. Missing-message and non-null-root guards remain.
The acceptance helper requires the original material ID set and successful
replay exit. Independent review found no actionable findings; local guard
positive/negative cases passed. No privileged production probe was executed.

All roles remain healthy on the approved image at21:16:01, zero restarts,
29GiB free; loopback health passed. Long projection/canonicalization passes and
the slow sync-health endpoint remain unresolved. Current Lilly-2 known-head
recovery is a separate owner gate; A0/T0 has not started.
See [release and stage report](../fansly-pr162-release-2026-09-09/REPORT.md),
[prepared canary](../fansly-lilly2-head-canary-2026-09-10/PROPOSAL.md),
`evidence/operation-status.json`, and each page's acceptance evidence.

## Historical execution record (superseded by current state)



Current state at 10:46 UTC on 9 September 2026: owner-approved PR161 deployment
completed on `34d897779fd004336e114333501f284f1faeefc1`; all three roles are healthy,
zero restarts, 29 GiB free. The exact lora-1 read still returned 503 in 14.545 s.
PostgreSQL logs identify the main list SELECT as the timed-out statement; count
failed afterward in the aborted transaction. The 140 earlier successful targets
retain their original timestamps. Neither Lilly preview nor write has started.
Remaining replay authorization persists behind the original lora-1 acceptance
gate. No head-recovery flag was enabled; A0/T0 has not started.

One prepared plan-only EXPLAIN passed a local Docker-Postgres test. Its production
attempt as read_only was denied table permission. The next gate is a narrow
role exception for that fixed SQL, not another deployment or replay approval.
See [current deployment report](../fansly-pr161-deploy-2026-09-09/REPORT.md) and
[exact diagnostic proposal](../fansly-pr161-deploy-2026-09-09/exact-plan-probe/PROPOSAL.md).
Earlier dated evidence below is historical and does not supersede this status.

Current state at 20:54 UTC on 8 September 2026: two pages accepted, one serving
acceptance blocked, two pages not started. No new deployment or flag change.
The owner's `\+` authorized this sequential scope; remaining replay permission
persists, but the original per-page acceptance gate prevents proceeding to Lilly.

| Page | Replay observations | Reply targets verified | State |
|---|---:|---:|---|
| lora-3 | 31/31 v6 | 54/54 | Accepted; 39 missing parent/root pairs repaired |
| lora-2 | 43/43 v6 | 63/63 | Accepted |
| lora-1 | 170/170 v6 | 140/143 | Three targets in one conversation blocked by Agent read timeout |
| lilly-2 | No manual preview or write | Not accepted, 409 expected | Wait for lora-1 acceptance |
| lilly-1 | No manual preview or write | Not accepted, 316 expected | Wait for preceding page acceptance |

The 257 accepted targets in this five-page scope preserve parent/root refs,
normalized text and stable/direct raw media refs, including four nonempty
attachment messages. With the earlier ari 9/9 acceptance, 266/994 original
positive targets are verified across timestamped reads. Three are blocked and
725 are not accepted; this is not full-cohort or general conversation acceptance.
The 27-message attachment cohort remains incomplete. Final rereads of the six
original diagnostic IDs and ari are prepared but have not run in this operation.

Lora-3 write took 71.738 s; complete serving confirmation was within 7m05s of
write start or 5m52s after finish. Lora-2 write took 80.313 s; confirmation within
4m20s of start or 2m59s after finish. Lora-1 write took 267.020 s; full serving
confirmation remains open. These sampled bounds are not fresh-event percentiles.

A separate code fix is prepared in worktree `hub-agent-transcript-window`, branch
`fix/agent-transcript-window`, Decision 281: bound transcript material to window
candidate refs while preserving all source versions. Local Postgres wide
candidates fell from 20596 to 2 for the narrow reproduction, with identical
output; no complete production RCA is claimed. Docker PG 120 tests, pnpm check
and production build passed; independent review of PR #161 and its final docs
found no blockers. All five CI checks passed; it merged at 21:07:12 UTC as
34d897779fd004336e114333501f284f1faeefc1. The merged tree exactly matches the
reviewed final tree. A new deployment
requires a separate owner yes. The existing sync-health timeout is still open.

At 20:53, API/worker/scheduler were healthy with zero restarts and 30 GiB free;
loopback health passed (DB 10 ms). Authenticated Configuration at about 20:54
showed catch-up running/editor `none`, Save disabled. At 20:53:55 no parse-zero
rows existed in the five inspected pull families, while historical v5 DM and
earnings remained 40206 and 14204. This is a single backlog sample, not a
freshness distribution. Whole-database size was 32792124439 bytes at 20:53:34,
up 44171264 bytes from 20:01:50 across concurrent activity; not replay-only cost.

A0/T0 and the seven-day shadow clock have not started. No physical-attempt
baseline, HTTP savings or event-latency distribution has been measured; the
>=50% target is not claimed. Lilly-2 known-head recovery remains off and separate.

## Timestamped execution record

The entries below preserve the sequence of observations and intermediate states.
The current state above supersedes earlier next-step statements.


Owner-approved operation in progress. Scope and boundaries are in AUTHORIZATION.md. Reviewed deployed image 18649bd95f3b was independently verified from the image label at 19:58 UTC; all runtime roles use that same image, are healthy with zero restarts, and disk has 30 GiB free. Loopback health passed. Catch-up running/editor none, Save disabled, was confirmed through authenticated Configuration; no flag edit occurred.

All-source census at 19:56:44 UTC confirmed the same 2765 pull/v5 observations with available bodies. Inspected event partitions are attached. Local clean worktree and production-pinned CLI match full commit 18649bd95f3bedb812847343d27fdeedf8b5d32f. All production SQL uses read_only, BEGIN READ ONLY and bounded statement timeouts.

The first lora-3 baseline transcript read encountered service_unavailable / agent read timed out for three targets spread across an 11-hour window. It stopped immediately; eight IDs had been read successfully. Following the endpoint's remedy, the new comparison groups exact targets by minute and keeps one request in flight. No failed request is blindly retried and both evidence directories are retained.

Lora-3 preview passed: 31 scanned, 1369 candidate drafts, zero stamped; zero errors, skips, binding or partition blockers and no budget truncation. The one approved lora-3 write ran 20:02:39.213–20:03:50.952 UTC (71.738 seconds), exit 0: scanned/stamped 31, appended 653, deduped 747, zero errors/skips/binding/partition blockers, not budget-truncated. The 31 extra checkpoint drafts explain 653 + 747 = 1369 + 31. Lora-3 is now accepted; lora-2 preflight/preview is next.

Full bounded acceptance must compare all 985 remaining reply targets, including the 27 nonempty attachment messages. It will retain normalized text hashes and stable media metadata, preserving transcript coverage blockers. Source stamps do not prove serving repair. A0/T0 and the seven-day clock have not started; HTTP savings and event-latency percentiles are unmeasured. Lilly-2 known-head recovery remains separately gated and off.

The narrowed lora-3 baseline completed at 20:01:14 UTC with 54/54 IDs in archive, parent/root 15/54, normalized text and stable media 54/54. Its one attachment message matched. Pure local canonicalization of 17 exact retained source observations produced the expected reply material for all 54 targets. Before the first write, database size at 20:01:50 was 32747953175 bytes; this is a whole-system measurement.

Lora-3 accepted at 20:10:07 UTC: 54/54 parent/root, normalized text, stable media metadata and direct raw attachment refs match. Its 39 missing parent/root pairs were repaired. The last serving confirmation completed at 20:09:43, within 7m05s of write start or 5m52s after completion. Checks span several reads: already-passed groups retained their read timestamps while only pending groups were reread. This is a sampled bound, not atomic fleet state or a latency percentile. The 20:04:10 read-only census confirmed all 31 window observations at v6. Evidence: evidence/lora-3/accepted.json and after-pass3/.

Lora-2 fresh preflight at 20:10:13 UTC found 43 pull/v5 observations and no unavailable bodies. Preview passed in 25.468 seconds: 43 scanned, 2227 candidate drafts, zero stamps, zero errors/skips/binding/partition blockers. The one approved write ran 20:10:54.828–20:12:15.142 UTC (80.313 seconds): scanned/stamped 43, appended 1097, deduped 1173, zero errors or blockers, no budget truncation. Checkpoint accounting: 1097 + 1173 = 2227 + 43. Archive acceptance is in progress.

Lora-2 accepted at 20:15:45 UTC: all 63 parent/root, normalized texts, stable media and direct raw attachment refs match; both nonempty attachment messages pass. All 43 observations were independently v6 at 20:12:41. The accepted serving pass completed at 20:15:14, within 4m20s of write start or 2m59s after completion. Source checks cover 19 exact retained responses. Earlier full-cohort serving measurements are historical; no fresh lora-2 pre-write full baseline was taken, so the whole improvement is not attributed solely to this manual replay.

The shared queue sample at 20:17:06 UTC had five parse-zero DM responses (oldest 20:08:26, about 8m40s), one earnings, 58 monthly and 57 stats. Historical v5 DM/earnings decreased to 40925/14504. Both lanes continue to progress; this is capture-to-canonicalization backlog age, not archive latency. A background sweep completed at 20:12:46 in 622.028 seconds, 966 stamps, zero parser/body/partition failures and 4000 unmapped visits; its 600-second budget was exceeded. Archive sweeps continued, including 20:13:23 and 20:14:35. These are shared background measurements, not isolated replay cost.

Lora-1 fresh census at 20:15:49 confirmed 170 pull/v5 observations, available bodies and attached inspected partitions. Preview passed in 33.177 seconds: 170 scanned, 8485 candidate drafts, no stamps or blockers. The one write ran 20:16:37.514–20:21:04.535 UTC (267.020 seconds): scanned/stamped 170, appended 4215, deduped 4440, zero errors/skips/binding/partition blockers, not budget-truncated. Checkpoints account for 4215 + 4440 = 8485 + 170. A read-only progress sample during the write at 20:19:41 independently showed 107 already v6 and 63 still v5. Archive acceptance is now in progress.

The recurring egress_pacer_shadow CLI log was traced locally to the approved runtime bootstrap: createAppContext calls getCredentialPreflight, which uses OFAPI GET /whoami when an expected team is configured. Thus the standard command includes an OFAPI credential-control preflight; it must not be described as globally zero-HTTP or wholly database-only. The scoped Fansly DM canonicalizer itself reads retained observations, and no Fansly history re-fetch or live socket command was run. Physical request totals, including retries, remain unmeasured. Source: deployed bootstrap.ts:409 and services/ofapi.ts:845.

Lora-1 first post-write scan stopped on a 503 service_unavailable timeout after 69 exact IDs. The refused request targeted one message at 2026-09-07T00:04:58Z with a two-second window. No Lilly write was dispatched. The 69 readable messages preserved normalized text and stable media; 29 parent/root pairs already matched. All 55 cohort source observations were independently v6. Following the endpoint remedy, the next pass narrows the timestamp margin from one second to one millisecond, retains the 29 fully accepted targets with original read times, and reads pending groups only. Worker state also changed: archive passes completed at 20:25:08 and 20:25:33 after the timeout. The first pass and refused group remain in evidence; acceptance stays open until all targets pass.

The same lora-1 transcript failed again at the 2 ms window: conversation 790634843078664193, message 953135194070597632. The API logged HTTP 503 in 10.502 seconds at 20:27:41, consistent with the unchanged 10-second Agent read statement limit; the log does not identify which subquery timed out. Read-only grants on page_dm_threads, page_dm_messages, message_archive and dm_message_archive are all absent; no role bypass or direct base-table read was attempted. A separate authorized Hub thread-inventory read succeeded and identifies this conversation as the largest on lora-1, storedMessageCount 10298, raw coverage partial_window. Narrow-window transcript SQL currently builds wide candidates from the whole conversation before applying its time filter; this is a code-backed performance hypothesis pending local reproduction, not a certified production execution-plan RCA.

All other lora-1 threads were verified separately: 140/140 target IDs, parent/root, normalized text and stable/raw media refs match; the one attachment message passes. Three targets in the timed-out conversation remain explicitly unaccepted. The reduced cohort is labelled after-other-threads and cannot close the full 143-target gate. Both Lilly pages remain unstarted. Local investigation of the read blocker is now isolated in worktree hub-agent-transcript-window, branch fix/agent-transcript-window based on main 18649bd9. No new deployment is authorized.


## Stage state at 2026-09-08 21:07 UTC (historical)

| Stage | State | Measured savings / latency | Remaining gate |
|---|---|---|---|
| Pre-A0 stale known head and lilly-2 queue | PR157 deployed; ari known head archived; second ari target unresolved; lilly-2 catch-up off | Historical exact ari capture: 188.695 s after canary activation; no fleet distribution | Scoped head-recovery approval and source/serving acceptance |
| Pre-A0 reply material / honest sweep | PR158/159/160 deployed; 266/994 original targets verified across timestamped samples; PR161 merged as 34d89777; deploy awaits new yes | Lora-3 serving within 7m05s of replay start; lora-2 within 4m20s; no HTTP savings measured | PR161 deploy yes, three blocked lora-1 reads, remaining approved Lilly scopes and full freshness acceptance |
| A0 + T0 | Not started | No shadow clock or physical-attempt baseline | All prerequisites accepted, retained offline corpus, then >=7 full shadow days on all six pages |
| C1 | Not started | Unmeasured | After A0 starts; diagnostic trigger counts before narrow fix |
| C2a | Not started | Unmeasured | Correctness and retained repair acceptance |
| C2b | Not started | Unmeasured | C2a; semantic dirty/receipt shadow, daily rotation retained |
| C2c | Gated | Unmeasured | Coverage, per-fan max-age and cost evidence |
| W0 | Not started | Unmeasured | Management Session fixtures; separate explicit approval for live socket probe |
| B0 | Not started | Unmeasured | W0, capture-only receiver, >=7 days and sufficient event diversity |
| B1 | Not started | Unmeasured | B0/T0, delivery lag, added attempts and history fairness evidence |
| A1 | Separate owner/calendar/evidence gate | Unmeasured | A0/T0 safe-stop and freshness evidence; independent of WS |
| B2 | Not authorized | Unmeasured | Separate owner decision; do not build by default |

The >=50% savings goal is not claimed. Quiet-state freshness, old edits/deletes,
outage gaps, explicit reply clears/later revisions in production, the complete
attachment cohort, broad conversation coverage and Management Session socket
coverage remain unproven. Provider-deleted head repair remains outside A0; the
planned shadow only counts the discrepancy. Concrete next gate:
[deploy PR161 and resume acceptance](PR161-DEPLOY-APPROVAL.md).


At 21:07:12 UTC, PR161 merged after all five CI checks passed and independent
review confirmed both the implementation and final documentation. The clean
worktree is pinned to 34d897779fd004336e114333501f284f1faeefc1; its tree equals
reviewed 6488e0bbbb63112f2588e938bd4f17b269c8716b. Source/deployment and cohort
gates are in PR161-DEPLOY-APPROVAL.md. No deployment has started. An offline
negative check also proved accept-page.py rejects the 140-target reduced
cohort before any acceptance write; the prepared resume retains all 143 IDs.

The production build was also rerun successfully on merged revision 34d897779fd004336e114333501f284f1faeefc1. The worktree is clean; the compiled candidate is ready, and production has not been changed. Evidence: evidence/pr161-merged-build.log.
