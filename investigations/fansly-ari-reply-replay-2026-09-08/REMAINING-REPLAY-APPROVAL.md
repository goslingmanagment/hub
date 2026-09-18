# Prepared reply replay — remaining five pages

State: prepared, not executed. The approved ari-1 operation has passed its nine-message acceptance. This expands the production-write scope beyond ari-1 and needs a new explicit owner yes under the existing reply-repair runbook Gate 2. It uses the same reviewed code on deployed revision 18649bd95f3bedb812847343d27fdeedf8b5d32f.

Every command is restricted to kind dm_messages, parser 6 and received window [2026-09-07T01:45:00Z, 2026-09-08T01:45:00Z). A fresh read_only census at 19:06:55 UTC committed successfully and found only pull observations, all v5 and all bodies available:

| Order | Page | Account | Eligible observations | Reply targets in fixed cohort |
|---|---|---:|---:|---:|
| 1 | lora-3 | 3 | 31 | 54 |
| 2 | lora-2 | 2 | 43 | 63 |
| 3 | lora-1 | 1 | 170 | 143 |
| 4 | lilly-2 | 5 | 826 | 409 |
| 5 | lilly-1 | 4 | 1695 | 316 |
| Total | Five pages | | 2765 | 985 |

The largest scope fits nine standard 200-observation pages, below the existing 20-page per-family allowance. No page size, concurrency or parser-version increase is proposed. Run only one replay process at a time and wait for its result and that page's serving verification before continuing. The observations can expand into many material events; duration is not inferred from row count. Ari's one-page write took 110.558 seconds and all nine targets were confirmed within 14m39s of its start, including projection delay; this is not a forecast or percentile for the larger pages.

After approval, refresh runtime revision/health, catch-up none, each page identity, eligible count and attached partitions. For each row in the table, run the corresponding exact preview:

```sh
ssh root@45.8.230.111 'docker exec agency-hub-worker-1 node /app/apps/runtime/dist/cli.js events:replay --kind dm_messages --account 3 --from 2026-09-07T01:45:00Z --to 2026-09-08T01:45:00Z --parse-version 6 --dry-run'
ssh root@45.8.230.111 'docker exec agency-hub-worker-1 node /app/apps/runtime/dist/cli.js events:replay --kind dm_messages --account 2 --from 2026-09-07T01:45:00Z --to 2026-09-08T01:45:00Z --parse-version 6 --dry-run'
ssh root@45.8.230.111 'docker exec agency-hub-worker-1 node /app/apps/runtime/dist/cli.js events:replay --kind dm_messages --account 1 --from 2026-09-07T01:45:00Z --to 2026-09-08T01:45:00Z --parse-version 6 --dry-run'
ssh root@45.8.230.111 'docker exec agency-hub-worker-1 node /app/apps/runtime/dist/cli.js events:replay --kind dm_messages --account 5 --from 2026-09-07T01:45:00Z --to 2026-09-08T01:45:00Z --parse-version 6 --dry-run'
ssh root@45.8.230.111 'docker exec agency-hub-worker-1 node /app/apps/runtime/dist/cli.js events:replay --kind dm_messages --account 4 --from 2026-09-07T01:45:00Z --to 2026-09-08T01:45:00Z --parse-version 6 --dry-run'
```

These are individual per-page templates, not a batch to launch together. After each preview agrees with its refreshed eligible census and reports zero errors, unavailable/unparseable/unmapped facts, partition blockers and binding conflicts, make one identical call with only --dry-run removed. Retain full metadata and output. A failed or unexplained gate stops the sequence before the next write; no blind retry or forced stamp. If background replay already completed a scope, perform read-only acceptance instead of another write.

After each write, independently count remaining eligible observations, wait for ordinary archive application and compare its fixed reply targets through production Hub transcript. Verify parent/root, normalized text and attached-message material for the retained 27-message attachment subset; preserve coverage blockers and classify later changes/clears separately. Once all pages pass, rerun the six original diagnostic examples and report full 994-message acceptance, including the nine already repaired ari targets. Do not declare complete conversation history from positive ID matches. Record fresh queue/projection delay and disk before/after; do not loop the known slow sync-health endpoint.

The effect is retained-data canonicalization and ordinary projection on these five pages only. It does not authorize lilly-2 known-head recovery activation, any flag flip, new provider fetch, deployment, archive rebuild, history/cursor reset, socket probe or A0/A1 activation. Head catch-up stays none. Stop means no further dispatch; committed events, reply repairs and v6 stamps remain. A code rollback is a separate action and cannot erase repaired data.
