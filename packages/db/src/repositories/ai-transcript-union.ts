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
}

export interface AiTranscriptUnionCteOptions {
  /**
   * Snapshot bounds (the feed): rows inserted after the snapshot — a higher
   * row id in either store — stay outside the walk. Rows updated in place
   * (a deletion, an edit) keep their id and stay inside it.
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

function buildUnionQuery(input: AiTranscriptUnionInput) {
  const limit = Math.min(input.limit ?? 100, AI_TRANSCRIPT_UNION_MAX_LIMIT);
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
