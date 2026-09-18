# Conversation preview monitor scope — independent review

**APPROVE. No blocking correctness, regression or architecture findings.**

Reviewer: `/root/fix_binding_wait`, not the preview-scope author. Reviewed the four preview files in `/Users/dmitriy/code/goose/.worktrees/hub-performance-fixes-20260912` against HEAD `a2153faba545154eefc9e7ad8fd516e248f27669`. Other staged changes, including this reviewer's payload-batching patch, are excluded from this approval.

Reviewed index blobs: `conversations.ts` `83f5f957`, `runtime-page-services.test.ts` `13c89004`, `sync-monitor.integration.test.ts` `ba04d1fc`, `sync-status.test.ts` `7de7834d`. The production change is one existing selector argument and its explanatory comment; no shared status engine or repository behavior is modified.

## Why the two streams are sufficient

`conversations.ts:67–87` consumes only `page.blocks.messages_live` and `page.blocks.messages_history`, then passes their existing UX mappings and separately loaded DM coverage counts to `buildConversationHistorySyncUx`. It never exposes this scoped snapshot's aggregate `recentCounters`, `page.syncUx` or other domains.

`SYNC_DOMAIN_POLICY` in `packages/db/src/repositories/page-sync.ts:468–478` assigns exactly `dm_conversations` to messages_live and `dm_messages` to messages_history, with no supporting streams. The snapshot first associates each task with its exact `(pageId, stream)` monitor row, then filters domain monitor rows by those tasks (`sync-status.ts:1630–1706`). Consequently the two consumed domain reducers receive the same tasks and monitor rows as the full request. Their physical-attempt health, checkpoint progress, counters and metrics have no hidden dependence on discarded non-DM rows.

Other full-snapshot callers retain their existing options: protected/public health and detailed sync-block reads still request their original scope. The preview helper is private and returns only the conversation-history UX value. Although discarded non-DM domain summaries can differ inside this local snapshot, those values neither mutate the DM blocks nor escape through the preview response.

## Queue context, coverage and historical debt

The selector affects only `listSyncMonitorStreamRows`. `listVisiblePages` and `listPageSyncStates(app.db)` remain global. Active sibling streams are derived from all visible pages' task rows and runtime groups before page-specific construction (`sync-status.ts:1567–1623`). A non-DM task on another page therefore still explains a healthy queue wait. This does not depend on that sibling's monitor row being loaded.

The repository scopes running/completed/recent histories and attempts by stream. Its lifetime `attempts_with_last_success` window still partitions by `(pageId, stream)` and has **no recent-time cutoff** (`sync.ts:2359–2411`). Narrowing streams cannot change a retained DM stream's last success or unresolved older failures. Recent counters alone use the 24-hour window. The new integration fixture compares complete DM repository rows against the full read while explicitly keeping week-old failed/unfinished attempts visible.

DM eligible/ready/lagging counts, deep-backfill estimates, message counts, cursor state and preview coverage reads are unchanged. Incomplete history still reaches the same reducer and UX mapping. The new full-versus-scoped status fixtures cover ready history, coverage/deep backlog, old physical debt and an active non-DM sibling; they compare entire consumed blocks and the final UX result, not just the selector argument.

OnlyFans' platform intersection still applies in the repository. The retired `dm_messages` stream is absent from the platform's supported streams both before and after this change; specifying it does not revive it. The OFAPI settled-webhook freshness query and messages_live overlay remain in the same path. The OnlyFans caller assertion and source trace establish unchanged routing; the added equality matrix itself uses Fansly fixtures.

## Architecture, evidence and practical limits

Using the existing optional `monitorStreams` seam is appropriate for this bounded consumer. It avoids another status implementation, cache, migration or contract. No writes, scheduling changes or provider requests are added. Runtime rollback restores the previous argument without touching stored data.

The claimed measurable change is narrower SQL input: the requested list changes from 17 Fansly-default names to two DM names, and the existing five scope filters receive that list. This review does **not** infer a latency percentage or PostgreSQL row-read reduction. Page-wide fan/follower/transaction/message totals, construction of discarded domains and OnlyFans financial-summary reads remain; the author's limitation is accurate. A separate projection could remove more work, but it is not needed to make this change correct.

I performed read-only source/diff review and inspected the supplied tests and SQL probe; I ran no suites, database, production actions or source edits. Root's `preview-scope-tests.log` reports **3 test files, 38 tests passed** in the release worktree. Ordinary release gates and any later edits remain the coordinator's responsibility.
