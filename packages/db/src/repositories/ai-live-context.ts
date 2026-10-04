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
//     through the thread of this conversation.
//
// The conversation is part of every arm. A message id of another fan's chat on
// the same page is found by none of them and reads `absent`, exactly like an id
// the hub has never seen: the answer never says that a message exists, or was
// deleted, in a chat the caller did not name.
//
// A tombstone counts from any store once the id is known to belong to this
// conversation, as in the transcript union: a delete webhook carries no chat,
// so its dm_message_archive stub has a NULL conversation and proves nothing
// about the chat by itself.

import { sql } from "drizzle-orm";

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
}

function buildKnownMessageQuery(input: AiKnownMessageLookupInput) {
  const refs = sql`${sql.param([...input.messageRefs])}::text[]`;
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
    held as (
      select a.message_ref, a.deleted_at from archive_rows a
      union all
      select d.message_ref, d.deleted_at from dm_rows d where d.in_conversation
      union all
      select h.message_ref, h.deleted_at from hot_rows h
    )
    select w.message_ref,
           exists (select 1 from held x where x.message_ref = w.message_ref) as held,
           (exists (select 1 from held x
                    where x.message_ref = w.message_ref and x.deleted_at is not null)
             or exists (select 1 from dm_rows d
                        where d.message_ref = w.message_ref and d.deleted_at is not null)) as tombstoned
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
