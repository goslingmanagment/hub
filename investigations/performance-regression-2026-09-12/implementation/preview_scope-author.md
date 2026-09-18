# Conversation preview monitor scope — author handoff

Author worktree: `/Users/dmitriy/code/goose/.worktrees/hub-perf-preview_scope-20260912`.
Base: deployed `31b73a9691f32f8c33c3fe479bca68533c7048d6`.
No commits, production access, Vitest suites or database executions by this author.

## Change and causal path

`getPageConversationPreviewReport` reads the bounded preview and DM coverage, then
calls `resolveConversationHistorySyncUx`. That helper uses only the
`messages_live` / `messages_history` blocks from `getSyncStatusSnapshot` and maps
them through the existing `mapDomainBlockToSyncUx` and
`buildConversationHistorySyncUx` functions. These domains have precisely
`dm_conversations` / `dm_messages` as primary streams and no supporting streams.

The helper now passes those two names through the existing `monitorStreams`
option. Previously the default was all 17 Fansly stream names. Repository SQL
already applies this input to its running-run, completed-run, recent-run,
recent-attempt and historical-physical-debt inputs. The patch does not create a
new status engine, cache, projection, schema migration or API contract.

Global `listPageSyncStates` and visible-page reads stay unchanged: an active
non-DM stream on another page can share this page's runtime group and is needed
to distinguish a healthy queue wait from stalled work. DM eligible/ready/lagging
counts, deep-backfill estimates, checkpoint progress and all historical
unresolved attempt debt also remain unchanged. OnlyFans' existing ingest overlay
remains in the shared snapshot path.

## Files in the proposed commit

- `apps/runtime/src/services/conversations.ts`: existing selector, plus its reason.
- `tests/runtime-page-services.test.ts`: Fansly and OnlyFans preview callers must
  request the two DM streams.
- `tests/sync-status.test.ts`: four before/after equality scenarios compare entire
  DM blocks and the actual preview UX mapping. Coverage/deep backlog, old
  physical debt and a different page's active non-DM sibling must retain their
  expected semantics despite unrelated monitor failures.
- `tests/sync-monitor.integration.test.ts`: actual repository output for both DM
  streams must exactly equal the corresponding full-monitor rows, with failures
  and stale attempts older than the 24-hour window retained.

No new source/test files need `git add -N`; these four files are already tracked.

## Validation performed

- `pnpm install --offline --frozen-lockfile`: pass.
- ESLint for the four changed files: pass.
- `git diff --check`: pass.
- `node --import tsx/esm /Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/implementation/preview-scope-probe.mjs`: exit 0.

The last command uses the actual repository SQL builder and a recording mock;
it opens no database/network connection. It proves:

| Property | Before | After |
| --- | --- | --- |
| Monitor SQL statements | 1 | 1 |
| Requested stream names | 17 | 2 |
| SQL inputs with exact requested stream filters | 5 | 5 |
| Old unresolved physical attempts stay in scope | yes | yes |
| Page-total CTEs remain | yes | yes |

This is query-scope evidence, not measured PostgreSQL rows read or milliseconds.

## Root/reviewer validation still required

Run serially from the candidate release checkout after integration:

```sh
pnpm exec vitest run tests/runtime-page-services.test.ts tests/sync-status.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/sync-monitor.integration.test.ts --maxWorkers=1 --no-file-parallelism
node --import tsx/esm /Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/implementation/preview-scope-probe.mjs
```

Independent review should verify that there are no hidden dependencies on
unrelated monitor rows in the two domain reducers, that shared-group sibling
context remains global, and that neither recent-window scoping nor missing
monitor rows can silently erase DM attempt debt.

## Scope limitation agreed with coordinator

Page-level fan/follower/subscriber/transaction/message totals, construction of
discarded non-DM domains and the OnlyFans financial-summary read remain in the
shared snapshot. Removing those through this public full-snapshot return type
would risk fabricated/absent metrics for existing callers. A separately typed
projection would be a wider optimization; it is not required in this release.
No specific preview latency improvement is claimed without a live/local plan.

## Proposed decision text for coordinator to append

Conversation preview's sync UX consumes only the `messages_live` and
`messages_history` domains. Pass their two existing monitor streams,
`dm_conversations` and `dm_messages`, instead of scanning retained monitor
history for the full 17-stream default. Keep the shared status derivation and
global task context so active siblings on another page still explain queue
waits. Preserve DM coverage/deep-backfill counts and all historical unresolved
physical attempt debt; the 24-hour recent-counter window is not a debt cutoff.
Page-total calculations remain a separate optimization. No new cache, contract,
schema or provider traffic is introduced. Rollback is the prior selector and
does not modify stored facts or sync state.
