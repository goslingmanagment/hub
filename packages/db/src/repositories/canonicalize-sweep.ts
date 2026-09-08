import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";

export interface CanonicalizeSweepCursor {
  key: string;
  afterId: number | null;
  revision: number;
}

/** Called only by a write-mode background sweep, never an explicit/dry replay. */
export async function getCanonicalizeSweepCursor(db: Database, key: string): Promise<CanonicalizeSweepCursor> {
  await db.execute(sql`insert into canonicalize_sweep_cursors(key) values(${key}) on conflict do nothing`);
  const row = (await db.execute<{ after_id: string | null; revision: string }>(sql`
    select after_id::text, revision::text from canonicalize_sweep_cursors where key=${key}
  `)).rows[0];
  if (!row) throw new Error("Canonicalization sweep cursor is missing");
  return { key, afterId: row.after_id === null ? null : Number(row.after_id), revision: Number(row.revision) };
}

/** Commit only after a whole page was attempted. A crash may repeat a page;
 * the event dedup/stamp transaction makes repetition safe. A concurrent sweep
 * cannot replace another traversal's progress, including its wrap to the head. */
export async function advanceCanonicalizeSweepCursor(
  db: Database, cursor: CanonicalizeSweepCursor, afterId: number | null,
): Promise<CanonicalizeSweepCursor> {
  const result = await db.execute(sql`
    update canonicalize_sweep_cursors
    set after_id=${afterId},revision=revision+1,updated_at=now()
    where key=${cursor.key} and revision=${cursor.revision}
    returning key
  `);
  if (result.rows.length !== 1) throw new Error("Canonicalization sweep cursor changed concurrently");
  return { key: cursor.key, afterId, revision: cursor.revision + 1 };
}
