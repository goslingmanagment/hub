# Independent exhausted-head/history review

Reviewed 2026-09-14T00:28:06.873941+00:00 against main `478fca4220d3d07d61a9200d1860316e770cb4fe`. Scope: audit finding 9 only. Local source and test review; no test execution, production action or application edits by this reviewer.

## Verdict

No outstanding findings after the R1 follow-up below. The initial candidate had one P2 execution gap; it is retained here as review history and was corrected before final validation.

## R1 — P2: admitted history can repeatedly restart at the missing head

**Trigger:** an allowlisted visible conversation has `pending_backfill`, one or more stored messages, a serving head different from the newest stored ID, and only exhausted uncaptured debt. This naturally follows earlier recovery attempts that captured old messages but not the target ID.

The new `attempts < 5` exclusion at `packages/db/src/repositories/page-dm.ts:1154–1158` admits this row. However, `apps/runtime/src/services/sync/executor-handlers.ts:2818–2825` chooses `incremental` whenever stored count is nonzero and the two head IDs differ, before considering pending history. `getFanslyDmHeadTarget` then returns null for the exhausted row, so the state starts with a null `before` cursor (lines 2858–2871).

The normal incremental request reaches the stored overlap and completes. `resolveDmConversationCoverageStatus` in `fansly-dm-messages.ts:46–47` preserves the existing `pending_backfill`; `finalizePageDmConversationMessageSync` updates the stored window/status but intentionally preserves the serving head. The outer executor loop has no per-run exclusion for completed IDs, so the new selector admits the same row again. It can repeatedly spend its chunk budget on the head page and continue doing so on later runs, without fetching older pending history. This also contradicts the new runbook's promise that exhausted debt ends additional bounded head searches while allowing ordinary history.

**Minimum fix:** when this allowlisted candidate has pending history and no active head target, enter the ordinary history/backfill mode using its oldest stored cursor. Preserve due active head priority, five-attempt accounting and existing continuations. Reuse the already-read target if practical rather than adding another policy query.

**Required regression:** execute the real `dm_messages` handler with an exhausted target, an actual stored overlap, and older available history. Assert the older history cursor/request and progress/completion, no repeated head-page loop, and that the missing exact ID remains visible and exhausted until an actual receipt exists. The current four tests prove selection, debt retention and list-wakeup request counts but never exercise this handler; they would pass with the loop still present.

## Other checks

- Reusing `nextFanslyDmHeadRetryAt` avoids the additional broad unresolved query and keeps `hasUnresolvedFanslyDmHead` diagnostic semantics unchanged. Its per-thread query includes all unexhausted debt, not just the current serving head; a future retry remains non-null. `shouldRequestDmMessagesFollowup` independently rejects hidden, identity-less and explicitly excluded conversations, consistent with the normal eligibility filters. Message-health backoff remains enforced by candidate selection.
- The amended selector preserves due-head priority, unretried-debt backoff and the existing page, visibility, identity, exclusion and health restrictions. The new SQL predicate is limited to `includeHeadDebt`; nonallowlisted behavior is unchanged.
- No debt is deleted, acknowledged or reset; no migration, new flag, provider deletion claim or metadata-writer change is included. The draft Decision 326 and runbook preserve owner gates and correctly separate ordinary history from exact-ID capture, subject to fixing R1 so execution fulfills their wording.
- The isolated test file reuses existing sweep fixtures and asserts exact provider-call and queue outcomes rather than merely mirroring a helper implementation. Its full-input cast follows nearby sweep-test fixtures; this review does not require unrelated test-harness refactoring. Add the missing message-handler coverage within this topic.

## Reviewed candidate fingerprints

| File | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/sync/fansly-dm-conversations.ts` | `7331c010dec8ced4bf67560f38871a4032ae7bf3caceb1922e10b39ba85eca43` |
| `packages/db/src/repositories/fansly-dm-head-debt.ts` | `63256c9b40375b7199e06ba04a1cdee75d1dabe598d99e2078187703bd5c7468` |
| `packages/db/src/repositories/page-dm.ts` | `7d78e57cdb9d416f52dd2e3ac805e2cb1909bf618ef8dd7c781d44859b509ccf` |
| `tests/fansly-dm-exhausted-head-history.integration.test.ts` | `c9659b7c83ad829efbbfad30a7dbb1c787144932e756003cc13d8fe11ff6120d` |
| `docs/decisions.md` | `1b2e425dc4c1de532f51c7968d607feef77c35671076cdea811f6cf61e66d5a3` |
| `docs/runbooks/fansly-dm-head-catchup.md` | `797056ba350263ddf8643052b2d0d276b1453bd95872ed74b53ced57f3566e49` |

Decision 326 remains a coordinator reservation, to be checked against current main before publication. Full checks and relevant serial PostgreSQL suites remain pending for the corrected candidate.

## R1 follow-up — resolved

Reviewed 2026-09-14T00:34:21.980953+00:00. The fresh-candidate branch now switches only an allowlisted `incremental` candidate with `pending_backfill` and a null head target to `backfill`, before checkpoint cursor selection. The existing `oldestStoredMessageId` cursor is therefore used. Due active targets, deep-backfill selection, nonallowlisted execution and already-pinned continuations bypass the new condition. The existing target read is reused without another database query or a second debt policy helper.

The new real `fanslyDmMessagesChunk` regression seeds an actual stored overlap and exhausted absent head. Its adapter serves older history only for the oldest stored cursor, while a head request returns overlap. It accounts requests through the normal budget observer. Assertions require exactly one older-history request, two stored rows, completed ordinary coverage, cleared checkpoint pin, no next candidate, the original missing head and still-exhausted five-attempt debt. Without the executor fix, the old incremental path keeps selecting the thread and fails these progress/termination assertions. This covers the precise missing behavior rather than merely testing the mode condition.

The updated Decision 326 and runbook now describe this fresh-history mode/cursor behavior, with pinned continuity and exact-ID receipt boundaries preserved. No further actionable correctness, scope or readability findings. The author's final checks are separate; this reviewer ran no tests.

| Final reviewed file | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/sync/executor-handlers.ts` | `0050944a14b370aa78ace433042ea572a39a28cf2b9c6409c9031ed3cbb5aceb` |
| `apps/runtime/src/services/sync/fansly-dm-conversations.ts` | `7331c010dec8ced4bf67560f38871a4032ae7bf3caceb1922e10b39ba85eca43` |
| `packages/db/src/repositories/fansly-dm-head-debt.ts` | `63256c9b40375b7199e06ba04a1cdee75d1dabe598d99e2078187703bd5c7468` |
| `packages/db/src/repositories/page-dm.ts` | `7d78e57cdb9d416f52dd2e3ac805e2cb1909bf618ef8dd7c781d44859b509ccf` |
| `tests/fansly-dm-exhausted-head-history.integration.test.ts` | `82ea0f2d0d537aed0fa70ff127ad7cf35b8096849220b116422c4e5574d73497` |
| `docs/decisions.md` | `6e74e31ec1cf40296fce78ec0756eb0a100b9e8904e7fffc1a2e19029f4740cb` |
| `docs/runbooks/fansly-dm-head-catchup.md` | `df00ca1ca134d502261ea1673d7949c0350ef3effb29a4e31e44b6a7933e175c` |

### Deterministic due fixture follow-up

The only subsequent test change seeds `next_retry_at` at the explicit past instant `2026-01-01` together with the attempt count. This removes an unrelated PostgreSQL-versus-Node current-time race from the active-priority fixture. Cases testing backoff still explicitly set a future deadline afterward. No runtime logic or assertion was weakened; the real message-execution regression is unchanged. The author's first failing receipt is retained separately. No tests rerun by this reviewer. Final test SHA-256: `837b894681a5a38a2aa21a1e770d03270e4be6083d3a62928a09526b85914d26`.

## Final main composition follow-up

Reviewed 2026-09-14T00:53:11.381072+00:00 at merge `7bb73162c6a2dd85802a0fa76a277722c76a5a12` (topic parent `a88871b7`, incoming main `b78752d0d1144a8457638ffb3ae0bda33455fde1`). During review HEAD advanced to `daa7cce1ae9262e0e321611695fc5ac7a931107e` with validation evidence only; all seven source/test/document paths remain byte-identical to that merge. No actionable findings. This is a source/document composition review; no tests run by this reviewer.

All topic source and regression bytes are identical to the previously reviewed topic parent except `executor-handlers.ts`, where incoming C1 changes merged automatically. The exact added/removed topic lines in that handler match the original reviewed patch; its fresh pending-history mode/cursor fix remains unchanged. The final diff against main contains only the four reviewed runtime/repository paths, the new integration test, the two topic documents and its evidence packet. Incoming main C1 diagnostics, durable cooldown queue/executor/incident behavior and their tests are preserved. The DM list wakeup continues through the shared cooldown-preserving request path, so admitting ordinary history does not waive a provider retry deadline.

Removing only the Decision 326 section and its quick-index row reproduces incoming main's decision file exactly (ignoring trailing whitespace). Decision 322 and the C1 Decision 294 refinement are preserved. The runbook is byte-identical to the reviewed topic parent. Decision 326 remains the coordinator's reserved number after 322–325; it does not authorize activation, deletion certification or stage acceptance. The original source manifest intentionally describes the earlier 478f-based validation; the current composition fingerprints are recorded here and final-main test receipts remain separate.

| Final composed file | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/sync/executor-handlers.ts` | `52be63e75bafc73dcb38180d9ef55637a583f70d7692f7d821c0804c10db9048` |
| `apps/runtime/src/services/sync/fansly-dm-conversations.ts` | `7331c010dec8ced4bf67560f38871a4032ae7bf3caceb1922e10b39ba85eca43` |
| `packages/db/src/repositories/fansly-dm-head-debt.ts` | `63256c9b40375b7199e06ba04a1cdee75d1dabe598d99e2078187703bd5c7468` |
| `packages/db/src/repositories/page-dm.ts` | `7d78e57cdb9d416f52dd2e3ac805e2cb1909bf618ef8dd7c781d44859b509ccf` |
| `tests/fansly-dm-exhausted-head-history.integration.test.ts` | `837b894681a5a38a2aa21a1e770d03270e4be6083d3a62928a09526b85914d26` |
| `docs/decisions.md` | `412c01821df4d87f055a8d4109a1a0f72865ebe493aa2d31fc4a6e2fc1f5305f` |
| `docs/runbooks/fansly-dm-head-catchup.md` | `df00ca1ca134d502261ea1673d7949c0350ef3effb29a4e31e44b6a7933e175c` |
