import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  keysetOrderBy,
  keysetPredicate,
  renderInstant,
  type KeysetBoundary,
} from "./agent-keyset.ts";
import { witnessFor, witnessesFor, type PlaneReadWitness } from "./agent-read-witness.ts";

/**
 * The platform-neutral transcript UNION for agent operation #6.
 *
 * WHY NOT REUSE `ai-transcript-union.ts`: that reader is deliberately
 * OnlyFans-only (Fansly has no parallel webhook/cold lane) and is gated by
 * `aiTranscriptFreshUnionMode`, whose default is `off`. Operation #6 must work on
 * Fansly — that is the entire point of the investigation that started this work.
 * So the DISCIPLINE is copied and the gate is not:
 *
 *   1. candidates from all three message stores, scoped to (page, conversation);
 *   2. cross-source tombstone lookup — a delete webhook carries no chat scope, so
 *      its stub has a NULL conversation id and the conversation-scoped arm cannot
 *      see it;
 *   3. tombstone dominance: a ref deleted in ANY store is dead in all of them;
 *   4. source preference: the fresher `dm_message_archive` row wins a ref present
 *      in both, then `message_archive`, then the hot table;
 *   5. PPV upgrade from `page_dm_messages.purchased_at` — `is_opened` may only
 *      advance to true, never back;
 *   6. dedup and tombstoning happen BEFORE the limit, so a page is never short
 *      because duplicates ate its budget;
 *   7. a deterministic total order: event time with an explicit NULLS policy, a
 *      regex-guarded numeric id (a cast that can never throw), then the lexical
 *      ref.
 *
 * DIFFERENCES from the AI reader, all deliberate:
 *   - platform is a PARAMETER, not a pinned literal; the OF-only arm simply
 *     matches nothing on Fansly rather than being branched around in TypeScript;
 *   - a tombstoned row is RETURNED (state `deleted`) unless the caller opts out:
 *     a deletion is a fact of an investigation, not litter;
 *   - the window `[from, to)` and the result predicates are applied here, while
 *     the CAPTURE axis is computed elsewhere from {scope, source, window} only —
 *     no predicate in this function may ever influence a capture floor.
 */

/** The hard internal ceiling on rows the union may materialize for one page. */
export const AGENT_TRANSCRIPT_UNION_MAX_ROWS = 1500;

export interface AgentTranscriptFilters {
  readonly direction?: "inbound" | "outbound" | "unknown" | undefined;
  readonly senderRole?: "fan" | "model" | "system" | "unknown" | undefined;
  readonly hasMedia?: boolean | undefined;
  readonly hasPrice?: boolean | undefined;
  readonly isTip?: boolean | undefined;
  readonly includeDeleted?: boolean | undefined;
}

export interface AgentTranscriptInput {
  readonly pageId: number;
  /** This thread's capture floor, established by its own unbounded query. Passed
   *  in so the witness carries it: a floor is evidence about the store, and the
   *  witness is the only thing allowed to report one. */
  readonly archiveFloor?: Date | null | undefined;
  readonly platform: string;
  readonly conversationRef: string;
  readonly from: Date;
  readonly to: Date;
  readonly sortDir: "asc" | "desc";
  readonly limit: number;
  readonly filters: AgentTranscriptFilters;
  /** Keyset resume position, exclusive. Rendered by SQL, never by JavaScript. */
  readonly after?: KeysetBoundary | undefined;
}

export interface AgentTranscriptRow {
  messageRef: string;
  nativeMessageRef: string | null;
  occurredAt: Date | null;
  senderRole: string;
  senderPlatformUserId: string | null;
  isSentByMe: boolean;
  textPlain: string | null;
  textHtml: string | null;
  priceMills: bigint | null;
  isOpened: boolean | null;
  isNew: boolean | null;
  isTip: boolean;
  tipAmountMills: bigint | null;
  tipTextPlain: string | null;
  inReplyToRef: string | null;
  replyMetadata: Record<string, unknown> | null;
  mediaMetadata: Array<Record<string, unknown>>;
  originClass: string | null;
  materialObservedAt: Date | null;
  vendorChangedAt: Date | null;
  sourceAccountSeq: number | null;
  servingContractVersion: number;
  backfillSource: string | null;
  contentPending: boolean;
  deletedAt: Date | null;
  fanPlatformUserId: string | null;
  sourcePlane: string;
  /** The rendered sort value of this row, straight from SQL. */
  sortValue: string | null;
  keysetKey: string;
}

function boolPredicate(column: SQL, expected: boolean | undefined): SQL {
  if (expected === undefined) {
    return sql`true`;
  }
  return expected ? sql`(${column})` : sql`not (${column})`;
}

function buildUnionQuery(input: AgentTranscriptInput, limit: number): SQL {
  const { filters } = input;
  const includeDeleted = filters.includeDeleted ?? true;
  const descending = input.sortDir === "desc";

  // Ordering and resumption share ONE rendered key (see agent-keyset.ts). The
  // previous revision ordered by a bigint cast of numeric-looking refs while the
  // keyset compared them lexically, so "10" sorted before "2" in one and after it
  // in the other, and rows fell through the crack between pages. The numeric cast
  // is gone: the tiebreak only ever separates messages sharing one timestamp, and
  // a correct traversal is worth more than numeric-looking ref order.
  const direction = descending ? "desc" as const : "asc" as const;

  const directionPredicate = filters.direction === undefined
    ? sql`true`
    : filters.direction === "outbound"
      ? sql`u.is_sent_by_me`
      : filters.direction === "inbound"
        ? sql`not u.is_sent_by_me and u.sender_role <> 'system'`
        : sql`u.sender_role = 'unknown'`;
  const inWindow = (eventTime: SQL) => sql`(
    ${eventTime} is null or (${eventTime} >= ${input.from} and ${eventTime} < ${input.to})
  )`;

  return sql`
    with page as (
      select p.id as page_id, p.ofapi_account_id
      from pages p
      where p.id = ${input.pageId}
    ),
    -- Select only refs here, then load EVERY version of those refs below.
    -- Filtering the wide arms by time would let an older in-window copy win
    -- when the preferred source moved that message outside the window.
    window_refs as materialized (
      select ma.message_ref
      from message_archive ma
      where ma.account_id = ${input.pageId}
        and ma.platform = ${input.platform}
        and ma.conversation_ref = ${input.conversationRef}
        and ${inWindow(sql`ma.occurred_at`)}
      union
      select d.platform_message_id as message_ref
      from dm_message_archive d
      where d.platform = ${input.platform}
        and d.platform_account_id = ${input.pageId}
        and d.platform_conversation_id = ${input.conversationRef}
        and ${inWindow(sql`d.message_created_at`)}
      union
      select m.platform_message_id as message_ref
      from page_dm_messages m
      join page_dm_threads t on t.id = m.conversation_id
      where t.platform_account_id = ${input.pageId}
        and t.platform_conversation_id = ${input.conversationRef}
        and ${inWindow(sql`m.created_at`)}
    ),
    archive_arm as (
      select ma.message_ref,
             ma.native_message_id::text as native_message_ref,
             ma.occurred_at as event_time,
             ma.text_plain,
             ma.text_html,
             ma.sender_role::text as sender_role,
             ma.fan_native_id as sender_hint,
             ma.is_sent_by_me,
             ma.price_mills,
             ma.is_opened,
             ma.is_new,
             ma.is_tip,
             ma.tip_amount_mills,
             ma.tip_text_plain,
             ma.in_reply_to_ref,
             ma.reply_metadata,
             ma.media_metadata,
             ma.origin_class,
             ma.material_observed_at,
             ma.vendor_changed_at,
             ma.source_account_seq,
             ma.serving_contract_version,
             ma.backfill_source,
             ma.content_pending,
             ma.deleted_at,
             ma.fan_native_id as fan_platform_user_id,
             'message_archive'::text as source_plane,
             1 as source_rank
      from message_archive ma
      join window_refs r on r.message_ref = ma.message_ref
      where ma.account_id = ${input.pageId}
        and ma.platform = ${input.platform}
        and ma.conversation_ref = ${input.conversationRef}
    ),
    -- Structurally OnlyFans-only (ofapi_account_id is NOT NULL there); on Fansly
    -- this arm simply matches nothing, which is why #6 needs no platform branch.
    dm_arm as (
      select d.platform_message_id as message_ref,
             null::text as native_message_ref,
             d.message_created_at as event_time,
             d.text_plain,
             null::text as text_html,
             d.sender_role::text as sender_role,
             d.sender_platform_user_id as sender_hint,
             d.is_sent_by_me,
             d.price_mills,
             d.is_opened,
             null::boolean as is_new,
             d.is_tip,
             d.tip_amount_mills,
             null::text as tip_text_plain,
             d.in_reply_to_message_id as in_reply_to_ref,
             null::jsonb as reply_metadata,
             d.media_metadata,
             null::text as origin_class,
             d.rest_material_observed_at as material_observed_at,
             d.rest_platform_changed_at as vendor_changed_at,
             null::bigint as source_account_seq,
             0 as serving_contract_version,
             d.source as backfill_source,
             (d.message_created_at is null) as content_pending,
             d.deleted_at,
             d.fan_platform_user_id,
             'dm_message_archive'::text as source_plane,
             2 as source_rank
      from dm_message_archive d
      join window_refs r on r.message_ref = d.platform_message_id
      where d.platform = ${input.platform}
        and d.platform_account_id = ${input.pageId}
        and d.platform_conversation_id = ${input.conversationRef}
    ),
    hot_arm as (
      select m.platform_message_id as message_ref,
             null::text as native_message_ref,
             m.created_at as event_time,
             m.content as text_plain,
             null::text as text_html,
             m.sender_role::text as sender_role,
             m.sender_platform_user_id as sender_hint,
             (m.sender_role = 'model') as is_sent_by_me,
             null::bigint as price_mills,
             (m.purchased_at is not null) as is_opened,
             null::boolean as is_new,
             (m.total_tip_amount_cents > 0) as is_tip,
             (m.total_tip_amount_cents::bigint * 10) as tip_amount_mills,
             null::text as tip_text_plain,
             m.in_reply_to_message_id as in_reply_to_ref,
             null::jsonb as reply_metadata,
             '[]'::jsonb as media_metadata,
             null::text as origin_class,
             null::timestamptz as material_observed_at,
             null::timestamptz as vendor_changed_at,
             null::bigint as source_account_seq,
             0 as serving_contract_version,
             null::text as backfill_source,
             false as content_pending,
             m.deleted_at,
             t.partner_platform_user_id as fan_platform_user_id,
             'page_dm_messages'::text as source_plane,
             0 as source_rank
      from page_dm_messages m
      join page_dm_threads t on t.id = m.conversation_id
      join window_refs r on r.message_ref = m.platform_message_id
      where t.platform_account_id = ${input.pageId}
        and t.platform_conversation_id = ${input.conversationRef}
    ),
    candidates as (
      select * from archive_arm
      union all select * from dm_arm
      union all select * from hot_arm
    ),
    candidate_refs as (select distinct c.message_ref from candidates c),
    -- A delete webhook carries no chat scope, so its tombstone stub has a NULL
    -- conversation id: it is reachable only through the account-wide unique key.
    -- Resolve the binding once and supply the full index key. A join to pages
    -- can check the binding only AFTER scanning another platform's tombstones.
    cross_tombstones as (
      select r.message_ref
      from candidate_refs r
      join dm_message_archive d
        on d.platform = ${input.platform}
       and d.ofapi_account_id = (select p.ofapi_account_id from page p)
       and d.platform_message_id = r.message_ref
      where d.deleted_at is not null
    ),
    tombstoned as (
      select c.message_ref from candidates c where c.deleted_at is not null
      union
      select ct.message_ref from cross_tombstones ct
    ),
    hot_upgrade as (
      select m.platform_message_id as message_ref, m.purchased_at
      from page_dm_messages m
      join page_dm_threads t on t.id = m.conversation_id
      join window_refs r on r.message_ref = m.platform_message_id
      where t.platform_account_id = ${input.pageId}
        and t.platform_conversation_id = ${input.conversationRef}
        and m.purchased_at is not null
    ),
    -- Dedup happens HERE, before any limit: a page truncated by duplicates would
    -- under-report and the count would be a lie.
    best as (
      select distinct on (c.message_ref) c.*
      from candidates c
      order by c.message_ref, c.source_rank desc
    ),
    unioned as (
      select b.*,
             (b.message_ref in (select t.message_ref from tombstoned t)) as is_tombstoned,
             case when h.purchased_at is not null then true else b.is_opened end as is_opened_upgraded
      from best b
      left join hot_upgrade h on h.message_ref = b.message_ref
    ),
    u as (
      select unioned.*,
             ${renderInstant(sql`unioned.event_time`)} as k_sort,
             unioned.message_ref as k_key
      from unioned
    )
    select u.message_ref,
           u.native_message_ref,
           u.event_time,
           u.text_plain,
           u.text_html,
           u.sender_role,
           u.sender_hint,
           u.is_sent_by_me,
           u.price_mills::text as price_mills,
           u.is_opened_upgraded as is_opened,
           u.is_new,
           u.is_tip,
           u.tip_amount_mills::text as tip_amount_mills,
           u.tip_text_plain,
           u.in_reply_to_ref,
           u.reply_metadata,
           u.media_metadata,
           u.origin_class,
           u.material_observed_at,
           u.vendor_changed_at,
           u.source_account_seq::text as source_account_seq,
           u.serving_contract_version,
           u.backfill_source,
           u.content_pending,
           u.deleted_at,
           u.fan_platform_user_id,
           u.source_plane,
           u.is_tombstoned,
           u.k_sort,
           u.k_key
    from u
    where ${inWindow(sql`u.event_time`)}
      and ${keysetPredicate(direction, input.after)}
      and (${includeDeleted} or not u.is_tombstoned)
      and ${directionPredicate}
      and (${filters.senderRole ?? null}::text is null or u.sender_role = ${filters.senderRole ?? null})
      and ${boolPredicate(sql`jsonb_array_length(coalesce(u.media_metadata, '[]'::jsonb)) > 0`, filters.hasMedia)}
      and ${boolPredicate(sql`u.price_mills is not null`, filters.hasPrice)}
      and ${boolPredicate(sql`u.is_tip`, filters.isTip)}
    ${keysetOrderBy(direction)}
    limit ${limit}
  `;
}

function toRow(raw: Record<string, unknown>): AgentTranscriptRow {
  const tombstoned = raw.is_tombstoned === true;
  const deletedAt = raw.deleted_at == null ? null : new Date(raw.deleted_at as string | Date);
  return {
    messageRef: String(raw.message_ref),
    nativeMessageRef: raw.native_message_ref == null ? null : String(raw.native_message_ref),
    occurredAt: raw.event_time == null ? null : new Date(raw.event_time as string | Date),
    senderRole: String(raw.sender_role ?? "unknown"),
    senderPlatformUserId: raw.sender_hint == null ? null : String(raw.sender_hint),
    isSentByMe: raw.is_sent_by_me === true,
    textPlain: raw.text_plain == null ? null : String(raw.text_plain),
    textHtml: raw.text_html == null ? null : String(raw.text_html),
    priceMills: raw.price_mills == null ? null : BigInt(String(raw.price_mills)),
    isOpened: raw.is_opened == null ? null : raw.is_opened === true,
    isNew: raw.is_new == null ? null : raw.is_new === true,
    isTip: raw.is_tip === true,
    tipAmountMills: raw.tip_amount_mills == null ? null : BigInt(String(raw.tip_amount_mills)),
    tipTextPlain: raw.tip_text_plain == null ? null : String(raw.tip_text_plain),
    inReplyToRef: raw.in_reply_to_ref == null ? null : String(raw.in_reply_to_ref),
    replyMetadata: (raw.reply_metadata as Record<string, unknown> | null) ?? null,
    mediaMetadata: (raw.media_metadata as Array<Record<string, unknown>> | null) ?? [],
    originClass: raw.origin_class == null ? null : String(raw.origin_class),
    materialObservedAt: raw.material_observed_at == null
      ? null
      : new Date(raw.material_observed_at as string | Date),
    vendorChangedAt: raw.vendor_changed_at == null
      ? null
      : new Date(raw.vendor_changed_at as string | Date),
    sourceAccountSeq: raw.source_account_seq == null ? null : Number(raw.source_account_seq),
    servingContractVersion: Number(raw.serving_contract_version ?? 0),
    backfillSource: raw.backfill_source == null ? null : String(raw.backfill_source),
    contentPending: raw.content_pending === true,
    // Tombstone DOMINANCE: a ref deleted in any store is deleted everywhere, even
    // when the winning row's own column is null.
    deletedAt: tombstoned ? (deletedAt ?? new Date(0)) : deletedAt,
    fanPlatformUserId: raw.fan_platform_user_id == null
      ? null
      : String(raw.fan_platform_user_id),
    sourcePlane: String(raw.source_plane),
    sortValue: raw.k_sort == null ? null : String(raw.k_sort),
    keysetKey: String(raw.k_key),
  };
}

export async function listAgentTranscript(
  db: Database,
  input: AgentTranscriptInput,
): Promise<{ rows: AgentTranscriptRow[]; witnesses: PlaneReadWitness[] }> {
  const result = await db.execute<Record<string, unknown>>(
    buildUnionQuery(input, Math.min(input.limit, AGENT_TRANSCRIPT_UNION_MAX_ROWS)),
  );
  return {
    rows: result.rows.map(toRow),
    // All three message stores are scanned by the union, on both platforms: on
    // Fansly the OF-only arm simply matches nothing. `read` is therefore literally
    // true for each of them, and the caller adds the thread plane it also joined.
    //
    // BL-A11: only `message_archive`'s floor was established (the caller's
    // dedicated unbounded query runs over that store); stamping the same date
    // on the other three arms fabricated floors nobody computed. They report
    // `unknown` until someone pays for their own floor queries.
    witnesses: [
      witnessFor("message_archive", input.archiveFloor),
      ...witnessesFor(["dm_message_archive", "page_dm_messages", "page_dm_threads"]),
    ],
  };
}

/**
 * Count the same filtered, deduplicated population up to `probeMax + 1`.
 * The extra row distinguishes an exact count from a lower bound. Delivery's
 * smaller row ceiling and cursor must not truncate this independent probe.
 */
export async function countAgentTranscript(
  db: Database,
  input: AgentTranscriptInput,
  probeMax: number,
): Promise<{ value: number; exact: boolean }> {
  const probe = buildUnionQuery({ ...input, after: undefined }, probeMax + 1);
  const result = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from (${probe}) probe`,
  );
  const value = Number(result.rows[0]?.count ?? 0);
  return value > probeMax ? { value: probeMax + 1, exact: false } : { value, exact: true };
}

/** Perf-gate seam: EXPLAIN over the EXACT statement the reader runs. */
export async function explainAgentTranscript(
  db: Database,
  input: AgentTranscriptInput,
): Promise<string> {
  const result = await db.execute<{ "QUERY PLAN": string }>(
    sql`explain (format text) ${buildUnionQuery(input, Math.min(input.limit, AGENT_TRANSCRIPT_UNION_MAX_ROWS))}`,
  );
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}
