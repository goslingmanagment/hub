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

## Final main composition follow-up

No new findings on `33b4e9091962edfc1e45c003ebb30ba0a9794b2b`, composed with main `b78752d0d1144a8457638ffb3ae0bda33455fde1`. The final diff from current main retains exactly the narrow runtime/repository and unit changes reviewed above. The executor handler and unit-test whole-file hashes change only because C1's existing membership diagnostic code and fixture were added from main; provider-cooldown implementation remains unchanged. Every main decision body/reference row is preserved, including D322; D327 remains the added topic. The new runbook is now included in the commit.

The repository helper, five-case PostgreSQL test and runbook still match the prior review hashes. New composition fingerprints: executor-handlers.ts `526f0fb06edeb2e0189b5b3998bdba8eb88cd0d7086672d327a76fa3866763c1`; sync-handlers.test.ts `3422a1b1fcee1ba7a816d931ea4b958bde6d654d04800cd1aad66c3313e7404f`; decisions.md `2a789f586886151234aa00d732fd68ecda2e78f50b2d4cca59c73d7dd12dc2fd`. No tests were run by this reviewer; the planned original-handler negative control and final merged-candidate checks remain separate validation work.

### Immutable partner-value correction

Reviewed the subsequent four-line correction after the author's typecheck failure. Capturing `currentConversation.partnerPlatformUserId` in a local constant before its nonempty guard retains TypeScript narrowing inside the asynchronous transaction callback and gives the probe and conditional update exactly the same immutable verified ID. No assertion/cast, predicate or refusal behavior changes. No further findings. Final executor-handler SHA-256: `18d6882d4c9e04843fd77fe75790113b74984032041956a70126676719e88f9c`. The author's original failing check and negative-control receipts are retained separately; this reviewer ran no tests.

## Main a9794e60 / PR186 final composition

Reviewed 2026-09-14T01:06:37.727921+00:00 at `3fa4590f5fc1dcaf5ec68445c1b92e2f8a88382e`, following merge `9c939364fc9993353cfd9e2f4693592d76f42dd3` of `a9794e600dfbb10918800ab5b49241e33d7357a3` into validated topic `60d690eb44faa5470a4645d3c7ee0f659558538c`. The final commit only clarifies the validation boundary. No actionable findings; no tests, source edits or production calls by this reviewer.

Across apps/packages/scripts/tests/workflows and build/package files, the only difference from the prior validated candidate is the exact merged-main UTC credits fixture (`eff98afad7b6f0e87563a831c33d0b27bb2581f109f4166900d60e82f28be86b`). All five topic source/test/runbook paths are byte-identical, and their complete diffs against a979 main equal their previous diffs against b787 main. The owned metadata-only update, immutable partner guard and actual interleaving/lease regressions remain unchanged.

Removing only D327 and its quick row reproduces all current main decisions exactly, ignoring trailing whitespace. D327's body is unchanged from the prior candidate; its row and section follow incoming D324. No decision was overwritten.

The prior validation receipt pins the same four executable/test hashes; its retained final check and PostgreSQL logs match their decompressed SHA-256 receipts and exit 0. The recorded 3,420 unit/9 existing skips and 48 PostgreSQL passes belong to that prior tree. COMPOSITION-MAIN-A979.md correctly claims no new local run: the unchanged topic evidence and already-validated main fixture support composition review, while fresh PR CI remains the complete-combination merge gate. No production preservation, deployment or migration acceptance is inferred.

| Composed file | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/sync/executor-handlers.ts` | `18d6882d4c9e04843fd77fe75790113b74984032041956a70126676719e88f9c` |
| `packages/db/src/repositories/page-dm.ts` | `482fedf8bdeb55db3df2b24b5f7392db3e3fbc6fb91a94dae0728e09548b63ec` |
| `tests/sync-handlers.test.ts` | `3422a1b1fcee1ba7a816d931ea4b958bde6d654d04800cd1aad66c3313e7404f` |
| `tests/fansly-dm-exclusion.integration.test.ts` | `b73c0e58ef2fadbfea591444441f38ebe53017350ec5c9a39e09031638affc76` |
| `docs/runbooks/fansly-dm-exclusion.md` | `7d7f1cb7ed75b1ea13943bb6f98fd8f8bc239213edd342a1629cfd0fa6c4f59e` |
| `docs/decisions.md` | `e8b89eb2f7aebae1e36515902ff66d720ab64f439ba3266cc0888037b0eecf2a` |
