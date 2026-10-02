import { sql } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { toDate } from "./values.ts";

// The step-3 switch's reads of the legacy engine's state (design step 3 §3.5
// item 7, phase I; J5). Read-only towards every legacy table: the switch
// carries what the legacy engine knew into the engine's own rows and never
// writes `page_sync_states`, `page_sync_cursors`, `page_sync_provider_holds`
// or `sync_rate_limits`, so a rollback resumes the legacy engine from its own
// marks.

/** The handover refusal the legacy engine meets at the guard (§2.7): never a
 *  vendor failure of a chat, so never carried as a breaker. */
const HANDOVER_REFUSAL_PATTERNS = ["%FanslyPageOwnedBySyncEngineError%", "%fansly_sync_engine_owned%"];

export interface LegacyDmQuarantine {
  groupId: string;
  failureCount: number;
  /** greatest(next_retry_at, quarantine_until) — when the legacy engine
   *  would have tried the chat again. */
  breakerUntil: Date;
  errorClass: string | null;
}

/**
 * The page's chats whose legacy per-chat breaker (`page_dm_message_sync_health`)
 * is still in force — except a breaker armed by the handover refusal itself,
 * or by a failure recorded after the switch began (`startedAfter`).
 */
export async function listLegacyDmQuarantines(
  db: Database,
  input: { pageId: number; startedAfter: Date | null },
): Promise<LegacyDmQuarantine[]> {
  const started = input.startedAfter === null ? sql`'infinity'::timestamptz` : sql`${input.startedAfter}::timestamptz`;
  const result = await db.execute<{
    groupId: string;
    failureCount: number;
    breakerUntil: Date | string;
    errorClass: string | null;
  }>(sql`
    select t.platform_conversation_id as "groupId",
           h.failure_count as "failureCount",
           greatest(h.next_retry_at, h.quarantine_until) as "breakerUntil",
           h.error_class as "errorClass"
      from page_dm_message_sync_health h
      join page_dm_threads t on t.id = h.conversation_id
     where h.platform_account_id = ${input.pageId}
       and t.platform_account_id = ${input.pageId}
       and greatest(h.next_retry_at, h.quarantine_until) > clock_timestamp()
       and h.failure_count > 0
       and not (coalesce(h.last_error, '') like any(${sql.param(HANDOVER_REFUSAL_PATTERNS)}::text[]))
       and not (coalesce(h.error_class, '') like any(${sql.param(HANDOVER_REFUSAL_PATTERNS)}::text[]))
       and (h.last_attempt_at is null or h.last_attempt_at <= ${started})
     order by t.platform_conversation_id
  `);
  return result.rows.map((row) => ({
    groupId: row.groupId,
    failureCount: Number(row.failureCount),
    breakerUntil: toDate(row.breakerUntil)!,
    errorClass: row.errorClass,
  }));
}

/**
 * The legacy head debt of the page (`fansly_dm_head_debt`, decision 277):
 * expected messages no read captured yet, on chats the engine may read — bound
 * to a fan, visible, not excluded.
 */
export async function listLegacyDmHeadDebt(
  db: Database,
  input: { pageId: number },
): Promise<Array<{ groupId: string; messageIds: string[] }>> {
  const result = await db.execute<{ groupId: string; messageIds: string[] }>(sql`
    select t.platform_conversation_id as "groupId",
           array_agg(d.message_id order by d.message_id) as "messageIds"
      from fansly_dm_head_debt d
      join page_dm_threads t on t.id = d.conversation_id
     where t.platform_account_id = ${input.pageId}
       and d.captured_at is null
       and d.attempts < 5
       and t.fan_id is not null
       and t.is_visible
       and not (t.metadata ? 'messageSyncExcludedReason')
     group by t.platform_conversation_id
     order by t.platform_conversation_id
  `);
  return result.rows.map((row) => ({ groupId: row.groupId, messageIds: [...row.messageIds] }));
}

/**
 * The confirmations the legacy engine owed (G22, import I.3b): chats with an
 * overlay row of the page that nothing confirmed and nothing deleted, first
 * seen within the last 24 h.
 */
export async function listUnconfirmedOverlayChats(
  db: Database,
  input: { pageId: number },
): Promise<Array<{ groupId: string; messageIds: string[] }>> {
  const result = await db.execute<{ groupId: string; messageIds: string[] }>(sql`
    select m.platform_conversation_id as "groupId",
           array_agg(m.platform_message_id order by m.platform_message_id) as "messageIds"
      from dm_live_messages m
     where m.page_id = ${input.pageId}
       and m.confirmed_at is null
       and m.deleted_at is null
       and m.platform_conversation_id is not null
       and m.first_visible_at > clock_timestamp() - interval '24 hours'
     group by m.platform_conversation_id
     order by m.platform_conversation_id
  `);
  return result.rows.map((row) => ({ groupId: row.groupId, messageIds: [...row.messageIds] }));
}

/** The legacy provider hold of the page still in force (a 429 the legacy
 *  engine is waiting out), or null. */
export async function readActiveLegacyProviderHold(
  db: Database,
  pageId: number,
): Promise<{ holdUntil: Date; reason: string; stream: string } | null> {
  const result = await db.execute<{ holdUntil: Date | string; reason: string; stream: string }>(sql`
    select hold_until as "holdUntil", reason, stream::text as stream
      from page_sync_provider_holds
     where page_id = ${pageId}
       and hold_until > clock_timestamp()
  `);
  const row = result.rows[0];
  return row ? { holdUntil: toDate(row.holdUntil)!, reason: row.reason, stream: row.stream } : null;
}

/** Whether a legacy stream of the page is blocked on its credentials
 *  (`page_sync_states.blocker_kind = 'auth'`). */
export async function readLegacyAuthBlocker(db: Database, pageId: number): Promise<{ streams: string[] } | null> {
  const result = await db.execute<{ stream: string }>(sql`
    select stream::text as stream
      from page_sync_states
     where page_id = ${pageId}
       and blocker_kind = 'auth'
     order by stream
  `);
  return result.rows.length === 0 ? null : { streams: result.rows.map((row) => row.stream) };
}
