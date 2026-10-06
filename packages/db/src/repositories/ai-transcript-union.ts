// Fast-reply freshness PR3: the AI transcript UNION read. One statement (one
// MVCC snapshot) over BOTH message stores — the projection-lagged
// message_archive and the post-settle dm_message_archive — so a generation
// sees webhook facts seconds after settle instead of waiting out two
// independent minutely crons. OnlyFans only (the caller gates platform; the
// SQL pins the literal defensively).
//
// Order of operations (build spec, PR3):
//   1. candidates from BOTH stores, scoped (account, conversationRef);
//   2. cross-source tombstone lookup keyed off candidate message refs via
//      dm_message_archive's UNIQUE (platform, ofapi_account_id,
//      platform_message_id) — delete webhooks carry no chat scope, so their
//      tombstone stubs have NULL platform_conversation_id and the
//      conversation-scoped arm cannot see them; the page row's
//      ofapi_account_id is resolved in-query for that arm (there is no
//      (platform_account_id, platform_message_id) index);
//   3. tombstone dominance: a ref deleted in EITHER store or in
//      page_dm_messages is dead everywhere;
//   4. REST material clocks win across stores; the dm row wins legacy ties;
//   5. PPV upgrade from page_dm_messages.purchased_at — is_opened may only
//      advance to true, never downgrade;
//   6. deterministic ORDER BY: event time with an EXPLICIT NULLS LAST
//      policy, guarded-numeric message id (regex-guarded cast — never
//      throws), lexical fallback;
//   7. dedupe/tombstones happen BEFORE the final tail cap.
//
// Steps 1–5 are one CTE chain (`aiTranscriptUnionCtes`), shared with the
// chat-extension archive feed (conversation-feed.ts) so the feed pages the
// very rows a generation reads. Called without options it renders exactly the
// AI statement's CTEs (`tests/conversation-feed-sql.test.ts` pins that text);
// the feed adds snapshot bounds on both arms and keeps tombstoned refs as rows
// flagged `deleted` instead of dropping them.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { aiTranscriptRowCap } from "./ai-transcript-depth.ts";

export interface AiTranscriptUnionRow {
  messageRef: string;
  occurredAt: Date | null;
  textPlain: string;
  senderRole: string;
  isSentByMe: boolean;
  priceMills: string | null;
  isTip: boolean;
  tipAmountMills: string;
  mediaMetadata: Array<Record<string, unknown>> | null;
  isOpened: boolean | null;
}

/** Shared with the AI archive reader: the internal AI cap is 1500. */
export const AI_TRANSCRIPT_UNION_MAX_LIMIT = 1500;

export interface AiTranscriptUnionInput {
  pageId: number;
  conversationRef: string;
  limit?: number;
  /** Raises the row cap of this read past AI_TRANSCRIPT_UNION_MAX_LIMIT, up to
   * AI_TRANSCRIPT_DEEP_MAX_ROWS. Only the full Recap passes it. */
  maxRows?: number | undefined;
}

export interface AiTranscriptUnionCteOptions {
  /**
   * Snapshot bounds (the feed) on the two content arms: a row whose id is
   * above the bound in its store stays outside the walk. Tombstone sources
   * (cross-source dm deletions, the hot table) are not bounded, so a deletion
   * recorded after the snapshot still flags its row. Rows updated in place
   * keep their id and stay inside the walk, including updates that change
   * their time or which copy wins (conversation-feed.ts says what that costs
   * a walk).
   */
  bounds?: { archiveMaxId: number; dmMaxId: number };
  /**
   * "exclude" (the AI read, the default): a tombstoned ref is dropped.
   * "flag" (the feed): it stays, and `best`/`upgraded` carry `deleted`.
   * Stubs never serve either way.
   */
  tombstones?: "exclude" | "flag";
}

/**
 * The union's CTE chain, `page` through `upgraded` (one row per message ref
 * that has content — live only, unless tombstones are flagged — unordered),
 * for a statement that starts `with ${ctes}` and reads `upgraded u`.
 */
export function aiTranscriptUnionCtes(
  input: Pick<AiTranscriptUnionInput, "pageId" | "conversationRef">,
  options: AiTranscriptUnionCteOptions = {},
): SQL {
  const archiveBound = options.bounds === undefined ? sql`` : sql`
        and ma.id <= ${options.bounds.archiveMaxId}`;
  const dmBound = options.bounds === undefined ? sql`` : sql`
        and d.id <= ${options.bounds.dmMaxId}`;
  const flagTombstones = options.tombstones === "flag";
  const bestDeleted = flagTombstones ? sql`,
             exists (select 1 from tombstoned x where x.message_ref = c.message_ref) as deleted` : sql``;
  const excludeTombstoned = flagTombstones ? sql`` : sql`
        and not exists (select 1 from tombstoned x where x.message_ref = c.message_ref)`;
  const upgradedDeleted = flagTombstones ? sql`,
             b.deleted` : sql``;
  return sql`page as (
      select p.id as page_id, p.ofapi_account_id
      from pages p
      where p.id = ${input.pageId}
    ),
    archive_arm as (
      select ma.message_ref,
             ma.occurred_at as event_time,
             ma.text_plain,
             ma.sender_role::text as sender_role,
             ma.is_sent_by_me,
             ma.price_mills,
             ma.is_tip,
             ma.tip_amount_mills,
             ma.media_metadata,
             ma.deleted_at,
             ma.is_opened,
             ma.material_observed_at,
             ma.vendor_changed_at,
             ma.content_pending as is_stub,
             0 as source_rank
      from message_archive ma
      where ma.account_id = ${input.pageId}
        and ma.platform = 'onlyfans'
        and ma.conversation_ref = ${input.conversationRef}${archiveBound}
    ),
    dm_arm as (
      select d.platform_message_id as message_ref,
             d.message_created_at as event_time,
             d.text_plain,
             d.sender_role::text as sender_role,
             d.is_sent_by_me,
             d.price_mills,
             d.is_tip,
             d.tip_amount_mills,
             d.media_metadata,
             d.deleted_at,
             d.is_opened,
             d.rest_material_observed_at as material_observed_at,
             d.rest_platform_changed_at as vendor_changed_at,
             (d.message_created_at is null) as is_stub,
             1 as source_rank
      from dm_message_archive d
      where d.platform = 'onlyfans'
        and d.platform_account_id = ${input.pageId}
        and d.platform_conversation_id = ${input.conversationRef}${dmBound}
    ),
    candidates as (
      select * from archive_arm
      union all
      select * from dm_arm
    ),
    candidate_refs as (
      select distinct c.message_ref from candidates c
    ),
    hot as (
      select m.platform_message_id as message_ref, m.deleted_at, m.purchased_at
      from page_dm_messages m
      join page_dm_threads t on t.id = m.conversation_id
      where t.platform_account_id = ${input.pageId}
        and t.platform_conversation_id = ${input.conversationRef}
    ),
    cross_tombstones as (
      select r.message_ref
      from candidate_refs r
      cross join page
      join dm_message_archive d
        on d.platform = 'onlyfans'
       and d.ofapi_account_id = page.ofapi_account_id
       and d.platform_message_id = r.message_ref
      where d.deleted_at is not null
    ),
    tombstoned as (
      select c.message_ref from candidates c where c.deleted_at is not null
      union
      select ct.message_ref from cross_tombstones ct
      union
      select h.message_ref from hot h where h.deleted_at is not null
    ),
    best as (
      select distinct on (c.message_ref)
             c.message_ref, c.event_time, c.text_plain, c.sender_role,
             c.is_sent_by_me, c.price_mills, c.is_tip, c.tip_amount_mills,
             c.media_metadata,
             bool_or(c.is_opened) over (partition by c.message_ref) as is_opened${bestDeleted}
      from candidates c
      where not c.is_stub${excludeTombstoned}
      order by c.message_ref,
               (c.material_observed_at is not null) desc,
               c.vendor_changed_at desc nulls last,
               c.material_observed_at desc nulls last,
               c.source_rank desc
    ),
    upgraded as (
      select b.message_ref, b.event_time, b.text_plain, b.sender_role,
             b.is_sent_by_me, b.price_mills, b.is_tip, b.tip_amount_mills,
             b.media_metadata,
             case when h.purchased_at is not null then true else b.is_opened end as is_opened${upgradedDeleted}
      from best b
      left join hot h on h.message_ref = b.message_ref
    )`;
}

/**
 * chat-extension H-8b: when the fan last wrote TEXT in one conversation, among
 * the rows the chain above serves. A scalar subquery (timestamptz, NULL when
 * no served row is the fan's text), for a statement that asks it of many
 * conversations at once (the Spenders stats ask it of every payer's chats), so
 * `conversationRef` is an SQL expression of the outer row.
 *
 * The chain itself cannot answer that at the scale of a page: it reads every
 * row of a conversation before it picks one. This reads two tails instead: the
 * newest row of each store that is the fan's text and that the chain would
 * serve, and stops there. "Would serve" is steps 1-4 of the chain, asked of
 * one row:
 *   - a stub never serves (`content_pending`, a dm row without a creation time);
 *   - a ref tombstoned in either store or in page_dm_messages is dead (step 3);
 *   - of two copies of one message the chain serves one (step 4): the copy in
 *     the other store must not outrank this one. The dm copy wins a tie.
 * Step 5 (the PPV upgrade) changes neither the sender, the text nor the time.
 *
 * Both lookups into dm_message_archive by message id go through its UNIQUE
 * (platform, ofapi_account_id, platform_message_id) under the page's current
 * OFAPI account, as the chain's own cross-source tombstones do: there is no
 * (platform_account_id, platform_message_id) index. A dm row filed under an
 * account id the page no longer has is therefore read as a message of its own
 * (the second tail finds it), but it does not outrank the archive's copy of
 * the same message and its deletion mark does not reach the other copies,
 * where the chain would let both. Two copies of one message carry the same
 * sender and creation time, so the answer moves only if such a copy was
 * deleted and the archive never heard.
 *
 * `tests/client-spender-stats-union.integration.test.ts` holds the two
 * together: for every conversation of its fixture this answer equals the
 * newest fan text among the rows `listAiTranscriptUnionMessages` returns.
 */
export function aiTranscriptUnionLastFanTextAtSql(input: { pageId: number; conversationRef: SQL }): SQL {
  const { pageId, conversationRef } = input;
  const ofapiAccount = sql`(select p.ofapi_account_id from pages p where p.id = ${pageId})`;
  // Step 4's order, as a row to compare: REST material first, then the
  // platform's own change time, then the observation time; NULLs last.
  const materialRank = (observedAt: SQL, changedAt: SQL) => sql`(
                   ${observedAt} is not null,
                   coalesce(${changedAt}, '-infinity'::timestamptz),
                   coalesce(${observedAt}, '-infinity'::timestamptz)
                 )`;
  // Steps 2-3 beyond the row's own store: a deletion the other store or the
  // hot table recorded.
  const tombstonedElsewhere = (messageRef: SQL) => sql`exists (
              select 1
              from dm_message_archive x
              where x.platform = 'onlyfans'
                and x.ofapi_account_id = ${ofapiAccount}
                and x.platform_message_id = ${messageRef}
                and x.deleted_at is not null
            )
            or exists (
              select 1
              from page_dm_messages h
              join page_dm_threads t on t.id = h.conversation_id
              where t.platform_account_id = ${pageId}
                and t.platform_conversation_id = ${conversationRef}
                and h.platform_message_id = ${messageRef}
                and h.deleted_at is not null
            )`;
  // Each tail's last condition is ONE `not (… or …)` over its lookups by
  // message id, on purpose: under an OR none of them can be planned as a join,
  // so each stays a lookup of one row through a unique index, run only for a
  // row that is already the fan's text. As a separate `not exists`, the lookup
  // of the other store's copy becomes an anti-join over the whole chat.
  return sql`(
    select max(tail.event_time)
    from (
      (
        select ma.occurred_at as event_time
        from message_archive ma
        where ma.account_id = ${pageId}
          and ma.platform = 'onlyfans'
          and ma.conversation_ref = ${conversationRef}
          and ma.occurred_at is not null
          and ma.is_sent_by_me = false
          and ma.deleted_at is null
          and ma.content_pending = false
          and ma.text_plain ~ '[^[:space:]]'
          and not (
            ${tombstonedElsewhere(sql`ma.message_ref`)}
            or exists (
              select 1
              from dm_message_archive w
              where w.platform = 'onlyfans'
                and w.ofapi_account_id = ${ofapiAccount}
                and w.platform_message_id = ma.message_ref
                and w.platform_account_id = ${pageId}
                and w.platform_conversation_id = ${conversationRef}
                and w.message_created_at is not null
                and ${materialRank(sql`w.rest_material_observed_at`, sql`w.rest_platform_changed_at`)}
                    >= ${materialRank(sql`ma.material_observed_at`, sql`ma.vendor_changed_at`)}
            )
          )
        order by ma.occurred_at desc
        limit 1
      )
      union all
      (
        select d.message_created_at as event_time
        from dm_message_archive d
        where d.platform = 'onlyfans'
          and d.platform_account_id = ${pageId}
          and d.platform_conversation_id = ${conversationRef}
          and d.message_created_at is not null
          and d.is_sent_by_me = false
          and d.deleted_at is null
          and d.text_plain ~ '[^[:space:]]'
          and not (
            ${tombstonedElsewhere(sql`d.platform_message_id`)}
            or exists (
              select 1
              from message_archive a
              where a.account_id = ${pageId}
                and a.platform = 'onlyfans'
                and a.message_ref = d.platform_message_id
                and a.conversation_ref = ${conversationRef}
                and (
                  a.deleted_at is not null
                  or (
                    a.content_pending = false
                    and ${materialRank(sql`a.material_observed_at`, sql`a.vendor_changed_at`)}
                        > ${materialRank(sql`d.rest_material_observed_at`, sql`d.rest_platform_changed_at`)}
                  )
                )
            )
          )
        order by d.message_created_at desc
        limit 1
      )
    ) tail
  )`;
}

function buildUnionQuery(input: AiTranscriptUnionInput) {
  const limit = Math.min(input.limit ?? 100, aiTranscriptRowCap(input.maxRows, AI_TRANSCRIPT_UNION_MAX_LIMIT));
  return sql`
    with ${aiTranscriptUnionCtes(input)}
    select u.message_ref,
           u.event_time,
           u.text_plain,
           u.sender_role,
           u.is_sent_by_me,
           u.price_mills::text as price_mills,
           u.is_tip,
           u.tip_amount_mills::text as tip_amount_mills,
           u.media_metadata,
           u.is_opened
    from upgraded u
    order by u.event_time desc nulls last,
             (case when u.message_ref ~ '^[0-9]{1,18}$' then u.message_ref::bigint end) desc nulls last,
             u.message_ref desc
    limit ${limit}
  `;
}

export async function listAiTranscriptUnionMessages(
  db: Database,
  input: AiTranscriptUnionInput,
): Promise<AiTranscriptUnionRow[]> {
  const result = await db.execute<Record<string, unknown>>(buildUnionQuery(input));
  return result.rows.map((row) => ({
    messageRef: String(row.message_ref),
    occurredAt: row.event_time == null ? null : new Date(row.event_time as string | Date),
    textPlain: String(row.text_plain ?? ""),
    senderRole: String(row.sender_role),
    isSentByMe: row.is_sent_by_me === true,
    priceMills: row.price_mills == null ? null : String(row.price_mills),
    isTip: row.is_tip === true,
    tipAmountMills: String(row.tip_amount_mills ?? "0"),
    mediaMetadata: (row.media_metadata as Array<Record<string, unknown>> | null) ?? null,
    isOpened: row.is_opened == null ? null : row.is_opened === true,
  }));
}

/** Perf-gate seam: EXPLAIN over the EXACT same statement the reader runs
 * (single source of truth — the gate asserts index usage on the real query,
 * never a drifting copy). Text format, no ANALYZE. */
export async function explainAiTranscriptUnionQuery(
  db: Database,
  input: AiTranscriptUnionInput,
): Promise<string> {
  const result = await db.execute<{ "QUERY PLAN": string }>(
    sql`explain (format text) ${buildUnionQuery(input)}`,
  );
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}
