import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";

// The legacy socket-hint path (B1) kept its per-group walk state in
// subject_refresh_state under this plane. The path is gone since step 4
// (S4-14); its rows stay as records, read only by the shadow report's replay
// below and by erasure.
const FANSLY_WS_DM_PLANE = "fansly_ws_dm";

/**
 * The groups of a page that legacy's socket-hint path (B1) holds deferred as
 * `membership_pending` after it journaled their group detail: chats it has no
 * thread for and leaves for the list to bind. Read-only (the shadow report's
 * replay, design §3.12 B5).
 */
export async function listLegacyWsHintMembershipPending(
  db: Database,
  input: { pageId: number; groupRefs: readonly string[] },
): Promise<string[]> {
  const refs = [...new Set(input.groupRefs)];
  if (refs.length === 0) return [];
  const result = await db.execute<{ groupRef: string }>(sql`
    select s.subject_ref as "groupRef"
      from subject_refresh_state s
     where s.page_id = ${input.pageId}
       and s.plane = ${FANSLY_WS_DM_PLANE}
       and s.subject_ref = any(${sql.param(refs)}::text[])
       and s.last_refresh_outcome = 'membership_pending'
       and s.backfill_cursor->>'groupDetailCaptured' = 'true'
     order by s.subject_ref
  `);
  return result.rows.map((row) => row.groupRef);
}
