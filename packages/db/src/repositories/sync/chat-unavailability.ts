import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { generationParam, timestampParam, toDate, toRequiredDate } from "./values.ts";

// Fansly Sync Engine: the chat-unavailability episode of a page × chat
// (`page_dm_thread_unavailability`, migration
// `*_page_dm_thread_unavailability.sql`; arena "vanished chat", plan §2):
// "Fansly does not serve this chat's history to this page since T", with the
// attempts and the raw answers that prove it.
//
// The page's actor is the one writer (the owner's note aside): a qualifying
// refusal of the chat's head opens or advances the episode in the capture
// transaction (`recordChatHeadRefusal`); an applied head read, or a plan that
// closes the chat's work because the chat was excluded or unbound, ends it
// (`endChatUnavailability`). Readers: the DM planner (no head read before
// `retry_not_before`), the list's follow-ups (`handled_list_head_id`), the
// history intake, the passive parity pass (`openChatUnavailabilitySql`).
//
// The row names its chat by `thread_id` only — no fan identity, no page key:
// an erasure deletes the thread and the episodes go with it (cascade).

export const CHAT_UNAVAILABILITY_STATES = ["refusing", "established"] as const;
export type ChatUnavailabilityState = (typeof CHAT_UNAVAILABILITY_STATES)[number];

export const CHAT_UNAVAILABILITY_END_REASONS = ["read_served", "thread_excluded", "thread_unbound"] as const;
export type ChatUnavailabilityEndReason = (typeof CHAT_UNAVAILABILITY_END_REASONS)[number];

/** The episode's own qualifying refusals at which it is established (plan
 *  §2.2): never the work row's `blocked_by_vendor`, which counts answers
 *  without Fansly's envelope too. */
export const CHAT_UNAVAILABILITY_ESTABLISH_AFTER = 5;

/** What an established episode writes elsewhere: the close reason of the
 *  chat's work rows (`sync_work.close_reason`), the wait reason of its
 *  socket messages (`dm_live_messages.confirm_wait_reason`) and the excluded
 *  reason of its refused history fans (`history_request_items.excluded_reason`). */
export const CHAT_UNAVAILABLE_REASON = "chat_unavailable";

const DECIMAL_ID = /^[0-9]{1,30}$/;

export interface ChatUnavailabilityEpisode {
  id: number;
  threadId: number;
  /** The thread's page and group id (the episode keeps neither itself). */
  pageId: number;
  groupId: string;
  state: ChatUnavailabilityState;
  openedAt: Date;
  establishedAt: Date | null;
  endedAt: Date | null;
  endReason: ChatUnavailabilityEndReason | null;
  refusals: number;
  lastRefusalAt: Date;
  lastHttpStatus: number | null;
  retryNotBefore: Date | null;
  firstAttemptId: number;
  lastAttemptId: number;
  firstObservation: { id: number; receivedAt: Date };
  lastObservation: { id: number; receivedAt: Date };
  handledListHeadId: string | null;
  ownerNote: string | null;
  ownerNoteAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type EpisodeSqlRow = {
  id: string;
  threadId: string;
  pageId: string;
  groupId: string;
  state: ChatUnavailabilityState;
  openedAt: Date | string;
  establishedAt: Date | string | null;
  endedAt: Date | string | null;
  endReason: ChatUnavailabilityEndReason | null;
  refusals: number;
  lastRefusalAt: Date | string;
  lastHttpStatus: number | null;
  retryNotBefore: Date | string | null;
  firstAttemptId: string;
  lastAttemptId: string;
  firstObservationId: string;
  firstObservationReceivedAt: Date | string;
  lastObservationId: string;
  lastObservationReceivedAt: Date | string;
  handledListHeadId: string | null;
  ownerNote: string | null;
  ownerNoteAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/** The columns of `page_dm_thread_unavailability e` joined to its thread `t`. */
const episodeColumns = sql`
  e.id::text as id,
  e.thread_id::text as "threadId",
  t.platform_account_id::text as "pageId",
  t.platform_conversation_id as "groupId",
  e.state,
  e.opened_at as "openedAt",
  e.established_at as "establishedAt",
  e.ended_at as "endedAt",
  e.end_reason as "endReason",
  e.refusals,
  e.last_refusal_at as "lastRefusalAt",
  e.last_http_status as "lastHttpStatus",
  e.retry_not_before as "retryNotBefore",
  e.first_attempt_id::text as "firstAttemptId",
  e.last_attempt_id::text as "lastAttemptId",
  e.first_observation_id::text as "firstObservationId",
  e.first_observation_received_at as "firstObservationReceivedAt",
  e.last_observation_id::text as "lastObservationId",
  e.last_observation_received_at as "lastObservationReceivedAt",
  e.handled_list_head_id as "handledListHeadId",
  e.owner_note as "ownerNote",
  e.owner_note_at as "ownerNoteAt",
  e.created_at as "createdAt",
  e.updated_at as "updatedAt"
`;

function normalizeEpisode(row: EpisodeSqlRow): ChatUnavailabilityEpisode {
  return {
    id: Number(row.id),
    threadId: Number(row.threadId),
    pageId: Number(row.pageId),
    groupId: row.groupId,
    state: row.state,
    openedAt: toRequiredDate(row.openedAt),
    establishedAt: toDate(row.establishedAt),
    endedAt: toDate(row.endedAt),
    endReason: row.endReason,
    refusals: Number(row.refusals),
    lastRefusalAt: toRequiredDate(row.lastRefusalAt),
    lastHttpStatus: row.lastHttpStatus === null ? null : Number(row.lastHttpStatus),
    retryNotBefore: toDate(row.retryNotBefore),
    firstAttemptId: Number(row.firstAttemptId),
    lastAttemptId: Number(row.lastAttemptId),
    firstObservation: { id: Number(row.firstObservationId), receivedAt: toRequiredDate(row.firstObservationReceivedAt) },
    lastObservation: { id: Number(row.lastObservationId), receivedAt: toRequiredDate(row.lastObservationReceivedAt) },
    handledListHeadId: row.handledListHeadId,
    ownerNote: row.ownerNote,
    ownerNoteAt: toDate(row.ownerNoteAt),
    createdAt: toRequiredDate(row.createdAt),
    updatedAt: toRequiredDate(row.updatedAt),
  };
}

/** The later of two decimal message ids (snowflakes): by length, then
 *  bytewise — null when both are null. */
function laterIdSql(stored: SQL, candidate: SQL): SQL {
  return sql`case
    when ${candidate} is null then ${stored}
    when ${stored} is null then ${candidate}
    when (length(${candidate}), ${candidate} collate "C") > (length(${stored}), ${stored} collate "C") then ${candidate}
    else ${stored} end`;
}

export interface ChatHeadRefusalInput {
  pageId: number;
  /** The chat (`page_dm_threads.platform_conversation_id`). */
  groupId: string;
  /** The page's owner generation: an actor that lost the page writes nothing. */
  generation: bigint;
  attemptId: number;
  httpStatus: number | null;
  /** The refused answer as journaled (`<kind>:failed`). */
  observation: { id: number; receivedAt: Date };
  /** The capture's instant. */
  at: Date;
  /** Established after this refusal: no head read before this instant. Only
   *  ever moved later. */
  retryNotBefore: Date;
  /** Established after this refusal: the newest list head this read answered
   *  (the thread's, or a demanded id). Only ever moved later. */
  handledListHeadId: string | null;
  /** Default `CHAT_UNAVAILABILITY_ESTABLISH_AFTER`. */
  establishAfter?: number;
}

export interface ChatHeadRefusalRecord {
  episode: ChatUnavailabilityEpisode;
  /** This refusal opened the episode. */
  opened: boolean;
  /** This refusal established it (its refusals reached the threshold now). */
  establishedNow: boolean;
}

/**
 * One qualifying refusal of a chat's head (plan §2.2), in the capture
 * transaction of its attempt: the chat's open episode takes it (refusals + 1,
 * the latest attempt and raw answer, `established` at the threshold — then
 * the retry boundary and the answered list head, only ever later), or a new
 * episode opens with it. One `insert … select … from page_dm_threads`: a chat
 * without a thread row gets no episode, and neither does an actor whose
 * generation lost the page. An attempt is counted once (the latest attempt
 * only moves forward). Null: nothing was written (no thread, a foreign
 * generation, the attempt counted already).
 *
 * The thread's foreign key takes the thread `for key share`; a thread being
 * deleted (an erasure) makes this wait and then fail — run it under a
 * savepoint, so the capture survives without its episode.
 */
export async function recordChatHeadRefusal(tx: Database, input: ChatHeadRefusalInput): Promise<ChatHeadRefusalRecord | null> {
  const threshold = input.establishAfter ?? CHAT_UNAVAILABILITY_ESTABLISH_AFTER;
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error(`establishAfter must be a positive integer (${threshold})`);
  const handled = input.handledListHeadId !== null && DECIMAL_ID.test(input.handledListHeadId) ? input.handledListHeadId : null;
  const at = timestampParam(input.at);
  const retry = timestampParam(input.retryNotBefore);
  const handledParam = sql`${handled}::text`;
  const establishesOn = (refusals: SQL) => sql`(${refusals} >= ${threshold}::int)`;
  const result = await tx.execute<{ id: string; inserted: boolean }>(sql`
    insert into page_dm_thread_unavailability as e (
      thread_id, state, opened_at, established_at, refusals, last_refusal_at, last_http_status, retry_not_before,
      first_attempt_id, last_attempt_id, first_observation_id, first_observation_received_at,
      last_observation_id, last_observation_received_at, handled_list_head_id
    )
    select t.id,
           case when ${establishesOn(sql`1`)} then 'established' else 'refusing' end,
           ${at}, case when ${establishesOn(sql`1`)} then ${at} end, 1, ${at}, ${input.httpStatus}::int,
           case when ${establishesOn(sql`1`)} then ${retry} end,
           ${input.attemptId}::bigint, ${input.attemptId}::bigint,
           ${input.observation.id}::bigint, ${timestampParam(input.observation.receivedAt)},
           ${input.observation.id}::bigint, ${timestampParam(input.observation.receivedAt)},
           case when ${establishesOn(sql`1`)} then ${handledParam} end
      from page_dm_threads t
      join sync_pages sp on sp.page_id = t.platform_account_id and sp.owner_generation = ${generationParam(input.generation)}
     where t.platform_account_id = ${input.pageId}
       and t.platform_conversation_id = ${input.groupId}
    on conflict (thread_id) where ended_at is null do update set
      refusals = e.refusals + 1,
      state = case when ${establishesOn(sql`e.refusals + 1`)} then 'established' else e.state end,
      established_at = coalesce(e.established_at, case when ${establishesOn(sql`e.refusals + 1`)} then excluded.last_refusal_at end),
      last_refusal_at = excluded.last_refusal_at,
      last_http_status = excluded.last_http_status,
      last_attempt_id = excluded.last_attempt_id,
      last_observation_id = excluded.last_observation_id,
      last_observation_received_at = excluded.last_observation_received_at,
      retry_not_before = case when ${establishesOn(sql`e.refusals + 1`)}
        then greatest(e.retry_not_before, ${retry}) else e.retry_not_before end,
      handled_list_head_id = case when ${establishesOn(sql`e.refusals + 1`)}
        then ${laterIdSql(sql`e.handled_list_head_id`, handledParam)} else e.handled_list_head_id end,
      updated_at = clock_timestamp()
    where e.last_attempt_id < excluded.last_attempt_id
    returning e.id::text as id, (xmax = 0) as inserted
  `);
  const row = result.rows[0];
  if (!row) return null;
  const [episode] = await readEpisodes(tx, sql`e.id = ${Number(row.id)}`);
  if (episode === undefined) return null;
  return {
    episode,
    opened: row.inserted === true,
    establishedNow: episode.state === "established" && episode.refusals === threshold,
  };
}

/**
 * End the chat's open episode (plan §2.2): an applied head read of the chat
 * (`read_served`, in the DM apply's transaction, which holds the erasure
 * fence), or the chat excluded or unbound when a plan closes its work. The
 * episode keeps its evidence. Null: no open episode.
 */
export async function endChatUnavailability(
  tx: Database,
  input: { threadId: number; reason: ChatUnavailabilityEndReason; at: Date },
): Promise<number | null> {
  const result = await tx.execute<{ id: string }>(sql`
    update page_dm_thread_unavailability
       set ended_at = ${timestampParam(input.at)},
           end_reason = ${input.reason}::text,
           updated_at = clock_timestamp()
     where thread_id = ${input.threadId}
       and ended_at is null
    returning id::text as id
  `);
  const row = result.rows[0];
  return row ? Number(row.id) : null;
}

async function readEpisodes(db: Database, where: SQL): Promise<ChatUnavailabilityEpisode[]> {
  const result = await db.execute<EpisodeSqlRow>(sql`
    select ${episodeColumns}
      from page_dm_thread_unavailability e
      join page_dm_threads t on t.id = e.thread_id
     where ${where}
     order by e.id
  `);
  return result.rows.map(normalizeEpisode);
}

/** The open episodes of a page's chats, by group id (absent: every chat of
 *  the page). Plain read, no lock. */
export async function readOpenChatUnavailability(
  db: Database,
  input: { pageId: number; groupIds?: readonly string[] },
): Promise<Map<string, ChatUnavailabilityEpisode>> {
  const groups = input.groupIds === undefined ? null : [...new Set(input.groupIds)];
  if (groups !== null && groups.length === 0) return new Map();
  const episodes = await readEpisodes(db, sql`e.ended_at is null
    and t.platform_account_id = ${input.pageId}
    ${groups === null ? sql`` : sql`and t.platform_conversation_id = any(${sql.param(groups)}::text[])`}`);
  return new Map(episodes.map((episode) => [episode.groupId, episode]));
}

/** Every episode of one chat, oldest first (the open one last, if any). */
export async function listChatUnavailabilityEpisodes(db: Database, input: { threadId: number }): Promise<ChatUnavailabilityEpisode[]> {
  return readEpisodes(db, sql`e.thread_id = ${input.threadId}`);
}

/**
 * Defer the chat's socket messages that no REST read has settled
 * (`confirm_wait_reason = 'chat_unavailable'`, no next look of the parity
 * pass): an established episode's refusal (plan §3, R2). They stay shown;
 * a later REST read that reaches them settles them and clears the reason.
 * Deletion stubs and settled rows are left alone. Rows are locked in
 * message-id order, the order of every overlay writer. Returns how many.
 */
export async function deferChatUnavailableLiveMessages(tx: Database, input: { pageId: number; groupId: string }): Promise<number> {
  const result = await tx.execute(sql`
    with target as (
      select m.page_id, m.platform_message_id
        from dm_live_messages m
       where m.page_id = ${input.pageId}
         and m.platform_conversation_id = ${input.groupId}
         and m.confirmed_at is null
         and m.deleted_at is null
         and m.confirm_wait_reason is distinct from ${CHAT_UNAVAILABLE_REASON}::text
       order by m.platform_message_id
         for update of m
    )
    update dm_live_messages m
       set confirm_wait_reason = ${CHAT_UNAVAILABLE_REASON}::text,
           confirm_due_at = null,
           updated_at = clock_timestamp()
      from target
     where m.page_id = target.page_id
       and m.platform_message_id = target.platform_message_id
  `);
  return result.rowCount ?? 0;
}

/**
 * The SQL test "this page × chat has an open chat-unavailability episode"
 * (`established`: only an established one) — the one definition every
 * reader shares (the passive parity pass now; alert 3's `message_unconfirmed`,
 * the page summary and the conversation readers next). `pageId` and
 * `groupId` are SQL expressions of the outer row.
 */
export function openChatUnavailabilitySql(input: { pageId: SQL; groupId: SQL; established?: boolean }): SQL {
  return sql`exists (
    select 1
      from page_dm_threads unavailable_chat
      join page_dm_thread_unavailability unavailable_episode
        on unavailable_episode.thread_id = unavailable_chat.id
       and unavailable_episode.ended_at is null
       ${input.established === true ? sql`and unavailable_episode.state = 'established'` : sql``}
     where unavailable_chat.platform_account_id = ${input.pageId}
       and unavailable_chat.platform_conversation_id = ${input.groupId})`;
}
