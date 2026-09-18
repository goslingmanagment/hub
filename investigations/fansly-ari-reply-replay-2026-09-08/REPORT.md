# Ari-1 reply replay — accepted

The approved ari-1 replay passed production acceptance on 2026-09-08 at 19:04:21 UTC. All nine fixed reply messages are served from the archive with the correct parent, root and normalized text. Four missing parent/root pairs were repaired; the five already correct pairs survived. All 128 approved observations are independently confirmed at parser v6. This closes the ari subset, not the remaining 985 reply targets or the full pre-A0 prerequisite.

The owner approved the prepared preview and one scoped replay on deployed revision 18649bd95f3bedb812847343d27fdeedf8b5d32f. Scope: account 10 / ari-1, kind dm_messages, received window [2026-09-07T01:45Z, 2026-09-08T01:45Z), parser v6. The authorization record is [AUTHORIZATION.md](AUTHORIZATION.md). No wider replay or recovery activation is included. All times below are UTC.

| Acceptance check | Before | After |
|---|---:|---:|
| Exact targets served from archive | 9/9 | 9/9 |
| Parent matches retained source | 5/9 | 9/9 |
| Root matches retained source | 5/9 | 9/9 |
| Normalized text matches retained source | 9/9 | 9/9 |
| Source attachments / serving media | All empty | All empty |
| Approved observations at v6 | 0/128 | 128/128 |

The accepted serving scan completed at 19:04:21.524. Evidence: [acceptance assertions](evidence/acceptance-check.json), [before serving](evidence/serving-before/reply-serving-summary.json), [accepted serving](evidence/serving-second-pass/reply-serving-summary.json) and [v6 census](evidence/progress-first.txt). Earlier directories named serving-final and serving-next-pass are historical intermediate checks; serving-second-pass is the accepted scan. Transcript coverage blockers remain in the evidence: exact positive IDs do not prove general conversation completeness, nonempty attachment parity or explicit clears.

The write took 110.558 seconds. All nine targets were confirmed within 14m39s of write start, or 12m49s after write completion. These are sampled upper bounds for this repair, not exact application latency, a percentile or a fresh-event SLA.

At 19:05:27 API/worker/scheduler remained healthy on 18649bd95f3b with zero restarts and 30 GiB free. Loopback /health was OK, DB probe 269 ms. At approximately 19:08 authenticated Configuration still showed catch-up running/editor none, Save disabled. The browser connection was renewed after a disconnect; no flag edit occurred. The separate sync-health timeout remains unresolved and was not repeated. Evidence: [runtime after](evidence/runtime-after.txt), [flag after](evidence/flag-after.txt).

## Operation and intermediate checks

At 18:47 UTC all runtime roles were healthy on the approved revision with zero restarts, 30 GiB free and loopback health OK. The all-source census contained exactly 128 pull observations at v5 and zero unavailable bodies; no other source matched this command scope. Inspected event partitions were attached. The authenticated Configuration UI showed running/editor catch-up none, Save disabled. Production-pinned Hub CLI capabilities returned ok. SQL reads used read_only, BEGIN READ ONLY and 15/20-second timeouts; preflight transactions committed.

Fresh five-kind sync-pull backlog before replay: 103 zero observations (95 DM, seven earnings, one purchase-history) and 287463 v5 observations. Oldest zero DM receipt was 18:16:06.254 UTC, about 31 minutes before the 18:47:21 sample. This improvement from the earlier four-hour lag occurred under ordinary background replay before the scoped operation; it is not attributed to this operation.

The pre-replay serving comparison completed at 18:48:09 through production Hub CLI: all nine fixed ari targets in archive, parents 5/9 and roots 5/9 matching retained sources, zero unread/failed groups. All nine normalized texts matched the retained source in a separate read at 18:49:16; every source observation was still v5. The bodies were held only in process memory; evidence stores metadata/hashes. Coverage blockers delivery_not_exhausted are retained, so these exact-ID checks do not prove general thread completeness.

Dry-run started 18:48:33.553 and completed 18:49:05.190 UTC in 31.637 seconds, exit 0: scanned 128, candidate drafts 2764, stamped 0, no errors/unavailable/unparseable/unmapped/partition blockers or binding conflicts. Dry-run does not perform the write's dedup check, so 2764 is a candidate count, not expected new events. The structured gate passed before the single write was dispatched at 18:49:42.238 UTC. It finished at 18:51:32.796 in 110.558 seconds, exit 0: scanned/stamped 128, appended 1487, deduped 1405, no skipped facts, errors or binding/partition blockers. The write counts include 128 mixed-family observation checkpoints, which dry-run candidate counting omits; 1487 + 1405 = 2764 + 128. At 18:52:27 all 128 scope observations were independently v6 with zero unavailable bodies. Evidence: preview-meta.json, preview-result.json, preview.log, replay-meta.json and replay.log under evidence/.

At 18:53:04 the whole fresh queue had declined further to 21 zero observations (18 DM and three earnings); oldest zero DM receipt was 18:46:31.715, about 6.6 minutes old. This is shared background progress during the operation, not an isolated causal measurement. The first post-replay serving scan completed at 18:53:14: all nine targets in archive, but parent/root still 5/9 before a completed archive sweep appeared in the exported window; acceptance was not yet complete.

The implementation is [PR158](https://github.com/goslingmanagment/core/pull/158), with fresh capture scheduling from [PR159](https://github.com/goslingmanagment/core/pull/159) and deployed through [PR160](https://github.com/goslingmanagment/core/pull/160). No implementation changed for this operation, so previous checks were not rerun. PR158 had independent review with findings fixed, pnpm check (3103 passed, nine existing skips) and 55 Docker-Postgres integration tests without skips. Those tests prove v5-to-v6-to-serving repair, field-clock handling of sparse/stale material and explicit clears, text preservation, dedup and rebuild convergence. They are not a substitute for this production acceptance. PR159 passed 3110 unit tests with nine existing skips and 50 Docker-Postgres tests; PR160 passed the same unit check, 15 Docker-Postgres tests, production build, independent review and five CI checks. PR160's local query result preserved all 102 normalized rows while EXPLAIN time fell from 4323.725 to 1112.748 ms; this does not resolve the production sync-health timeout.

The earlier deployment history remains in [the PR160 deployment report](../fansly-pr160-deploy-2026-09-08/REPORT.md). The stage table below records the current state. A0/T0 and events stages have not started; lilly-2 recovery remains off.

Archive completion was logged at 18:53:50.230 UTC (eight accounts, 4952 events seen, 3658 inserted/upserted, zero tombstones). The enclosing tick completed at 18:54:00.723 in 602.566 seconds, including 581.372 seconds for message_archive. These are whole-worker sweep counts and durations, not the isolated cost of this replay. Another completion at 19:04:40.820 reported eight accounts, 5340 events seen, 3978 inserted/upserted and zero tombstones; the accepted serving scan completed shortly before that global log. Evidence: worker-projection-wait.log and worker-projection-late.log.

A second serving scan at 18:54:50 and another at 18:57:03 still found 5/9 parent/root matches. The four missing rows had materialObservedAt null. The archive processes accounts sequentially; the timing inference is that a global completion cannot establish that an account consumed events appended after it was processed in that pass. Direct SELECT on projection_seq_watermarks, domain_event_seq, domain_events and message_archive is not granted to read_only (checked via has_table_privilege at 18:56 UTC); no base-table read or role bypass was attempted.

At 19:02:43 a pure local run of the deployed revision's canonicalizeSyncPullObservation over the five exact source observations emitted exactly one material event for each of the nine target messages, with all nine parent/root pairs correct. Raw bodies remained in process memory; saved results contain selected material fields and normalized text hashes only. All nine source reply/id fields are strings and their observations are v6. This confirms local draft construction for the retained inputs; the later production transcript supplies acceptance. The first diagnostic query used a wrong page mapping column and failed before reading bodies; the corrected query used pages.external_page_id and completed. Evidence: local-canonicalization-check.json, reply-shape.txt and projection-read-grants.txt.

## Background progress and limits

At 19:05:29 the final shared snapshot contained four unparsed observations: one DM received about 24 seconds earlier and three earnings, the oldest about 3m48s old. Historical v5 DM decreased from 42534 at 18:53 to 42162; earnings decreased from 14966 to 14960. The other v5 counts were monthly 109052, stats 109055 and purchase history 11710, for 286939 total. Both fresh and historical lanes continue to progress. This is shared background work, not an isolated effect of this replay or a serving-latency percentile. Evidence: [final parse lanes](evidence/parse-lanes-final.txt).

The replay log includes an OFAPI egress_pacer_shadow entry; it is not a measurement of physical requests. The scoped DM canonicalizer reads retained data, and no Fansly re-fetch command was run. Whole-system disk samples do not establish replay-only storage growth.

## Stage state and next owner decision

| Stage | State | Savings / latency measured | Remaining gate |
|---|---|---|---|
| Pre-A0 known head | PR157 deployed; one ari target proven in archive; second unresolved | Earlier canary capture 188.695 s; no fleet distribution | Exact debt acceptance; do not infer provider deletion |
| Pre-A0 lilly-2 catch-up | Implementation deployed; recovery off | Last fixed cohort at 18:00: 1516 missing / 5615; not refreshed here | Separate recovery approval and acceptance |
| Pre-A0 reply repair | PR158 deployed; ari 9/9 accepted; other 985 targets open | Write 110.558 s; serving confirmation within 14m39s of start | Remaining scoped replay and source-to-serving checks |
| Pre-A0 fresh capture / monitor | PR159/160 deployed; both parse lanes progress; archive delay and sync-health latency open | Final unparsed DM age 24 s; no latency percentile | Sustained freshness acceptance and monitor diagnosis |
| A0 + T0 | Not started; seven-day clock not running | No physical-attempt baseline or savings | All prerequisites accepted, then full shadow gate |
| C1 | Not started | Unmeasured | A0 started; trigger diagnosis |
| C2a | Not started | Unmeasured | Correctness cases and retained repair plan |
| C2b | Not started | Unmeasured | C2a; receipt shadow with daily rotation retained |
| C2c | Gated | Unmeasured | Coverage, per-fan max-age and cost evidence |
| W0 | Not started | Unmeasured | Explicit live-probe approval; Management Session only |
| B0 | W0 gated | Unmeasured | Capture-only receiver; at least seven days and event variety |
| B1 | B0/T0 gated | Unmeasured | Delivery, added attempts and history fairness evidence |
| A1 | Owner/calendar/evidence gated | Unmeasured | Separate yes after A0/T0 and freshness evidence |
| B2 | Not authorized | Unmeasured | Separate owner decision |

The next concrete action is [the prepared remaining-five-page replay](REMAINING-REPLAY-APPROVAL.md): lora-3, lora-2, lora-1, lilly-2 and lilly-1, 2765 retained observations in the same received window, parser 6. The 19:06:55 all-source census found only pull/v5 with all bodies available. Process one page at a time, preview then one gated write, followed by serving acceptance before the next page. This wider production-write scope needs a new explicit yes; the ari approval is complete. No wider preview or write has run.

Full P2 acceptance still includes the other 985 replies and the 27-message nonempty attachment subset. Later changes/clears outside the positive source cohort, general conversation completeness, provider edits/deletions, outage gaps, quiet-state freshness and Management Session socket coverage remain unproven. Provider-deleted-head repair stays outside A0; its shadow only counts that discrepancy. No production HTTP savings or event-latency distribution has been measured, and the >=50% goal is not claimed.


Subsequent state, 2026-09-08 20:54 UTC: the remaining-five-page scope was
explicitly approved via `\+`. Lora-3 54/54 and lora-2 63/63 passed; lora-1's
170 observations are v6 and 140/143 targets pass, but three targets in one
conversation time out through Agent reads. Neither Lilly preview nor write
started. A separately reviewed PR161 query fix is prepared; new deployment
approval is required before its production verification. Remaining replay
approval persists subject to the original per-page gate. Current evidence and
the concrete next action are in
../fansly-five-page-reply-replay-2026-09-08/REPORT.md and
../fansly-five-page-reply-replay-2026-09-08/PR161-DEPLOY-APPROVAL.md.
