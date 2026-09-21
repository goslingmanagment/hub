# Review decisions before implementation

Fable reviewed the source and plans using claude-fable-5-1. No application code existed when it reviewed them.

- Accept B1: correlationRef/bulk alone does not invalidate an exact message address. Require matching page, group, message and generation, plus ordered receipt time. A read-only production query on 2026-09-22 (creates from Sep17 through Sep21 21:20Z) found 67 matching unresolved create/delete pairs: all same group/generation, bulk=false, correlationRef present. Missing/foreign group never settles. This count is pairs, not lost messages.
- Accept B2 diagnosis, reject removing account verification: the generation binds the stored token bytes and expected account, not the actual account authenticated by those bytes. Reuse inspectFanslyBinding/account-me through the exact page dispatcher before preview/apply, then recheck generation under lock. A transient connection alone cannot authorize repair.
- Accept B3: mismatch is informational in detailed status/CLI; it must not degrade the deployment health gate.
- Keep durable settlement fields despite the suggested derived view: a later generation replaces the subject cursor, and type/activation changes can skip a receipt. Applied revision alone is not a permanent per-receipt proof. Write receipt evidence in the existing advance transaction, only for the claim policy and exact bound conversation. No second write authority.
- Accept observer attribution and existing consecutive_failures for bounded backoff. Set terminal evidence only after telemetry succeeds, for the admitted request id, and only transport/timeout. Policy/capture/DB/telemetry errors propagate.
- Keep minimal A0 resolution but persist diagnostics in the initial progress checkpoint. This closes the crash-before-first-page case when A1 is disabled and no polling proof is copied into the new full cursor. Existing diagnostics always win; an already-partial cursor with no diagnostics stays incomplete.
- Manifest is one bounded read-only command, not a recovery framework. B2 materialization remains a separate explicit design and production action.

Implementation order: 04, 02, 01, 03, 05. Targeted integration tests first; final repository checks and independent Fable code review after implementation.

## Implementation review and verified fixes

Fable found no architectural blockers in its implementation review. M1/M2 and
low-priority compatibility/diagnostic findings were addressed before completion:

- M1: a generation change can revoke the error deferral itself; only HintDeferred
  from that deferral is now a quiet return. No stale write is allowed, and lease/DB
  failure still propagates. New tests prove rotation versus lease loss.
- M2: new regression fails the first full-page request after A1 is disabled and
  proves the boundary is already in the zero-page checkpoint, then resumes fully.
- L1: an existing hot_applied_at remains historical materialization evidence;
  pre-0205 receipts cannot be reclassified source_deleted after a later tombstone.
- L2/L4: a matching policy preview makes no account/me request; applying a blocked
  preview reports the absent proposal before testing its page.
- L3: removed the short-content digest, retained the envelope hash and text length,
  and filtered empty refs. The output never contains message text.
- L5: retain the partial exact-delete index. The existing page/group index must
  filter every receipt in a busy group per target; receipts accumulate durably.
  A separate disposable PostgreSQL 16 experiment with 20,000 synthetic same-group
  delete receipts inspected 19,999 irrelevant rows without the index (385 buffer
  hits, 1.073 ms) and used the exact index with 7 buffers (0.031 ms). This supports
  bounded lookup cost, not a claim about production throughput. Raw EXPLAIN is
  in delete-index-explain.txt; the disposable container was removed.

Fable's focused follow-up explicitly confirms M1/M2/L1–L4 are addressed with no
remaining blockers. Its type/lint follow-ups are covered by the final pnpm check.
The additional live read used only read_only; no production mutation occurred.
