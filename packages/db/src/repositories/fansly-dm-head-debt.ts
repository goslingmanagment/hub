import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

/** Called in the list writer's owned transaction, after capture and the erasure
 * fence. A later head never replaces an earlier unconfirmed ID. */
export async function observeFanslyDmHead(
  db: Database,
  input: { conversationId: number; messageId: string | null; messageAt: Date | null },
): Promise<void> {
  if (input.messageId === null) return;
  await db.execute(sql`
    insert into fansly_dm_head_debt (conversation_id, message_id, message_at)
    select ${input.conversationId}, ${input.messageId}, ${input.messageAt}::timestamptz
    where not exists (
      select 1 from page_dm_messages m
      where m.conversation_id = ${input.conversationId}
        and m.platform_message_id = ${input.messageId} and m.deleted_at is null
    )
    on conflict (conversation_id, message_id) do nothing
  `);
}

/** Exact stored identity is the receipt; newest timestamp/ID and HTTP success
 * cannot substitute for it. Also used by the targeted writer and debt repair. */
export async function resolveCapturedFanslyDmHeads(db: Database, conversationId: number): Promise<void> {
  await db.execute(sql`
    update fansly_dm_head_debt d set captured_at = now()
    where d.conversation_id = ${conversationId} and d.captured_at is null
      and exists (
        select 1 from page_dm_messages m
        where m.conversation_id = d.conversation_id
          and m.platform_message_id = d.message_id and m.deleted_at is null
      )
  `);
}

/** Called once per completed head walk in its checkpoint transaction. Backfill
 * of old history and summary-only repair are not head attempts. */
export async function recordFanslyDmHeadAttempt(
  db: Database,
  input: { conversationId: number; messageId: string; startedAt: Date; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await resolveCapturedFanslyDmHeads(db, input.conversationId);
  await db.execute(sql`
    update fansly_dm_head_debt d
    set attempts = d.attempts + 1, last_attempt_at = ${now}::timestamptz,
        next_retry_at = ${now}::timestamptz +
          case d.attempts when 0 then interval '1 minute'
            when 1 then interval '5 minutes' when 2 then interval '15 minutes'
            else interval '1 hour' end
    where d.conversation_id = ${input.conversationId} and d.message_id = ${input.messageId}
      and d.captured_at is null
      and d.attempts < 5 and d.next_retry_at <= ${input.startedAt}::timestamptz
      and d.first_observed_at <= ${input.startedAt}::timestamptz
  `);
}

export async function nextFanslyDmHeadRetryAt(
  db: Database, input: { platformAccountId: number; conversationId?: number },
): Promise<Date | null> {
  const result = await db.execute<{ retry_at: Date | string | null }>(sql`
    select min(greatest(d.next_retry_at, h.next_retry_at, h.quarantine_until)) as retry_at
    from fansly_dm_head_debt d
    join page_dm_threads c on c.id = d.conversation_id
    left join page_dm_message_sync_health h on h.conversation_id = c.id
    where c.platform_account_id = ${input.platformAccountId}
      and c.is_visible and c.fan_id is not null
      and coalesce(c.metadata ->> 'messageSyncExcludedReason', '') = ''
      and d.captured_at is null and d.attempts < 5
      ${input.conversationId === undefined ? sql`` : sql`and c.id = ${input.conversationId}`}
  `);
  const value = result.rows[0]?.retry_at;
  return value == null ? null : new Date(value);
}

export async function getFanslyDmHeadTarget(
  db: Database, input: { conversationId: number; messageId?: string },
): Promise<{ messageId: string; captured: boolean; attempts: number; lastAttemptAt: Date | null } | null> {
  const result = await db.execute<{
    message_id: string; captured_at: Date | null; attempts: number; last_attempt_at: Date | string | null;
  }>(sql`
    select d.message_id, d.captured_at, d.attempts, d.last_attempt_at
    from fansly_dm_head_debt d where d.conversation_id = ${input.conversationId}
      ${input.messageId === undefined ? sql`and d.captured_at is null and d.attempts < 5
        and d.next_retry_at <= now()` : sql`and d.message_id = ${input.messageId}`}
    order by d.first_observed_at, d.message_id limit 1
  `);
  const row = result.rows[0];
  return row ? {
    messageId: row.message_id, captured: row.captured_at !== null, attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at === null ? null : new Date(row.last_attempt_at),
  } : null;
}

/** Any uncaptured identity remains unresolved, including exhausted debt.
 * Queue admission separately checks whether its bounded retries remain. */
export async function hasUnresolvedFanslyDmHead(db: Database, conversationId: number): Promise<boolean> {
  const result = await db.execute<{ present: boolean }>(sql`
    select exists (select 1 from fansly_dm_head_debt d
      where d.conversation_id = ${conversationId} and d.captured_at is null) as present
  `);
  return result.rows[0]?.present === true;
}
