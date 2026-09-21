# 05 — Recover retained-only messages without inventing REST membership

Six audited Ari messages have retained WS text but were absent from the ordinary archive. Fixing the queue does not materialize these messages: one group has no REST membership row and another has disappeared from subsequent list responses/returns 500. This is a separate data-plane issue from the four operational defects.

Prepare a bounded recovery procedure using exact retained observation/message IDs and a dry-run manifest: account/generation proof, raw locator, native group/message/sender IDs, timestamp and content shape, current archive presence, later mutation/erasure and normalization blockers. Never dump texts to logs. Prefer any existing supported archive projection/replay route; never insert ad hoc page_dm_threads to fabricate visibility/identity.

If there is no supported WS→archive projector, implement only the safe read-only manifest/provenance checker in this change and document the required explicit B2 design extension rather than falsely claiming recovery. A correct extension must be an idempotent rebuildable projection into the canonical message archive with source provenance, tombstone ordering, unresolved identity state, owner-erasure fencing and no synthetic REST membership/freshness. Its production application is a separate explicit action, preceded by a reviewable exact manifest.

Acceptance of this change: the runbook names the six IDs, shows the distinction between raw-retained and reader-materialized, and gives a reproducible read-only check. Actual production rows are not claimed recovered. Fable must decide whether the existing projection architecture makes an implementation of the bounded manifest straightforward and whether the larger B2 slice should remain separate.
