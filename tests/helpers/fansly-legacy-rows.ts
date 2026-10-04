import type { Pool } from "pg";

import type { SyncStream } from "@agency_hub_core/db";

/**
 * The streams the legacy page-sync executor ran on a Fansly page until step 4.
 * A Fansly page of that time holds a `page_sync_states` row for each, as a
 * record (parked by step 4, S4-21). Nothing seeds them any more: the seeder
 * serves the executor's platforms only (S4-24), so a test that needs the rows
 * of an old Fansly page writes them with `seedFormerFanslyRows`.
 */
export const FORMER_FANSLY_STREAMS = [
  "light", "transactions", "top_spenders", "subscribers", "followers", "followers_reconcile", "dm_conversations",
  "dm_messages", "fan_earnings", "purchase_history", "posts", "stats_snapshot", "notifications", "catalog",
  "post_replies", "payouts", "media_stats",
] as const satisfies readonly SyncStream[];

/** The lanes a pre-step-4 planner seeded paused (their rollout gates). */
const SEEDED_PAUSED: readonly SyncStream[] = [
  "posts", "stats_snapshot", "notifications", "catalog", "post_replies", "payouts", "media_stats",
];

/**
 * A Fansly page's legacy rows as a pre-step-4 planner seeded them: each stream
 * pending for recovery with no blocker, the gated lanes paused. Rows the page
 * already has are left as they are.
 */
export async function seedFormerFanslyRows(
  pool: Pool,
  pageId: number,
  now: Date,
  streams: readonly SyncStream[] = FORMER_FANSLY_STREAMS,
): Promise<void> {
  for (const stream of streams) {
    const paused = SEEDED_PAUSED.includes(stream);
    await pool.query(
      `insert into page_sync_states (
         page_id, stream, status, request_seq, applied_seq, request_source, dispatch_source, requested_at,
         cadence_seconds, slot_offset_seconds, last_scheduled_slot, created_at, updated_at
       ) values ($1, $2, $3, $4, 0, $5, $6, $7, 3600, 0, 0, $8, $8)
       on conflict (page_id, stream) do nothing`,
      [
        pageId, stream, paused ? "paused" : "pending", paused ? 0 : 1, paused ? null : "recovery",
        paused ? "scheduled" : "recovery", paused ? null : now, now,
      ],
    );
  }
}
