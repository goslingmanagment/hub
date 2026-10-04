import type { FanslyWsHintNode, FanslyWsHintPolicy } from "@agency_hub_core/shared";
import type { Pool } from "pg";

// The rows the retired ws-hints projector filed (step 4, S4-11 removed it):
// one `fansly_ws_hint_receipts` row per canonicalized socket signal and, for a
// hint the page's B1 policy routes, the `fansly_ws_dm` dirty subject the
// legacy B1 step claims. Nothing writes them any more; they stay as records
// that the B1 claims, the archive shadow rebuild, erasure and
// `fansly:ws-recovery-manifest` read. Tests seed them here.

export interface FanslyWsHintReceiptFixture {
  /** The signal's domain event id (the receipt's key). */
  id: number;
  pageId: number;
  observationId: number;
  receivedAt: Date;
  generation: string | null;
  node: FanslyWsHintNode;
}

/** The outcome the projector recorded for a signal under `policy`. */
function receiptOutcome(event: FanslyWsHintReceiptFixture, policy: FanslyWsHintPolicy | null): string {
  const { node } = event;
  if (node.outcome === "not_enabled") return "disabled";
  if (node.outcome !== "hint") return node.outcome;
  if (!event.generation) return "generation_unknown";
  if (!policy || policy.generation !== event.generation || !node.hint || !policy.enabledTypes.has(node.hint.type)) {
    return "disabled";
  }
  return event.receivedAt < new Date(policy.activationAt) ? "before_activation" : "routed";
}

/** Files one receipt as the projector did, in one transaction; a routed hint
 *  also bumps its subject's requested revision (a new generation restarts the
 *  walk). True when the hint was routed now; a repeated event id is a no-op. */
export async function fileFanslyWsHintReceipt(
  pool: Pool,
  event: FanslyWsHintReceiptFixture,
  policy: FanslyWsHintPolicy | null,
): Promise<boolean> {
  const { node } = event;
  const outcome = receiptOutcome(event, policy);
  const groupRef = node.hint?.groupRef ?? node.mutation?.groupRef ?? null;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const filed = await client.query(
      `insert into fansly_ws_hint_receipts (event_id, page_id, observation_id, received_at,
         generation, group_ref, message_ref, hint_type, mutation, outcome)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       on conflict (event_id) do nothing returning event_id`,
      [event.id, event.pageId, event.observationId, event.receivedAt, event.generation, groupRef,
        node.hint?.messageRef ?? node.mutation?.messageRef ?? null, node.hint?.type ?? null,
        node.mutation ? JSON.stringify(node.mutation) : null, outcome],
    );
    const routed = filed.rows.length > 0 && outcome === "routed" && node.hint !== undefined;
    if (routed) {
      const subject = await client.query<{ requested_revision: string }>(
        `insert into subject_refresh_state (page_id, plane, subject_ref, refresh_class,
           dirty_reason, next_due_at, requested_revision, backfill_cursor)
         values ($1, 'fansly_ws_dm', $2, 'dirty', 'ws_hint', $3, 1, jsonb_build_object('generation', $4::text))
         on conflict (page_id, plane, subject_ref) do update set
           requested_revision = subject_refresh_state.requested_revision + 1,
           refresh_class = 'dirty', dirty_reason = 'ws_hint',
           next_due_at = least(subject_refresh_state.next_due_at, excluded.next_due_at),
           backfill_cursor = case when subject_refresh_state.backfill_cursor->>'generation' = $4
             then subject_refresh_state.backfill_cursor else excluded.backfill_cursor end,
           claim_token = case when subject_refresh_state.backfill_cursor->>'generation' = $4
             then subject_refresh_state.claim_token else null end,
           claimed_revision = case when subject_refresh_state.backfill_cursor->>'generation' = $4
             then subject_refresh_state.claimed_revision else null end,
           claim_expires_at = case when subject_refresh_state.backfill_cursor->>'generation' = $4
             then subject_refresh_state.claim_expires_at else null end,
           updated_at = now()
         returning requested_revision::text`,
        [event.pageId, node.hint!.groupRef, event.receivedAt, event.generation],
      );
      await client.query(
        "update fansly_ws_hint_receipts set routed_revision = $2::bigint where event_id = $1",
        [event.id, subject.rows[0]!.requested_revision],
      );
    }
    await client.query("commit");
    return routed;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
