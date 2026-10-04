import { sql, type SQL } from "drizzle-orm";

// The `message_archive` side of the DM readers (step-4 design S4-06/S4-08,
// owner decision №11): what "a stored message of a thread" means when a
// reader serves a page from the archive (the engine's live pages). Shared by
// the archive variants in page-dm.ts and sync/thread-chain.ts, by the thread
// summary the engine writes from the archive (sync/thread-chain.ts) and by the
// read-only reader parity (sync/dm-reader-parity.ts), so the parity measures
// exactly the code that serves. Not exported from the package.

/** A stored message in the archive, as the hot-shaped readers count and show
 *  one: no tombstone, not a tombstone-first stub whose content has not
 *  arrived (`content_pending`), and an instant (the hot table's `created_at`
 *  is NOT NULL, and these readers order and serve by it). */
export function archiveStoredMessageSql(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`${a}.deleted_at is null and ${a}.content_pending = false and ${a}.occurred_at is not null`;
}

/** The archive rows of one DM thread (`page_dm_threads.id`, a value or a
 *  correlated column), aliased `ma`, with the thread as `t` and its page as
 *  `p`: the page's rows of the thread's conversation on the page's platform.
 *  The caller adds the row predicate (usually `archiveStoredMessageSql("ma")`). */
export function archiveThreadRowsFromSql(threadId: number | SQL): SQL {
  return sql`page_dm_threads t
      join pages p on p.id = t.platform_account_id
      join message_archive ma
        on ma.account_id = t.platform_account_id
       and ma.platform = p.platform::text
       and ma.conversation_ref = t.platform_conversation_id
     where t.id = ${threadId}`;
}

/** The archive's `sender_role` as a hot-table role: the archive writes
 *  `model`/`fan` (and copies the hot role on a backfilled row); anything
 *  else reads `unknown`, never a value outside the hot enum. */
export function archiveSenderRole(value: unknown): "fan" | "model" | "system" | "unknown" {
  return value === "fan" || value === "model" || value === "system" ? value : "unknown";
}
