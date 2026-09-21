# Independent Fable implementation review

Model: claude-fable-5-1; 51 turns; successful; no permission denials.

**Verdict: no blockers. Mergeable after two small fixes.** The disposition's three corrections are all implemented as stated, and I could not construct a counterexample against the settlement, attribution, or repair CAS logic.

## Verified against the disposition

- **Account token bound independently.** Preview and apply both compare the account/me `observedAccountId` with the page row, through the page dispatcher, with direct egress refused (`apps/runtime/src/services/fansly-ws-policy-repair.ts:77`, `:96`, `fansly-binding-preflight.ts:40`). Generation is rechecked under the share locks inside a serializable transaction with config version CAS (`fansly-ws-policy-repair.ts:102-127`).
- **Mismatch is informational only.** It lands in `blocks.messages_live.metrics` (`sync-status.ts:1773`) and the test proves health issues are byte-identical with and without it.
- **Settlement survives generation replacement.** Evidence is written on the receipt row in the completing advance transaction, scoped to the claim policy and the bound conversation (`packages/db/src/repositories/fansly-ws-hints.ts:231-251`). Delete matching requires page, group, message, generation and ordered receipt; a null group cannot match; bulk is ignored. Deleted-only rows never get `hot_applied_at`. Constraints are consistent for both hint types.
- **Attribution fires in production.** The adapter rethrows the raw transport error (`packages/shared/src/http-request.ts:126`, `packages/fansly/src/adapter.ts:2041`), so the non-FanslyApiError branch at `sync/fansly-ws-hints.ts:247` is reachable. Lease-lost aborts are `policy`. Evidence is set only after telemetry succeeds. R+1 routing leaves `retry_after_at` alone.
- **A0.** Invalid A1 proof yields null rather than the legacy timestamp; existing diagnostics win; a partial cursor without diagnostics stays incomplete. Migration 0205 appends view columns in 0197's order and is rollback-safe.

## Findings

**M1. A deferral inside the catch can escape as a chunk failure.** `sync/fansly-ws-hints.ts:241-249` calls `defer`, which runs `owned`, which throws `HintDeferred("generation_changed")` at line 43. Counterexample: credentials rotate after the claim, then the admitted request fails on transport. The catch calls `defer`, `owned` throws, the error leaves the step, `fanslyDmMessagesChunk` fails, ordinary polling skips the chunk and the claim stays held up to five minutes. This shape predates the change, but the new isolation promise makes it visible. Fix: wrap the three `defer` calls in the catch so a `HintDeferred` thrown by the deferral returns quietly; everything else still propagates.

**M2. The initial-checkpoint diagnostics have no direct test.** `fansly-dm-conversations.ts:354-358` is the line the disposition added for crash-before-first-page with A1 off. The test at `tests/fansly-dm-bounded.integration.test.ts:136-155` reads two pages before resuming, so it passes with that line deleted because diagnostics ride page writes. Add a case: A1 off, first page fetch throws after the fresh-sweep checkpoint, resume, assert `boundaryMs` equals the prior completion and coverage is complete.

**L1. Pre-0205 rows can become `source_deleted` while keeping `hot_applied_at`.** The settlement `where` at repository line 240 has no lower bound on `routed_revision`. A receipt stamped hot before the migration whose message was later soft-deleted in hot, with a matching delete receipt, is re-evaluated and gets `source_deleted`. The runbook says that combination cannot occur. Minimal fix: treat `r.hot_applied_at is not null` as materialized in the evidence CTE.

**L2. Preview spends a physical account/me request even when generations already match** (`fansly-ws-policy-repair.ts:74-81`). Compute `already_matching` from the snapshot before calling `inspectBinding`.

**L3. `textSha256` of short content is dictionary-recoverable** (`fansly-ws-recovery-manifest.ts:99`). The spec asked for a hash, so this is a note, not a defect. Also `refs` includes an empty string when the partner is unknown (line 57); filter it.

**L4. CLI `--apply` on a blocked preview reports a page mismatch** (`cli.ts:1774`) because `proposal` is null. Check for null first.

**L5. Accidental complexity.** The new partial index in 0205 was judged unnecessary in the plan review and the disposition did not reinstate it. It is harmless, but forward-only migrations mean dropping it later costs another one.

## Test challenges

Missing cases worth adding: target present in REST and a delete receipt exists must yield `rest_materialized`; a delete arriving during a five-page walk must not bypass `walk_limit`; and M2 above. The `target_unconfirmed` path retries every minute with no backoff until the 24-hour budget is spent, which is bounded by design but worth stating in the runbook.
