# Lilly-2 known-head canary — active

The owner's approved one-hour canary was activated on **10 September 2026**.
Only `fanslyDmHeadCatchupPageAllowlist` changed: **`none` → `lilly-2`** through
the normal signed-in Configuration save. No deploy, reset, replay, manual
provider fetch or socket operation occurred.

| Operation | UTC | Moscow |
| --- | --- | --- |
| Save dispatch recorded | 15:28:32.701805 | 18:28:32.701805 |
| All-role convergence evidence recorded | 15:31:04.584644 | 18:31:04.584644 |
| Approved return to `none` deadline | **16:28:32.701805** | **19:28:32.701805** |

The deadline conservatively starts immediately before the save click. The UI
subsequently showed running/editor `lilly-2`, all three roles active, no drift,
no pending-apply indicator and no conflict/error. It briefly showed worker and
scheduler applied while the API still reported `none`; convergence was then
verified. This record does **not** prove a sub-60-second propagation SLA.
The UI does not expose the numeric override version; its normal save used the
dashboard's current expectedVersion. No CAS bypass was used.

## Measurements

- At 15:26:47 UTC, before activation: **2,959 captured, 104 pending, zero
  eligible visible/resolved/unexcluded targets**. Pending debts comprise 93
  hidden and 11 other excluded visible targets. No exhausted target is present.
- The original eight later targets had already been recovered by ordinary
  collection before this canary. Their unchanged full set passed exact
  archive/source text, parent/root and media checks earlier today, independently
  reviewed without findings. They cannot be credited to this flag.
- API, worker and scheduler are healthy on the same approved PR162 image.
  Restart counts remain 0/0/1, free disk 28 GiB, loopback health OK. The
  scheduler's single earlier restart is unchanged, not caused by activation.
- Before activation, completed Fansly summaries in 15:10–15:26 UTC contain
  **95 unique page/stream/run IDs, 398 attempts, zero retries and zero terminal
  failures**; Lilly-2 list has 115 of those attempts. No completed Lilly-2 DM
  summary is present. These are scoped completed-run summaries, not T0 or a
  savings baseline.
- First post-save read at 15:29:40 UTC: same debt counts, zero new Lilly-2 DM
  receipts in the explicit 15:28:32.701805–15:29:20 window, no stream failures
  or blockers. The list's latest success was 15:28:14 UTC (before activation),
  messages 07:39:14 UTC. No post-activation full-list completion is proven yet.
- The first short post-save log window contains seven completed Fansly run
  summaries, 30 attempts, no retries/terminal failures. Attempts can have begun
  before that window. **No recovery-specific effect or savings is measured.**
- Review found the local log filter was omitting the warning's `breaches`
  metric names. The filter is fixed; bounded baseline and post-activation log
  rereads restored their identity. All 16 baseline warnings and four warnings
  through 15:32:30 UTC identify only `obs_backlog_webhook_ofapi_v5`. There is no
  new breached metric in that scope. Global freshness and event-delivery
  latency remain unaccepted; a quiet canary with no eligible work cannot
  establish the recovery path's efficacy. See `evidence/baseline-signal-identity.json`
  and `evidence/post-activation-signal-identity.json`.

Evidence: `evidence/resume-1526`, `evidence/after-activation-1529`,
`evidence/activation-dispatch.json`, `evidence/activation-verified.json`.
Earlier exact target acceptance: `PRE-ACTIVATION-REPORT.md` and its review.

First full five-minute window, 15:28:32.701805–15:33:32.701805 UTC, was read at
15:33:48–53 UTC. Debt remains 104 pending / zero eligible, no new Lilly-2 DM
receipt, no stream failure or blocker. There are **46 completed Fansly run
summaries, 192 attempts, zero retries and zero terminal failures** across pages;
none is a Lilly-2 list or message completion. All three roles remain healthy,
restart counts unchanged. The warning metric remains only
`obs_backlog_webhook_ofapi_v5`; this compares metric identity, not latency
magnitude. Evidence: `evidence/first-five-minutes`. The earlier short window
overlaps this one; never add their totals together.

Independent local review (`review_pr162`) found the missing `breaches` field.
The fix and recovered bounded log evidence were re-reviewed: finding closed,
no outstanding findings. Product/runtime code was not changed by this fix.

## Monitoring and approved rollback

Active task heartbeat **`fansly-lilly-2`** checks every five minutes and has the
exact UTC deadline in its prompt. The final scheduled check before the deadline
must remain in the task until the approved return; it must not defer rollback
to the 16:30 tick. `STATE.json` records the actual operation and next unread
measurement interval. Each `snapshot.py` invocation uses a new evidence folder,
an explicit bounded UTC window and read_only/READ ONLY with the existing
20-second statement timeout. Inspect actual reports, not only exit codes.

Return to `none` at the deadline or earlier under `PROPOSAL.md`'s abort
conditions, preserve conflicting operator edits and verify all-role convergence.
An in-flight request may finish; retain receipts, debts and ordinary history
cursors. Pause the heartbeat after verified rollback and final acceptance
report. No new owner approval is needed for this return.

## Stage position

| Stage | State | Savings / latency |
| --- | --- | --- |
| Known-head prerequisite, [PR157](https://github.com/goslingmanagment/core/pull/157) | Previously reviewed, tested and deployed | No savings measurement |
| Reply prerequisite / serving fix, [PR162](https://github.com/goslingmanagment/core/pull/162) | Previously deployed; all 994 original IDs and 27 attached messages accepted | Historical repair bounds in release report; no fresh-event SLO claim |
| Lilly-2 canary | **Active, timed rollback pending** | No recovery-specific effect yet |
| A0 / T0 | Not started; shadow clock has not begun | Unmeasured |
| Later stages | Original stage order and gates preserved; B2 requires separate decision | Unmeasured |

No new product code or PR was needed for this flag operation. Prior `pnpm check`
and Docker-Postgres results remain in PR157/PR162 and `PROPOSAL.md`. Outstanding
coverage includes eligible recovery under real activity, excluded/unresolved
heads, provider-marker discrepancies, full-history completeness and measured
freshness/savings. This canary does not authorize A0/A1 activation.

## Scheduled control at 15:35 UTC

Read at 15:35:41–47 UTC for the next non-overlapping window ending 15:35:19.
No actionable change: 104 pending debts, zero eligible, zero new Lilly-2 DM
receipts, no stream failure/blocker. All three services remain healthy on the
approved image, disk 28 GiB and restart counts unchanged. Five further completed
Fansly run summaries contain 20 attempts with zero retries/terminal failures.
The deduplicated series since activation is 51 summaries / 212 attempts; these
are not recovery-specific and do not prove savings. The same warning metric
`obs_backlog_webhook_ofapi_v5` persists; a canonicalization sweep completed in
11.927 seconds. No new breached metric was seen; latency magnitude/completeness
is not accepted. Evidence: `evidence/monitor-1535`, cumulative identities from
`STATE.json.monitoring_snapshot_series`. Canary remains active, deadline unchanged.

## Scheduled control at 15:40 UTC

Read at 15:41:02–07 UTC; interval 15:35:19–15:40:48. No actionable change: 104
pending / zero eligible, no new Lilly-2 DM receipts, no stream failures/blockers.
All roles remain healthy on the approved image, disk 28 GiB, restart counts
unchanged. Live Configuration confirms running/editor lilly-2 with all roles
active and no drift. Seventeen further completed Fansly summaries contain
74 attempts, zero retries/terminal failures. Cumulative deduplicated series:
68 summaries / 286 attempts, not recovery-specific. No post-activation Lilly-2
list/message completion is proven yet. The only breached metric remains
obs_backlog_webhook_ofapi_v5; message-archive sweeps continue and six completed
canonicalization sweeps took12.122–14.778s (not event latency). Evidence:
`evidence/monitor-1540`. Deadline unchanged; no owner action needed.

## Scheduled control received at15:46 UTC

The15:45 heartbeat arrived15:46:38; reads completed15:47:02–07. Full interval
15:40:48–15:46:49 retained, with no monitoring-window gap. Debt remains104
pending/zero eligible and no new Lilly-2 DM receipts; list is now pending,
without failure/blocker, still no completed postactivation list/message run.
Allroles healthy, same image/restarts,28GiB free; UI still running/editor
lilly-2 with allrolesactive/no drift.35 further completed Fansly summaries
contain160attempts,0retries/terminalfailures. Cumulative deduplicated series:
103summaries/446attempts, not recovery-specific. Existing warning metric
obs_backlog_webhook_ofapi_v5 only; archive sweeps and six canonicalization
sweeps(12.853–14.933s) continue. Evidence:`evidence/monitor-1546`.
No abort condition established; rollback deadline unchanged.

## Scheduled control received at 15:52 UTC

The 15:50 heartbeat arrived at15:52:08; reads at15:52:33–38 cover the full
15:46:49–15:52:19 interval. Still104pending/zero eligible and zero new Lilly-2
DM receipts; no failures/blockers. Ordinary list collection is running: ten
completed pagination-chunk summaries report50attempts, but the latest full-list
success remains15:28:14(beforeactivation). Do not treat chunks as full sweeps.
Across Fansly,27further summaries/113attempts,0retries/terminalfailures; cumulative
130summaries/559attempts, not recovery-specific. Allroleshealthy,28GiBdisk,
restartsunchanged. The initially stale UI heartbeat display was refreshed and
now shows current15:52signals, running/editorlilly-2, no drift. Same pre-existing
warningmetric; archive and canonicalization continue. Evidence:`evidence/monitor-1552`.
No abort condition established; deadline unchanged.

## Scheduled control at 15:55 UTC

Reads at 15:56:03–08 cover 15:52:19–15:55:48 UTC. No material change: 104
pending debts, zero eligible, zero new Lilly-2 DM receipts, no failures or
blockers. Ordinary list collection continues; eight further completed list
chunks contain 40 attempts. No full-list completion after activation is proven.
Across Fansly, 12 further summaries contain 49 attempts, zero retries and zero
terminal failures. Cumulative deduplicated series: 142 summaries / 608 attempts,
not recovery-specific. Runtime remains healthy, 28 GiB free and restart counts
unchanged. Refreshed UI confirms current role signals and running/editor lilly-2.
Only the pre-existing warning metric persists; archive/canonicalization continue.
Evidence: `evidence/monitor-1555`. No abort condition established; deadline unchanged.

## Scheduled control at 16:00 UTC: first full list completed

Read at 16:00:59–16:01:05, interval 15:55:48–16:00:46. The first ordinary
full list after activation succeeded at **15:59:45.911 UTC**. Its final HTTP
summary (run718962, 15:59:45.917) is success; the preceding chunks were partial.
The monitored list series so far has29 chunks /142 attempts. This is ordinary
list traffic, not extra recovery traffic or a savings result. Debt is unchanged:
104 pending, zero eligible, zero new DM receipts. No new target was available
for the recovery path. Across Fansly, 26 further summaries /116 attempts, zero
retries or terminal failures; cumulative168 summaries /724 attempts. All roles
healthy,28GiB free, restarts unchanged; refreshed Configuration is lilly-2 with
all roles active/no drift. The same pre-existing warning metric persists and
archive/canonicalization continue. Evidence:`evidence/monitor-1600`. No abort
condition established; return to none remains16:28:32.701805 UTC.

## Owner status refresh at 16:03 UTC

Read at 16:03:11–16 for interval16:00:46–16:02:45. Same104pending/zero eligible,
zero new DM receipts and no stream failure/blocker. Allroles remain healthy on
the approved image,28GiB free, restarts unchanged.21 further completed Fansly
summaries contain85attempts,0retries/terminalfailures. Cumulative189summaries/
809attempts; no recovery-effect or savings claim. Same pre-existing OFAPI
backlog warning. Evidence:`evidence/status-1602`. Canary remains active;
approved return deadline16:28:32.701805UTC.

### 16:05 UTC interval, inspected at 16:09 UTC

Read-only evidence `evidence/monitor-1605` covers 16:02:45–16:05:48 UTC. Queue remains 2959 captured / 104 pending / 0 eligible; zero new DM receipts. Last full list success 15:59:45.911 UTC; both DM streams have no failure/blocker. All roles healthy on the approved image, restarts 0/0/1, 28GiB free. Eighteen completed summaries report 75 attempts, zero retries and terminal failures; deduplicated cumulative total is 207 summaries / 884 attempts. This is not T0 or savings. Archive/canonicalization progress continues; the existing OFAPI backlog alert and a transaction early-stop warning are visible. Configuration observed at 16:09 UTC has fresh signals, all roles active and running/editor lilly-2. Deadline remains 16:28:32.701805 UTC; A0 is not started.

### 16:11 UTC interval

`evidence/monitor-1611` covers 16:05:48–16:11:51 UTC. Same 104 pending IDs and eligibility/exclusion fields, 2959 captured, zero eligible and new DM receipts. Full-list success remains 15:59:45.911 UTC; both DM streams have zero failures/blockers. All roles healthy, same image/restarts, 28GiB free. Forty-five completed summaries report 165 attempts, zero retries/terminal failures; cumulative deduplicated 252 summaries / 1049 attempts. No retry/failure trace rows. Archive and canonicalization sweeps progress; only warning metric remains obs_backlog_webhook_ofapi_v5. UI refreshed at 16:12 UTC: all roles active, running/editor lilly-2, no drift. No abort evidence. Approved rollback deadline unchanged; no T0, savings, recovery-effect or freshness acceptance.

### 16:15 UTC interval

Evidence monitor-1615 covers 16:11:51–16:15:29 UTC. Queue remains 2959 captured / 104 pending / 0 eligible, no new DM receipt. All roles healthy, 28GiB, unchanged restarts. 31 completed summaries / 130 attempts / zero retries and terminal failures. Archive/canonicalization progress continues; only prior OFAPI backlog warning metric. Cumulative 283 summaries / 1179 attempts, not T0 or savings. Rollback deadline unchanged. Owner requested remaining development; A0 implementation started separately, runtime shadow remains off.

### 16:20 UTC interval

Evidence monitor-1620 covers 16:15:29–16:19:58 UTC. Same queue and no new DM receipts; a second ordinary list sweep is running since 16:20:07.457 UTC. Runtime healthy, unchanged restarts, 28GiB. 43 completed summaries / 187 attempts / zero retries and terminal failures; cumulative 326 summaries / 1366 attempts. Archive progress continues; prior OFAPI backlog warning and ordinary transaction early-stop warning remain. UI refreshed at 16:22 UTC confirms all-role lilly-2, no drift. Deadline unchanged.

### 16:25 UTC interval

Evidence monitor-1625 covers 16:19:58–16:24:52 UTC. No queue or receipt change. The ordinary list sweep continues between chunks; last full success remains 15:59:45.911 UTC. Healthy all roles, unchanged restarts, 28GiB; archive/canonicalization progress and prior OFAPI backlog alert continue. 14 completed summaries / 64 attempts / zero retries and terminal failures; cumulative 340 summaries / 1430 attempts. No abort evidence. Remaining in active turn for the exact rollback deadline.
