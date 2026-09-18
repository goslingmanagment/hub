# Shared A0/C1/C2b observation — September 14, 05:06 UTC wake

Only bounded read-only production/UI observations and local operational
state/evidence updates ran. No code, tests, GitHub change, deploy, flag,
recovery, replay, provider request, credential or socket action occurred.

## Runtime and current configuration

At **05:08:25 UTC**, API, worker and scheduler remain healthy with zero restarts
on source `380326368fe3`, image `c443947a3569`; start times are unchanged.
Loopback API/database health passes (database latency field 1 ms, not a
percentile). Disk is 78% used with **17.42 GiB** available. The current release's
protected deployment gate remains unknown; a historical owned-release pass is
not reused as its proof. Nothing was deployed or cleaned up here.

The authenticated Chrome configuration UI's ordinary refresh response, generated
at **05:09:34.958 UTC**, reports A0's original six labels at override version 1,
C2b `lilly-1` at version 1 and head catch-up `none` at version 4. All three active
roles report matching running values, last seen 05:08:39–05:09:20 UTC. The API's
`runningState: unknown` is its boolean summary applied to string allowlists;
it does not negate those reported string values. Exact per-role applied versions
and uninterrupted historical continuity remain unproven. No clock is reset.
Only the three non-secret settings and role metadata were retained.

The 3,000-line worker tail covers **01:30:03–05:08:24 UTC**, shorter than the
requested interval. It has no matching diagnostic-sink warning and no failed
sync summaries, but contains terminal HTTP failures in partial media chunks and
two recurring OFAPI continuation errors. Zero failed sync status is not an
error-free interval. The media chunks reach their daily cap; later zero-attempt
partials do not establish provider recovery. These failure classes also appear
in prior retained packets. Other sync/canonicalization work continues; no new
failure class or changed owner action is established. Full detail and limits
are in [runtime review](REVIEW-RUNTIME.md) and `worker-log-summary.json`.

## A0

[Fresh cumulative packet](../activation/20260910T225618Z/snapshot-20260914T050830Z/REPORT.md):
**937 sweeps: 685 complete, 252 incomplete, none selected running**. Every prior
865 row is unchanged; all 72 new sweeps complete, twelve per page. Three new
Lilly-2 exclusion-reason occurrences and 18 repeated missing-hot-head observations
are discrepancies, not identified unique losses or established deletion causes.
Unknown material checks remain 403,215; failed/lost/unknown DM runs remain
34/8/1. HTTP unknown runs increase from four to six, separately from those DM
receipt counters. Null/absent reason coverage and historical incomplete sweeps
remain unresolved.

Cumulative physical attempts are 104,266, up 11,127. The newly dated media-stats
buckets include 393 failed outcomes (386 HTTP 500, seven transport) and 1,173
retry outcomes; the same failure class was present on earlier days. These are
unequal-duration day buckets, not a causal trend or evidence of a new outage.
Neither repeat observations nor nested HTTP/raw/log counters are added together.
Full polling remains unchanged and A0 remains **NO-GO**.

## C1

[Fresh six-page packet](../../fansly-c1-deploy-2026-09-11/followup-20260914T051155Z/REPORT.md):
**2,845 ordered unique rows**, with all 2,604 previous rows unchanged. The 457
valid decisions contain 343 no-request decisions and 114 clean-queue requests;
every request has one later successful exact-generation terminal. The 241 new
rows include 36 valid decisions and ten valid terminal membership receipts.
The same 47 terminal membership gaps remain. Eighteen additional Lora-1 partial
incremental chunks explain the increase in missing final decisions; they are
not eighteen new telemetry failures.

Physical follower attempts total 12,525 (+1,084); no new retry, failed or 429
attempts appear. This does not prove suppression, savings or presence equivalence.
Only the first aggregate is counted; page snapshots are individually consistent,
not globally atomic. The current local PR166 label is corrected to merged using
the retained interactive-work receipt; this heartbeat made no PR change or deploy.

## C2b and disposition

[Fresh C2b packet](/Users/dmitriy/.codex/worktrees/hub-fansly-c2b-shadow/investigations/fansly-c2b-earnings-shadow-2026-09-10/activation/20260912T233234Z/observation-20260914T051301Z/REPORT.md)
at **05:13:03 UTC** is unchanged except its timestamp: 99 valid checks and
receipts on each endpoint, within explicitly incomplete tracked scope. The
September 13 10:53 completion remains the excluded transition. **0 of 2**
qualifying subsequent independent sweeps are available. Baseline zeros do not
prove quiet-correction or missing-roster coverage.

Both bounded observation reports remain pending. A0's earliest seven-day report
stays **September 17, 22:58:33.610 UTC**; calendar age alone will not pass its gate.
C2b keeps its original September 12, 23:38:22.888 UTC clock and transition rule.
No savings, event-to-reader latency or stage acceptance is claimed. Existing
failures and uncovered cases are retained; no new owner action is established.
Keep the shared heartbeat and schedule unchanged. Final decision: **DONT_NOTIFY**.

Independent reviews are complete: [A0](REVIEW-A0.md), [C1](REVIEW-C1.md),
[C2b](REVIEW-C2B.md) and [runtime](REVIEW-RUNTIME.md). No actionable finding
remains after correcting the current C2b configuration aliases. The shared
report was also independently checked for consistency. `completion-manifest.json`
pins the final report, local state snapshots and source packets.
