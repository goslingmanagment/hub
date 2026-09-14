# Independent metadata-exclusion review

Reviewed 2026-09-14T00:39:55.500475+00:00 against base main `478fca4220d3d07d61a9200d1860316e770cb4fe`. Scope: audit finding 10, the existing partner-unresolvable exclusion write. No tests, production actions or application edits performed by this reviewer.

## Verdict

No actionable findings in the prepared source, tests or documentation. Final `pnpm check`, relevant serial Docker-Postgres suites, and composition with then-current main remain publication prerequisites. This review does not establish a historical production overwrite or a deployed repair.

## Correctness and transaction behavior

- The former full-row upsert is removed from the handler. `excludePageDmConversationMessageSync` performs one parameterized update of only the exclusion metadata key and `updatedAt`; it merges against the current database metadata rather than a stale JavaScript copy. No thread identity, preview/head field, stored-window counter/cursor, history coverage or message body is written. The helper is directly exported through the existing repository barrel.
- Matching immutable row ID, page and the probed partner ID prevents a stale lookup from excluding a removed/rebound conversation or a different page. A no-match result cannot insert/recreate a row. The reason object is JSON-stringified into a bound SQL parameter, not interpolated as executable SQL. Existing unrelated metadata keys remain present.
- Exclusion and checkpoint reset stay together inside `withOwnedPageSyncTransaction`. A false update result throws the original provider error before checkpoint advancement. The existing helper checks lease ownership before work and locks/rechecks it before commit; a concurrent lease loss rolls the transaction back. Diagnostic publication occurs only after that transaction succeeds.
- The three-failure threshold, terminal 5xx classification, request budget, partner lookup and capture-first probe are unchanged. `probeFanslyAccountResolution` journals the reply before returning `unresolved`; fetch failure or ambiguous response cannot authorize this write. This change neither adds a provider request nor changes polling/recovery cadence.

## Meaningful coverage and readability

The new PostgreSQL file has four real-handler cases (interleaved newer material, rebound row, removed row, replaced lease) and one repository page-scope refusal. The test interleaving runs while the old conversation snapshot is already loaded but before the exclusion update, so the success case would detect the original stale-row overwrite. Its full normalized-row comparison preserves head, preview, flags, cursors, count, coverage and nested metadata, allowing only the intended exclusion and update timestamp. Separate message assertions retain body and reply links. The refusal cases assert unchanged checkpoints and original error/lease-loss behavior; a deleted-row fixture also proves no recreation.

Failure history, account-lookup journaling, lease context, database updates and checkpoints use real implementations. Transport and telemetry are test stubs, consistent with the existing lane harness; these cases do not establish HTTP-adapter behavior or an end-to-end production delivery claim. The existing unit test now requires the exact narrow repository input and explicitly rejects use of the broad upsert. No redundant policy abstraction, unsafe runtime cast or large-file extraction is introduced; the runtime patch removes more handler code than it adds.

Decision 327 and the runbook accurately state the narrow write, refusal behavior and rollback risk. The read-only runbook query names match the schema (`page_sync_cursors.page_id`), and its snapshot caveat avoids claiming past preservation from a current row. No flag or migration is added. Decision numbering and inclusion of the new git-ignored runbook still require normal coordinator publication staging.

## Reviewed fingerprints

| File | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/sync/executor-handlers.ts` | `1c0143dcccde6ea62e18593240314edf129de4e12027be3b0747194b6ab19ecf` |
| `packages/db/src/repositories/page-dm.ts` | `482fedf8bdeb55db3df2b24b5f7392db3e3fbc6fb91a94dae0728e09548b63ec` |
| `tests/sync-handlers.test.ts` | `dfc1a49b0257ddf4df56ed8f357271effc961cbe56ec95f0ad0b8c5dba3121ea` |
| `tests/fansly-dm-exclusion.integration.test.ts` | `b73c0e58ef2fadbfea591444441f38ebe53017350ec5c9a39e09031638affc76` |
| `docs/decisions.md` | `e40a19201113c21fc6546b73d0dcec40fa5155e2998dd9360f36a2dcf79844a8` |
| `docs/runbooks/fansly-dm-exclusion.md` | `7d7f1cb7ed75b1ea13943bb6f98fd8f8bc239213edd342a1629cfd0fa6c4f59e` |
