import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The daily ceiling of an agent key's deletions of published posts
// (delete:posts, owner 2026-11-11; 0369 `agent_post_delete_slots`). A slot is
// RESERVED before the command is sent, in one transaction that holds the key's
// row, so two requests at once can never both take the last one. It is given
// back only when Hub refused before any command of the post existed — never
// when the outcome is unknown or the command went. Hub's request accounting
// (`bumpAgentKeyUsage`) counts and never stops: this one stops.

const DAY_MS = 24 * 60 * 60_000;

export type AgentPostDeleteSlot =
  | { ok: true; slotId: number; used: number }
  /** The ceiling is reached: nothing was reserved. */
  | { ok: false; used: number };

/**
 * Reserve one deletion of `postRef` for the key, unless its slots of the last
 * 24 hours already reach `limit` (0: no ceiling, the slot is still recorded).
 * `used` counts the reserved slots after this one.
 */
export async function reserveAgentPostDeleteSlot(db: Database, input: {
  agentKeyId: number;
  pageId: number;
  platform: "fansly" | "onlyfans";
  postRef: string;
  limit: number;
  now?: Date;
}): Promise<AgentPostDeleteSlot> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - DAY_MS);
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    // The key's row: every reservation of the key waits here for the one before.
    await tx.execute(sql`select id from agent_keys where id = ${input.agentKeyId} for update`);
    const counted = await tx.execute<{ used: number }>(sql`
      select count(*)::int as used from agent_post_delete_slots
       where agent_key_id = ${input.agentKeyId} and released_at is null and reserved_at > ${since}
    `);
    const used = Number(counted.rows[0]?.used ?? 0);
    if (input.limit > 0 && used >= input.limit) return { ok: false as const, used };
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into agent_post_delete_slots (agent_key_id, page_id, platform, post_ref, reserved_at)
      values (${input.agentKeyId}, ${input.pageId}, ${input.platform}, ${input.postRef}, ${now})
      returning id::text
    `);
    return { ok: true as const, slotId: Number(inserted.rows[0]!.id), used: used + 1 };
  });
}

/** Give a slot back: Hub refused before any command of the post existed. */
export async function releaseAgentPostDeleteSlot(db: Database, input: { slotId: number; reason: string }): Promise<void> {
  await db.execute(sql`
    update agent_post_delete_slots set released_at = now(), released_reason = ${input.reason.slice(0, 200)}
     where id = ${input.slotId} and released_at is null
  `);
}

/** The key's reserved slots of the last 24 hours. */
export async function countAgentPostDeleteSlots(db: Database, input: { agentKeyId: number; now?: Date }): Promise<number> {
  const since = new Date((input.now ?? new Date()).getTime() - DAY_MS);
  const result = await db.execute<{ used: number }>(sql`
    select count(*)::int as used from agent_post_delete_slots
     where agent_key_id = ${input.agentKeyId} and released_at is null and reserved_at > ${since}
  `);
  return Number(result.rows[0]?.used ?? 0);
}
