# 01 — Settle a deleted B1 target without pretending it was materialized

## Root cause

hasUnconfirmedFanslyWsHintTargets requires a live page_dm_messages row for every routed message_created. A later exact delete can never satisfy it. advanceFanslyWsHint then repeats the original head read every minute; newer messages may already be saved while the group consumes the rolling attempt cap forever.

## Proposed change

Add forward-compatible nullable operational settlement fields to fansly_ws_hint_receipts: settled_at, settlement_kind (rest_materialized / source_deleted / group_checked) and the retained deletion observation reference when applicable. Keep hot_applied_at for the existing REST/materialized meaning only. Expose the distinction in fansly_ws_hint_status, retaining its existing columns and meanings. Existing materialized receipts can read as settled via coalesce; no forced history rewrite is required.

Use one shared SQL target-evidence expression/helper for the unconfirmed check and receipt settlement. A message target is confirmed by an exact live row in its bound conversation OR by an unambiguous retained mutation_debt receipt for the same page, group, message and generation received at/after its create receipt. A null/foreign group, foreign generation, missing exact message address or older deletion is not enough. A correlationRef or bulk flag does not negate a matching exact message address. The delete is terminal source evidence for this target only; its mutation receipt stays retained and is not falsely marked as business-applied.

Only consider the claimed revision and enabled message type after activation. Settle after a contiguous, fully normalized REST walk reaches its original boundary/exhaustion; a delete cannot bypass missing middle pages or unnormalized material. Update settlement with the existing subject-claim CAS and writer/generation fences in the same transaction. Preserve newer R+1, and never stamp a deleted target hot_applied_at. A later exact retained delete must allow an already-stuck claim to complete on its next eligible visit.

Add an index for the exact delete lookup if the query requires it, limited to mutation_debt; do not scan all frames per target. Update the runbook and error/receipt documentation. Keep provider deletions separate from owner erasure.

## Acceptance

DB integration: create→delete→REST boundary closes the group; mixed deleted and stored targets settle correctly; deleted-only target is visibly source_deleted with null hot_applied_at; wrong page/group/generation, missing exact address or old delete cannot settle; unrelated missing target keeps debt; incomplete staged walk stays pending; late R+1 survives; replay is idempotent; erasure and lost-lease fencing remain. Existing runtime/DB hint tests stay green.
