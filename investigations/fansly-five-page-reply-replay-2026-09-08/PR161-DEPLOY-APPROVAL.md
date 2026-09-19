Completed with owner approval on 2026-09-09. Deployment exited 0 at 10:30:43 UTC;
the subsequent exact transcript read failed again, so Lilly remains paused.
See [outcome and current gate](../fansly-pr161-deploy-2026-09-09/REPORT.md).
The original approved procedure below is retained as historical evidence.

# Concrete next owner gate: deploy PR161 and resume acceptance

Pending a new explicit owner yes. The previous `\+` covered the five-page replay
on deployed 18649bd9; it did not authorize a new deployment.

PR: https://github.com/goslingmanagment/core/pull/161
Reviewed implementation: d77d6aaf8855354aee0edca39d878d9e91ceeeb9.
Reviewed final PR head: 6488e0bbbb63112f2588e938bd4f17b269c8716b.
Merged revision: 34d897779fd004336e114333501f284f1faeefc1.
Worktree: /Users/dmitriy/.codex/worktrees/hub-agent-transcript-window.

Local pnpm check, 120 Docker-Postgres tests without skips, production build,
independent review and final documentation review passed. All five CI checks passed on the reviewed PR head; PR161 merged at
2026-09-08T21:07:12Z. The merged tree exactly equals the reviewed final tree. No new flag, migration, schema, contract or dependency.

After approval, deploy the clean merged revision using the standard command:

```sh
scripts/deploy-production.sh --mode dist-only --no-image-gc root@45.8.230.111
```

Preserve the normal protected sync-health gate and automatic rollback. The
separate sync-health timeout remains unresolved; this query fix does not claim
to cure it. A failed gate must not be bypassed. Keep head catch-up running/editor
`none`. The standard deploy rebuilds the production-pinned Hub CLI. Rollback
uses the previous 18649bd9 code/image with the same schema and data.

After all deployment gates pass, verify the exact three blocked lora-1 targets
in conversation 790634843078664193, using the original 143-target cohort:

| Message | Created at UTC |
|---|---|
| 953135194070597632 | 2026-09-07 00:04:58 |
| 953381558998294528 | 2026-09-07 16:23:56 |
| 953448940269740033 | 2026-09-07 20:51:41 |

`evidence/lora-1/after-query-fix/` is prepared, not run. It preserves the 140
already verified targets and their original read timestamps and uses a 2 ms
window for the three pending groups. Read one request at a time; if any read
fails, stop. Then rerun retained material validation for the full cohort, verify
v6 source stamps and exact cohort identity, and only then write accepted.json.
Do not repeat lora-1's already-completed replay.

After lora-1 passes, resume the already approved lilly-2/account 5 and
lilly-1/account 4 reply scopes sequentially: kind dm_messages, parser 6,
received [2026-09-07T01:45:00Z,2026-09-08T01:45:00Z). The original window counts
were 826 and 1695; refresh the census and preview first. If background work
already covered a scope, verify serving instead of replaying it. Retain 409 and
316 original target IDs respectively and compare parent/root, normalized text,
stable media metadata and direct raw attachment refs before the next page.
The standard runtime bootstrap includes OFAPI GET /whoami credential preflight
and proof persistence, as documented; the scoped Fansly repair uses retained
bodies. Save full counters and do not retry uncertain writes.

Finally reread the six original diagnostic IDs and the ari subset, update
coverage/backlog/storage evidence, and report the full original 994-ID outcome.
Lilly-2 known-head recovery, flag changes, socket work, A0/A1 and B2 remain
outside this approval. No HTTP-savings or fresh-event latency percentile is
claimed from this operation.

The production build was also rerun successfully on merged revision 34d897779fd004336e114333501f284f1faeefc1. The worktree is clean; the compiled candidate is ready, and production has not been changed. Evidence: evidence/pr161-merged-build.log.
