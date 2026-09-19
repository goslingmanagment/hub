# Voice reset deadlock diagnosis

Reviewed 2026-09-14T01:20:03.007019+00:00 against main `a9794e600dfbb10918800ab5b49241e33d7357a3`, run `34794319085`, Integration 3/3. Local retained-log/source inspection only; no tests or production calls during diagnosis.

**A concrete preceding-test lifecycle leak explains this failure.** PR186's credit fixture is unrelated. The immediately preceding voice case accepts an `end_turn` source, asserts the response is `dispatched`, and ends while the intentional detached worker may still be settling. The next case begins a database-wide test TRUNCATE. The smallest correction is to await the persisted `completed` row using the file's existing `waitFor` pattern before ending that successful-admission case.

Evidence chain (line numbers at the pinned commit):

1. `main-a979-failed.log:1013–1044` places the failure in `beforeEach` at voice test line 113, then `resetIntegrationDatabase` line 198. SQLSTATE is `40P01`; process 253 waits for AccessExclusiveLock on relation 19611 while process 254 waits for RowExclusiveLock on relation 19633. It is not the named pre-erasure test body's assertion. The shard reports 720 passed, one failed across 69 files; 30 of 31 voice cases passed.
2. `tests/voice-notes-service.integration.test.ts:537–543` is the preceding successful `end_turn` admission. It awaits `createVoiceNote` and checks `dispatched`, then ends. No afterEach drain exists; `beforeEach:108–115` immediately resets the shared database for the next case. Comparable earlier cases wait for `completed` at lines 240, 276, 287, 304 and 383–384; the later erasure-positive case does too at 613–617.
3. `apps/runtime/src/services/voice-notes.ts:562–566` explicitly launches `void runGrantedVoiceNoteDispatch` before returning. Its success path at 952–977 settles `voice_notes` and reconciles `voice_char_budget` in one transaction. `packages/db/src/repositories/voice-notes.ts:583–591` performs the budget write after the terminal row update.
4. `tests/helpers/db.ts:181–198` alphabetically orders all public tables and truncates them together. That orders `voice_char_budget` before `voice_notes`, opposite the in-flight completion transaction. This is a concrete lock-cycle mechanism. Relation OIDs were not mapped from a retained server catalog, so naming those two specific OIDs remains an inference; the log and source establish the overlapping lifecycle without a new reproduction.

The runtime's detached 202-style return is intentional. Production does not use the test-wide TRUNCATE reset; this evidence does not establish a production erasure, voice-billing or credit-forecast bug. All four cited files are unchanged by PR186 and unchanged between a979 and merged PR185/main1fe9. The explicit `completed` read observes the committed completion/budget transaction. Subsequent success-path work is dispatcher close and permit release; in this single-dispatch case no queued voice task exists, so waiting for the committed row is enough to prevent the observed reset/database race. No sleep, reset retry or runtime synchronization redesign is needed.

**Rerun guidance:** one failed-only rerun of the immutable old run can show scheduling sensitivity and complete its CI record, but a pass does not repair this identified leak or certify newer main. It is optional and lower-value than the narrow fix plus its focused suite. The CI workflow has no deployment job; however, rerunning failed jobs can unblock Quality Gate and main-only publication of that old commit's immutable image. Preserve the original failure and avoid repeated reruns to obtain a green result. No rerun was triggered by this reviewer.

The coordinator subsequently authorized a separate test-only repair and reserved Decision 330. Diagnosis and implementation evidence remain distinct.

Raw retained log SHA-256: `b3d96383fd9b325e4fb9fa0d7ffd1b486c2e0850ac0557fabfa51838c1397441`.

| Pinned source | SHA-256 |
| --- | --- |
| `tests/voice-notes-service.integration.test.ts` | `b5b7e7c42e52432a3bfa19969b27a37957f3dec051f05d9180e22cd1a1a622f8` |
| `tests/helpers/db.ts` | `3dac28174c8defe479ae1713b16137814e49fe2288cff64def88ed0257e1ed10` |
| `apps/runtime/src/services/voice-notes.ts` | `8fee330555c0690a8bb1c7cc81acc0c8e568918f1dc724d607e31221d3ed191e` |
| `packages/db/src/repositories/voice-notes.ts` | `17a642bcb64ac95a126b09b5b72b76eaf29892c9f72b207ff47120270749c845` |
