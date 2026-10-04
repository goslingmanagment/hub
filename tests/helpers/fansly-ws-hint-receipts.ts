import type { FanslyWsHintNode } from "@agency_hub_core/shared";
import type { Pool } from "pg";

// The rows the retired ws-hints projector filed (step 4, S4-11 removed it):
// one `fansly_ws_hint_receipts` row per canonicalized socket signal. Nothing
// writes them any more, and the B1 policy that routed a hint to the legacy DM
// step went with its config keys (S4-26); the rows stay as records that the
// archive shadow rebuild, erasure and `fansly:ws-recovery-manifest` read.
// Tests seed them here.

export interface FanslyWsHintReceiptFixture {
  /** The signal's domain event id (the receipt's key). */
  id: number;
  pageId: number;
  observationId: number;
  receivedAt: Date;
  generation: string | null;
  node: FanslyWsHintNode;
}

/** The outcome the projector recorded for a signal no B1 policy routed. */
function receiptOutcome(event: FanslyWsHintReceiptFixture): string {
  const { node } = event;
  if (node.outcome === "not_enabled") return "disabled";
  if (node.outcome !== "hint") return node.outcome;
  return event.generation ? "disabled" : "generation_unknown";
}

/** Files one receipt as the projector did for an unrouted signal; a repeated
 *  event id is a no-op. */
export async function fileFanslyWsHintReceipt(pool: Pool, event: FanslyWsHintReceiptFixture): Promise<void> {
  const { node } = event;
  const groupRef = node.hint?.groupRef ?? node.mutation?.groupRef ?? null;
  await pool.query(
    `insert into fansly_ws_hint_receipts (event_id, page_id, observation_id, received_at,
       generation, group_ref, message_ref, hint_type, mutation, outcome)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
     on conflict (event_id) do nothing`,
    [event.id, event.pageId, event.observationId, event.receivedAt, event.generation, groupRef,
      node.hint?.messageRef ?? node.mutation?.messageRef ?? null, node.hint?.type ?? null,
      node.mutation ? JSON.stringify(node.mutation) : null, receiptOutcome(event)],
  );
}
