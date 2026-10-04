// chat-extension H-4b: where the hub's message stores stand on message ids a
// client names for ONE conversation. The AI feature lane asks it for the ids of
// `knownFanMessageIds` that the served transcript does not hold, to answer them
// in the `context_v1` frame.
//
// One statement, point lookups only:
//   - message_archive by its unique (account_id, platform, message_ref);
//   - dm_message_archive by its unique (platform, ofapi_account_id,
//     platform_message_id), the page's ofapi_account_id resolved in-query as
//     the transcript union does;
//   - page_dm_messages by its unique (conversation_id, platform_message_id),
//     through the thread of this conversation;
//   - dm_live_messages (the Fansly socket overlay) by its primary key
//     (page_id, platform_message_id), only when the caller says the overlay
//     served the transcript. A page whose readers do not read the overlay
//     (`fanslyLiveOverlayReadPages`) is not judged by it here either.
//
// The conversation is part of every arm. A message id of another fan's chat on
// the same page is found by none of them and reads `absent`, exactly like an id
// the hub has never seen: the answer never says that a message exists, or was
// deleted, in a chat the caller did not name.
//
// A tombstone counts from any store once the id is known to belong to this
// conversation, as in the transcript union: a delete webhook carries no chat,
// so its dm_message_archive stub has a NULL conversation and proves nothing
// about the chat by itself. A socket deletion stub of the overlay is the same
// case; the live union hides a message on that mark alone, so a message the
// archive still holds live reads `deleted` here once the overlay tombstones it.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

/** `present`: held for this conversation and not deleted. `deleted`: held for
 *  this conversation and tombstoned in some store. `absent`: not held for this
 *  conversation. */
export type AiKnownMessageStoreState = "present" | "deleted" | "absent";

/** A point lookup, not a reader: it refuses a longer list. The wire names at
 *  most 10 ids. */
export const AI_KNOWN_MESSAGE_LOOKUP_MAX_REFS = 100;

export interface AiKnownMessageLookupInput {
  pageId: number;
  /** The page's platform: part of message_archive's unique key. */
  platform: string;
  conversationRef: string;
  messageRefs: readonly string[];
  /** The transcript was served by the live union (`source: "live_union"`):
   *  read the socket overlay too. Off by default: no other reader does. */
  liveOverlay?: boolean;
}

function buildKnownMessageQuery(input: AiKnownMessageLookupInput) {
  const refs = sql`${sql.param([...input.messageRefs])}::text[]`;
  const live = input.liveOverlay === true;
  return sql`
    with page as (
      select p.ofapi_account_id
      from pages p
      where p.id = ${input.pageId}
    ),
    wanted as (
      select distinct w.message_ref
      from unnest(${refs}) as w(message_ref)
    ),
    archive_rows as (
      select ma.message_ref, ma.deleted_at
      from message_archive ma
      where ma.account_id = ${input.pageId}
        and ma.platform = ${input.platform}
        and ma.message_ref = any(${refs})
        and ma.conversation_ref = ${input.conversationRef}
    ),
    dm_rows as (
      select d.platform_message_id as message_ref,
             d.deleted_at,
             (d.platform_account_id = ${input.pageId}
               and d.platform_conversation_id = ${input.conversationRef}) as in_conversation
      from dm_message_archive d
      join page on page.ofapi_account_id = d.ofapi_account_id
      where d.platform = 'onlyfans'
        and d.platform_message_id = any(${refs})
    ),
    hot_rows as (
      select m.platform_message_id as message_ref, m.deleted_at
      from page_dm_threads t
      join page_dm_messages m on m.conversation_id = t.id
      where t.platform_account_id = ${input.pageId}
        and t.platform_conversation_id = ${input.conversationRef}
        and m.platform_message_id = any(${refs})
    ),
    ${live ? sql`live_rows as (
      select l.platform_message_id as message_ref,
             l.deleted_at,
             (l.platform_conversation_id = ${input.conversationRef}) as in_conversation
      from dm_live_messages l
      where l.page_id = ${input.pageId}
        and l.platform_message_id = any(${refs})
    ),` : sql``}
    held as (
      select a.message_ref, a.deleted_at from archive_rows a
      union all
      select d.message_ref, d.deleted_at from dm_rows d where d.in_conversation
      union all
      select h.message_ref, h.deleted_at from hot_rows h
      ${live ? sql`union all
      select l.message_ref, l.deleted_at from live_rows l where l.in_conversation` : sql``}
    )
    select w.message_ref,
           exists (select 1 from held x where x.message_ref = w.message_ref) as held,
           (exists (select 1 from held x
                    where x.message_ref = w.message_ref and x.deleted_at is not null)
             or exists (select 1 from dm_rows d
                        where d.message_ref = w.message_ref and d.deleted_at is not null)
             ${live ? sql`or exists (select 1 from live_rows l
                        where l.message_ref = w.message_ref and l.deleted_at is not null)` : sql``}) as tombstoned
    from wanted w
  `;
}

/**
 * The state of each named message id in this page's stores, for this
 * conversation only. Every ref of the input has an entry.
 */
export async function lookupAiKnownMessages(
  db: Database,
  input: AiKnownMessageLookupInput,
): Promise<Map<string, AiKnownMessageStoreState>> {
  const states = new Map<string, AiKnownMessageStoreState>();
  if (input.messageRefs.length === 0) {
    return states;
  }
  if (input.messageRefs.length > AI_KNOWN_MESSAGE_LOOKUP_MAX_REFS) {
    throw new Error(`lookupAiKnownMessages takes at most ${AI_KNOWN_MESSAGE_LOOKUP_MAX_REFS} refs`);
  }
  const result = await db.execute<Record<string, unknown>>(buildKnownMessageQuery(input));
  for (const row of result.rows) {
    states.set(
      String(row.message_ref),
      row.held !== true ? "absent" : row.tombstoned === true ? "deleted" : "present",
    );
  }
  for (const ref of input.messageRefs) {
    if (!states.has(ref)) {
      states.set(ref, "absent");
    }
  }
  return states;
}

/** Perf-gate seam: EXPLAIN over the exact statement the lookup runs. */
export async function explainAiKnownMessagesQuery(
  db: Database,
  input: AiKnownMessageLookupInput,
): Promise<string> {
  const result = await db.execute<{ "QUERY PLAN": string }>(
    sql`explain (format text) ${buildKnownMessageQuery(input)}`,
  );
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

// chat-extension H-4c: where the hub's stores stand on message ids a client
// sent WITH their text (`liveTextContext`, the fresh text of the open chat).
// The AI feature lane asks it for the ids the served transcript does not hold,
// before it lets a client's text into a prompt. Four questions per id:
//
//   - does the id belong to ANOTHER chat (`foreign`)? Then the snapshot is not
//     of the chat the request names, and the request is refused;
//   - was the message deleted (`deleted`)? A client's copy never brings a
//     deleted message back;
//   - who sent it (`isSentByMe`), where a store holds its content for this
//     conversation? A client that names the other side is refused;
//   - when was it sent (`occurredAt`), by the same stores? A message the hub
//     can place keeps the hub's time, whatever the client's clock says.
//
// The same stores and the same unique keys as the lookup above, for this page:
// message_archive, dm_message_archive (through the page's OFAPI account) and,
// for a tombstone only, the hot table through this conversation's thread.
//
// What differs from the lookup above, and why:
//   - a tombstone counts from any store of this page whether or not the hub
//     holds the message for this conversation. Above, the answer goes back to
//     the client and must not describe a chat it did not name; here nothing is
//     described, the item is only left out of the prompt. A delete webhook
//     names no chat, so this is the only way such a stub counts at all;
//   - `foreign` reads the chat a row names instead of filtering by it;
//   - with `otherPageIds` it also reads both archives of OTHER pages, by the
//     same unique keys (one probe per page, store and id; a page's
//     dm_message_archive through its own OFAPI account, exactly as this
//     page's). The caller passes only pages the principal may read, so the
//     refusal says nothing a second request of the same principal could not
//     ask outright. `deleted`, the sender and the time still come from this
//     page's stores alone.
//
// "The same chat" across pages: a chat is a pair of platform accounts, and
// both can be pages of this hub (two models writing to each other). The same
// message is then held twice, once under each page with the other one as its
// conversation, in either archive. Such a row is the chat itself seen from its
// other side, not a foreign one. Known account ids are unique among a
// platform's pages (pages_platform_external_id_uniq), so a second record of
// one account exists only with an id unknown (`pages.external_page_id` is
// NULL; an OFAPI account belongs to one page, pages_ofapi_account_uniq, so the
// webhook archive is never read twice through two records). Where an unknown
// id leaves the answer open, the row decides nothing (SQL's three-valued `not`
// drops it): a wrong refusal costs a generation, a missed one costs nothing
// the caller could not have typed into the draft.

export interface AiLiveTextStoreState {
  /** The hub holds the id under another chat. */
  foreign: boolean;
  /** Tombstoned in a store of this page. */
  deleted: boolean;
  /** The sender by the stores that hold the message's content for this
   *  conversation: true = the page, false = the fan, null = no store holds its
   *  content, or they disagree. */
  isSentByMe: boolean | null;
  /** When the message was sent, by the same stores: message_archive first (the
   *  time every reader orders by), dm_message_archive where the archive does
   *  not hold the message yet. null = no store holds its content with a time. */
  occurredAt: Date | null;
}

export interface AiLiveTextLookupInput {
  pageId: number;
  /** The page's platform: part of message_archive's unique key. */
  platform: string;
  conversationRef: string;
  messageRefs: readonly string[];
  /** Other pages whose archives are read for the same ids: `null` = every
   *  other page of the platform (a caller who may read them all), a list =
   *  exactly those. EMPTY = none: reading "no ids" as "no filter" is how a
   *  scope clamp turns into an unfiltered read. */
  otherPageIds: readonly number[] | null;
}

function buildLiveTextMessageQuery(input: AiLiveTextLookupInput) {
  const refs = sql`${sql.param([...input.messageRefs])}::text[]`;
  const otherPageIds = input.otherPageIds === null
    ? null
    : input.otherPageIds.filter((id) => id !== input.pageId);
  const others = otherPageIds === null || otherPageIds.length > 0;
  // The other pages this caller may read; the request's own page is never one.
  const otherPages = sql`o.platform = ${input.platform}
        and o.id <> ${input.pageId}
        ${otherPageIds === null ? sql`` : sql`and o.id = any(${sql.param(otherPageIds)}::bigint[])`}`;
  // The same chat seen from its other side (the header above). Three-valued:
  // with an account unknown the row decides nothing.
  const mirrored = (conversation: SQL) => sql`(
          (o.external_page_id = ${input.conversationRef} and ${conversation} = page.external_page_id)
          or (o.external_page_id = page.external_page_id and ${conversation} = ${input.conversationRef})
        )`;
  return sql`
    with page as (
      select p.ofapi_account_id, p.external_page_id
      from pages p
      where p.id = ${input.pageId}
    ),
    wanted as (
      select distinct w.message_ref
      from unnest(${refs}) as w(message_ref)
    ),
    archive_rows as (
      select ma.message_ref, ma.conversation_ref, ma.is_sent_by_me, ma.deleted_at,
             ma.occurred_at as event_time,
             ma.content_pending as is_stub
      from message_archive ma
      where ma.account_id = ${input.pageId}
        and ma.platform = ${input.platform}
        and ma.message_ref = any(${refs})
    ),
    dm_rows as (
      select d.platform_message_id as message_ref,
             d.platform_conversation_id as conversation_ref,
             d.is_sent_by_me,
             d.deleted_at,
             d.message_created_at as event_time,
             (d.message_created_at is null) as is_stub,
             (d.platform_account_id = ${input.pageId}) as on_page
      from dm_message_archive d
      join page on page.ofapi_account_id = d.ofapi_account_id
      where d.platform = 'onlyfans'
        and d.platform_message_id = any(${refs})
    ),
    hot_rows as (
      select m.platform_message_id as message_ref, m.deleted_at
      from page_dm_threads t
      join page_dm_messages m on m.conversation_id = t.id
      where t.platform_account_id = ${input.pageId}
        and t.platform_conversation_id = ${input.conversationRef}
        and m.platform_message_id = any(${refs})
    ),
    ${others ? sql`other_rows as (
      select ma.message_ref
      from pages o
      cross join page
      join message_archive ma
        on ma.account_id = o.id
       and ma.platform = ${input.platform}
       and ma.message_ref = any(${refs})
      where ${otherPages}
        and ma.conversation_ref is not null
        and not ${mirrored(sql`ma.conversation_ref`)}
      union all
      select d.platform_message_id as message_ref
      from pages o
      cross join page
      join dm_message_archive d
        on d.platform = 'onlyfans'
       and d.ofapi_account_id = o.ofapi_account_id
       and d.platform_message_id = any(${refs})
      where ${otherPages}
        and d.platform_account_id = o.id
        and d.platform_conversation_id is not null
        and not ${mirrored(sql`d.platform_conversation_id`)}
    ),` : sql``}
    content as (
      select a.message_ref, a.is_sent_by_me, a.event_time, 0 as store_rank
      from archive_rows a
      where a.conversation_ref = ${input.conversationRef} and not a.is_stub
      union all
      select d.message_ref, d.is_sent_by_me, d.event_time, 1 as store_rank
      from dm_rows d
      where d.on_page and d.conversation_ref = ${input.conversationRef} and not d.is_stub
    )
    select w.message_ref,
           (exists (select 1 from archive_rows a
                    where a.message_ref = w.message_ref
                      and a.conversation_ref is not null
                      and a.conversation_ref <> ${input.conversationRef})
             or exists (select 1 from dm_rows d
                        where d.message_ref = w.message_ref
                          and d.on_page
                          and d.conversation_ref is not null
                          and d.conversation_ref <> ${input.conversationRef})
             ${others ? sql`or exists (select 1 from other_rows o where o.message_ref = w.message_ref)` : sql``}) as foreign_chat,
           (exists (select 1 from archive_rows a
                    where a.message_ref = w.message_ref and a.deleted_at is not null)
             or exists (select 1 from dm_rows d
                        where d.message_ref = w.message_ref and d.deleted_at is not null)
             or exists (select 1 from hot_rows h
                        where h.message_ref = w.message_ref and h.deleted_at is not null)) as tombstoned,
           exists (select 1 from content c
                   where c.message_ref = w.message_ref and c.is_sent_by_me) as sent_by_page,
           exists (select 1 from content c
                   where c.message_ref = w.message_ref and not c.is_sent_by_me) as sent_by_fan,
           (select c.event_time from content c
            where c.message_ref = w.message_ref and c.event_time is not null
            order by c.store_rank
            limit 1) as occurred_at
    from wanted w
  `;
}

const AI_LIVE_TEXT_UNSEEN: AiLiveTextStoreState = {
  foreign: false, deleted: false, isSentByMe: null, occurredAt: null,
};

/**
 * The state of each named message id in the hub's stores, for one conversation
 * of one page. Every ref of the input has an entry; an id no store has seen
 * reads `{ foreign: false, deleted: false, isSentByMe: null, occurredAt: null }`.
 */
export async function lookupAiLiveTextMessages(
  db: Database,
  input: AiLiveTextLookupInput,
): Promise<Map<string, AiLiveTextStoreState>> {
  const states = new Map<string, AiLiveTextStoreState>();
  if (input.messageRefs.length === 0) {
    return states;
  }
  if (input.messageRefs.length > AI_KNOWN_MESSAGE_LOOKUP_MAX_REFS) {
    throw new Error(`lookupAiLiveTextMessages takes at most ${AI_KNOWN_MESSAGE_LOOKUP_MAX_REFS} refs`);
  }
  const result = await db.execute<Record<string, unknown>>(buildLiveTextMessageQuery(input));
  for (const row of result.rows) {
    const byPage = row.sent_by_page === true;
    const byFan = row.sent_by_fan === true;
    states.set(String(row.message_ref), {
      foreign: row.foreign_chat === true,
      deleted: row.tombstoned === true,
      isSentByMe: byPage === byFan ? null : byPage,
      occurredAt: row.occurred_at == null ? null : new Date(row.occurred_at as string | Date),
    });
  }
  for (const ref of input.messageRefs) {
    if (!states.has(ref)) {
      states.set(ref, AI_LIVE_TEXT_UNSEEN);
    }
  }
  return states;
}

/** Perf-gate seam: EXPLAIN over the exact statement the lookup runs. */
export async function explainAiLiveTextMessagesQuery(
  db: Database,
  input: AiLiveTextLookupInput,
): Promise<string> {
  const result = await db.execute<{ "QUERY PLAN": string }>(
    sql`explain (format text) ${buildLiveTextMessageQuery(input)}`,
  );
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}
