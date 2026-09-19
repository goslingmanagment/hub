# Approved and completed scoped reply replay — ari-1 only

State: approved by the owner's "давай ага" and executed once on 2026-09-08.
Preview passed; the write completed at 18:51:32 UTC with 128/128 stamped v6,
1487 appended and 1405 deduped, with no errors or blockers. At 19:04:21 all nine
ari targets passed archive parent/root/normalized-text checks; four missing pairs
were repaired. See the [accepted operation report](../fansly-ari-reply-replay-2026-09-08/REPORT.md).
The original Gate 2 procedure below is retained as the approved record, not a
request to rerun it. Wider replay remains a separate owner decision.

Candidate: deployed merge 18649bd95f3bedb812847343d27fdeedf8b5d32f, including reviewed
PR158 reply clocks and PR159 fresh-capture scheduling. Internal account 10 is ari-1.
Kind: dm_messages. Received-time window: [2026-09-07T01:45:00Z,
2026-09-08T01:45:00Z). At 18:15:28 UTC, read_only in a read-only transaction found
exactly 128 source=pull observations, all parser v5, zero unavailable bodies.
An additional all-source census found only these same 128 pull observations in the exact command scope; there are no matching command_result or client_capture rows. This fits one normal 200-observation page. Attached domain-event partitions cover
the inspected retained range including 2024, 2025 and September 2026. The normal
engine partition guard remains authoritative for provider-dated facts.

The nine ari reply targets in the full 994-message cohort come from five of these
128 observations; their source rows were all v5 at 18:14:31. Their original
source-to-serving comparison and exact IDs are already retained. This operation
does not claim to finish the other five pages or the whole P2 acceptance.

After approval, refresh exact deployed revision, role health, catch-up none and
the bounded census. Preview through the existing production runtime:

```sh
ssh root@45.8.230.111 'docker exec agency-hub-worker-1 node /app/apps/runtime/dist/cli.js events:replay --kind dm_messages --account 10 --from 2026-09-07T01:45:00Z --to 2026-09-08T01:45:00Z --parse-version 6 --dry-run'
```

Retain the full structured result. Require its scan count to agree with the
refreshed eligible census, zero errors/unavailable/unparseable/partition-blocked
facts and no binding conflict. If it disagrees, stop before the write. Then make
one identical call with only --dry-run removed:

```sh
ssh root@45.8.230.111 'docker exec agency-hub-worker-1 node /app/apps/runtime/dist/cli.js events:replay --kind dm_messages --account 10 --from 2026-09-07T01:45:00Z --to 2026-09-08T01:45:00Z --parse-version 6'
```

Stop on errors or missing-body/partition/binding blockers; preserve all output
and do not retry blindly. Inspect remaining eligible rows, ordinary projection
completion and all nine exact ari reply targets through Hub transcript. Check
parent, root and normalized text independently; retain coverage blockers. Record
DB/projection duration and the existing fresh queue before/after. Do not run any
second replay concurrently. The separate slow sync-health issue remains open;
do not loop the 150-second endpoint as a progress signal.

Effects: append/dedup retained material and stamp v6 in this one account/window;
ordinary projection may update reply refs using field clocks. No new Fansly HTTP
request, flag flip, recovery activation, history reset, parser-version inflation,
archive rebuild, socket probe or A0/A1 advancement. Stop means no further replay
dispatch; existing committed facts and stamps stay intact. A binary rollback
cannot erase those facts and is not part of this approval.
