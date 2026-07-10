// Message-archive projection (kernel Stage 10). A REBUILDABLE projection over
// message.* domain events — never a fact store. The writer applies events
// per account behind the standard seq watermark; rebuild = truncate scope +
// reset watermark + re-apply from the ledger. Backfills from the frozen
// OFAPI-only dm_message_archive and the hot table are idempotent via the
// (account_id, platform, message_ref) unique key.

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

export const MESSAGE_ARCHIVE_PROJECTION = "message_archive";

export interface MessageArchiveEventRow {
  id: number;
  accountSeq: number;
  type: string;
  occurredAt: Date;
  fanIdentityRef: string | null;
  conversationRef: string | null;
  messageRef: string | null;
  data: unknown;
}

function dataField(data: unknown, field: string): unknown {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)[field]
    : undefined;
}

/** $ → mills for event payload prices (OFAPI payloads carry dollars). */
function dollarsFieldToMills(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return BigInt(Math.round(value * 1000));
}

/** Mills-verbatim event fields (Fansly events carry mills, not dollars). */
function millsFieldToBigInt(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return BigInt(Math.round(value));
}

/**
 * Tip mills across the three producers' event shapes: Fansly sync-pull
 * carries tipAmountMills (MILLS, verbatim); desktop harvest carries
 * tipAmount (dollars); OFAPI webhook/pull tips carry only price (dollars).
 */
function tipMillsFromEventData(data: unknown, priceMills: bigint | null): bigint | null {
  return millsFieldToBigInt(dataField(data, "tipAmountMills"))
    ?? dollarsFieldToMills(dataField(data, "tipAmount"))
    ?? priceMills;
}

/** Wave 2: superseding-event head fields (schema-v2 message.* events carry
 * the COMPLETE merged head in data.head — mills as decimal strings). */
function supersedingHead(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (record.supersedesEventId === undefined || record.supersedesEventId === null) {
    return null;
  }
  const head = record.head;
  return typeof head === "object" && head !== null && !Array.isArray(head)
    ? head as Record<string, unknown>
    : null;
}

function headMills(value: unknown): bigint | null {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return null;
}

function headDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Applies one account's message.* events (ordered by account_seq) onto the
 * archive. received/sent insert (first writer wins — cross-producer dedup
 * already collapsed same-fact events upstream); deleted tombstones;
 * ppv_unlocked is a NO-OP in v1 (notification-shaped, unreliable message ref
 * — recorded deviation). Wave 2: a SUPERSEDING event (schema v2,
 * data.supersedesEventId + data.head) REPLACES the row's material — the
 * same-message superseding merge; account_seq ordering keeps replays
 * monotone, and deleted_at stays sticky. Returns rows written/tombstoned.
 */
export async function applyMessageEventsToArchive(
  db: Database,
  input: {
    accountId: number;
    platform: string;
    events: readonly MessageArchiveEventRow[];
  },
): Promise<{ inserted: number; tombstoned: number }> {
  let inserted = 0;
  let tombstoned = 0;

  for (const event of input.events) {
    if (event.type === "message.received" || event.type === "message.sent") {
      if (!event.messageRef) {
        continue;
      }
      const head = supersedingHead(event.data);
      if (head !== null) {
        // Wave 2 superseding merge: the head REPLACES material (this is the
        // repair path — first-writer-wins would leave the row unhealed).
        // deleted_at is deliberately NOT in the SET list (sticky), and the
        // stub flag clears (the head is complete by construction).
        const result = await db.execute(sql`
          insert into message_archive (
            account_id, platform, conversation_ref, message_ref, fan_native_id,
            sender_role, is_sent_by_me, occurred_at, text_plain, price_mills,
            is_tip, tip_amount_mills, in_reply_to_ref, media_metadata,
            source_event_id
          ) values (
            ${input.accountId},
            ${input.platform},
            ${event.conversationRef},
            ${event.messageRef},
            ${event.fanIdentityRef},
            ${typeof head.senderRole === "string" ? head.senderRole : "unknown"},
            ${head.isSentByMe === true},
            ${headDate(head.createdAt) ?? event.occurredAt},
            ${typeof head.text === "string" ? head.text : ""},
            ${headMills(head.priceMills)},
            ${head.isTip === true},
            ${headMills(head.tipAmountMills) ?? 0n},
            ${typeof head.inReplyToMessageId === "string" ? head.inReplyToMessageId : null},
            ${JSON.stringify(Array.isArray(head.media) ? head.media : [])}::jsonb,
            ${event.id}
          )
          on conflict (account_id, platform, message_ref) do update set
            conversation_ref = coalesce(excluded.conversation_ref, message_archive.conversation_ref),
            fan_native_id = coalesce(excluded.fan_native_id, message_archive.fan_native_id),
            sender_role = excluded.sender_role,
            is_sent_by_me = excluded.is_sent_by_me,
            occurred_at = excluded.occurred_at,
            text_plain = excluded.text_plain,
            price_mills = excluded.price_mills,
            is_tip = excluded.is_tip,
            tip_amount_mills = excluded.tip_amount_mills,
            in_reply_to_ref = excluded.in_reply_to_ref,
            media_metadata = excluded.media_metadata,
            source_event_id = excluded.source_event_id,
            content_pending = false,
            updated_at = now()
          returning id
        `);
        inserted += result.rows.length;
        continue;
      }
      const price = dollarsFieldToMills(dataField(event.data, "price"));
      const isTip = dataField(event.data, "isTip") === true;
      const tipMills = isTip ? tipMillsFromEventData(event.data, price) ?? 0n : 0n;
      const text = dataField(event.data, "text");
      // First REAL writer wins: the conflict-update only hydrates
      // tombstone-first stubs (content_pending), never a content row. The
      // stub's deleted_at is deliberately NOT in the SET list — hydration
      // keeps the tombstone.
      const result = await db.execute(sql`
        insert into message_archive (
          account_id, platform, conversation_ref, message_ref, fan_native_id,
          sender_role, is_sent_by_me, occurred_at, text_plain, price_mills,
          is_tip, tip_amount_mills, source_event_id
        ) values (
          ${input.accountId},
          ${input.platform},
          ${event.conversationRef},
          ${event.messageRef},
          ${event.fanIdentityRef},
          ${event.type === "message.received" ? "fan" : "model"},
          ${event.type === "message.sent"},
          ${event.occurredAt},
          ${typeof text === "string" ? text : ""},
          ${price},
          ${isTip},
          ${tipMills},
          ${event.id}
        )
        on conflict (account_id, platform, message_ref) do update set
          conversation_ref = excluded.conversation_ref,
          fan_native_id = excluded.fan_native_id,
          sender_role = excluded.sender_role,
          is_sent_by_me = excluded.is_sent_by_me,
          occurred_at = excluded.occurred_at,
          text_plain = excluded.text_plain,
          price_mills = excluded.price_mills,
          is_tip = excluded.is_tip,
          tip_amount_mills = excluded.tip_amount_mills,
          source_event_id = excluded.source_event_id,
          content_pending = false,
          updated_at = now()
        where message_archive.content_pending
        returning id
      `);
      inserted += result.rows.length;
    } else if (event.type === "message.deleted") {
      if (!event.messageRef) {
        continue;
      }
      // Tombstone-first, one atomic statement: no row yet → insert a
      // content_pending stub carrying the tombstone (the later content
      // event hydrates it); live row → set deleted_at; already tombstoned →
      // no-op (idempotent replay).
      const result = await db.execute(sql`
        insert into message_archive (
          account_id, platform, message_ref, occurred_at, content_pending,
          deleted_at, source_event_id
        ) values (
          ${input.accountId},
          ${input.platform},
          ${event.messageRef},
          ${event.occurredAt},
          true,
          ${event.occurredAt},
          ${event.id}
        )
        on conflict (account_id, platform, message_ref) do update
          set deleted_at = excluded.deleted_at, updated_at = now()
          where message_archive.deleted_at is null
        returning id
      `);
      tombstoned += result.rows.length;
    }
  }

  return { inserted, tombstoned };
}

export async function getProjectionWatermark(
  db: Database,
  projection: string,
  accountId: number,
): Promise<number> {
  const result = await db.execute<{ high_seq: string }>(sql`
    select high_seq::text from projection_seq_watermarks
    where projection = ${projection} and account_id = ${accountId}
  `);
  return result.rows[0] ? Number(result.rows[0].high_seq) : 0;
}

export async function setProjectionWatermark(
  db: Database,
  projection: string,
  accountId: number,
  highSeq: number,
): Promise<void> {
  await db.execute(sql`
    insert into projection_seq_watermarks (projection, account_id, high_seq, updated_at)
    values (${projection}, ${accountId}, ${highSeq}, now())
    on conflict (projection, account_id) do update
      set high_seq = excluded.high_seq, updated_at = now()
      where projection_seq_watermarks.high_seq < excluded.high_seq
  `);
}

/** Accounts holding any domain events — the projection sweep's work list. */
export async function listEventAccounts(db: Database): Promise<number[]> {
  const result = await db.execute<{ account_id: string }>(sql`
    select account_id::text from domain_event_seq order by account_id
  `);
  return result.rows.map((row) => Number(row.account_id));
}

/** Rebuild support: truncate the projection's scope + reset its watermark. */
export async function resetMessageArchiveProjection(
  db: Database,
  accountId?: number | null,
): Promise<void> {
  // One transaction: a crash between the two deletes would otherwise leave
  // an empty archive behind a stale high watermark — permanently and
  // silently empty, since the next run sees no events past it.
  await db.transaction(async (tx) => {
    if (accountId != null) {
      await tx.execute(sql`delete from message_archive where account_id = ${accountId}`);
      await tx.execute(sql`
        delete from projection_seq_watermarks
        where projection = ${MESSAGE_ARCHIVE_PROJECTION} and account_id = ${accountId}
      `);
      return;
    }
    await tx.execute(sql`delete from message_archive`);
    await tx.execute(sql`
      delete from projection_seq_watermarks where projection = ${MESSAGE_ARCHIVE_PROJECTION}
    `);
  });
}

/**
 * Backfill source 1: the frozen OFAPI-only dm_message_archive. Direct column
 * copy, idempotent, batched by id checkpoint. Returns rows copied + the new
 * checkpoint (null when exhausted).
 */
export async function backfillArchiveFromDmMessageArchive(
  db: Database,
  input: { afterId?: number | null; batchSize?: number },
): Promise<{ lastId: number | null }> {
  const batchSize = input.batchSize ?? 10_000;
  const afterId = input.afterId ?? 0;
  const result = await db.execute<{ id: string }>(sql`
    with batch as (
      select * from dm_message_archive
      where id > ${afterId}
      order by id
      limit ${batchSize}
    ), copied as (
      insert into message_archive (
        account_id, platform, native_account_ref, conversation_ref, message_ref,
        fan_native_id, sender_role, is_sent_by_me, occurred_at, text_plain,
        price_mills, is_tip, tip_amount_mills, in_reply_to_ref, media_metadata,
        deleted_at, backfill_source
      )
      select platform_account_id, platform::text, ofapi_account_id,
             platform_conversation_id, platform_message_id, fan_platform_user_id,
             sender_role::text, is_sent_by_me, message_created_at, text_plain,
             price_mills, is_tip, tip_amount_mills, in_reply_to_message_id,
             media_metadata, deleted_at, 'dm_message_archive'
      from batch
      on conflict (account_id, platform, message_ref) do update set
        native_account_ref = excluded.native_account_ref,
        conversation_ref = excluded.conversation_ref,
        fan_native_id = excluded.fan_native_id,
        sender_role = excluded.sender_role,
        is_sent_by_me = excluded.is_sent_by_me,
        occurred_at = excluded.occurred_at,
        text_plain = excluded.text_plain,
        price_mills = excluded.price_mills,
        is_tip = excluded.is_tip,
        tip_amount_mills = excluded.tip_amount_mills,
        in_reply_to_ref = excluded.in_reply_to_ref,
        media_metadata = excluded.media_metadata,
        deleted_at = coalesce(message_archive.deleted_at, excluded.deleted_at),
        backfill_source = excluded.backfill_source,
        content_pending = false,
        updated_at = now()
      where message_archive.content_pending
      returning 1
    )
    select max(batch.id)::text as id from batch
  `);
  const lastIdText = result.rows[0]?.id ?? null;
  return { lastId: lastIdText === null ? null : Number(lastIdText) };
}

/**
 * Backfill source 2: the hot table (both platforms — the Fansly-critical
 * copy). total_tip_amount_cents is CENTS; the ×10 below is the cents→mills
 * conversion (shared money codec semantics — Stage 27 later bans the bare
 * arithmetic form outside backfill SQL).
 */
export async function backfillArchiveFromHotTable(
  db: Database,
  input: { afterId?: number | null; batchSize?: number },
): Promise<{ lastId: number | null }> {
  const batchSize = input.batchSize ?? 10_000;
  const afterId = input.afterId ?? 0;
  const result = await db.execute<{ id: string }>(sql`
    with batch as (
      select m.*, t.platform_conversation_id, t.partner_platform_user_id, p.platform as page_platform
      from page_dm_messages m
      join page_dm_threads t on t.id = m.conversation_id
      join pages p on p.id = m.platform_account_id
      where m.id > ${afterId}
      order by m.id
      limit ${batchSize}
    ), copied as (
      insert into message_archive (
        account_id, platform, conversation_ref, message_ref, fan_native_id,
        sender_role, is_sent_by_me, occurred_at, text_plain, tip_amount_mills,
        is_tip, in_reply_to_ref, deleted_at, backfill_source
      )
      select platform_account_id, page_platform::text, platform_conversation_id,
             platform_message_id, partner_platform_user_id, sender_role::text,
             (sender_role = 'model'), created_at, content,
             (total_tip_amount_cents::bigint * 10),
             (total_tip_amount_cents > 0), in_reply_to_message_id, deleted_at,
             'hot_table'
      from batch
      on conflict (account_id, platform, message_ref) do update set
        conversation_ref = excluded.conversation_ref,
        fan_native_id = excluded.fan_native_id,
        sender_role = excluded.sender_role,
        is_sent_by_me = excluded.is_sent_by_me,
        occurred_at = excluded.occurred_at,
        text_plain = excluded.text_plain,
        tip_amount_mills = excluded.tip_amount_mills,
        is_tip = excluded.is_tip,
        in_reply_to_ref = excluded.in_reply_to_ref,
        deleted_at = coalesce(message_archive.deleted_at, excluded.deleted_at),
        backfill_source = excluded.backfill_source,
        content_pending = false,
        updated_at = now()
      where message_archive.content_pending
      returning 1
    )
    select max(batch.id)::text as id from batch
  `);
  const lastIdText = result.rows[0]?.id ?? null;
  return { lastId: lastIdText === null ? null : Number(lastIdText) };
}

export interface ArchiveMessageRow {
  id: number;
  accountId: number;
  platform: string;
  conversationRef: string | null;
  messageRef: string;
  fanNativeId: string | null;
  senderRole: string;
  isSentByMe: boolean;
  occurredAt: Date | null;
  textPlain: string;
  priceMills: string | null;
  isTip: boolean;
  tipAmountMills: string;
  deletedAt: Date | null;
}

function mapArchiveRow(row: Record<string, unknown>): ArchiveMessageRow {
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    platform: String(row.platform),
    conversationRef: (row.conversation_ref as string | null) ?? null,
    messageRef: String(row.message_ref),
    fanNativeId: (row.fan_native_id as string | null) ?? null,
    senderRole: String(row.sender_role),
    isSentByMe: row.is_sent_by_me === true,
    occurredAt: row.occurred_at == null ? null : new Date(row.occurred_at as string | Date),
    textPlain: String(row.text_plain ?? ""),
    priceMills: row.price_mills == null ? null : String(row.price_mills),
    isTip: row.is_tip === true,
    tipAmountMills: String(row.tip_amount_mills ?? "0"),
    deletedAt: row.deleted_at == null ? null : new Date(row.deleted_at as string | Date),
  };
}

/**
 * Kernel Stage 28 prune gate: the hot page_dm_messages prune may only run
 * while the archive provably holds every hot message (archive >= hot, per
 * conversation). Returns the number of conversations with uncovered
 * messages — 0 means pruning is safe.
 */
export async function countArchiveCoverageGaps(db: Database): Promise<number> {
  const result = await db.execute<{ gaps: string }>(sql`
    select count(*)::text as gaps from (
      select m.conversation_id
      from page_dm_messages m
      join pages p on p.id = m.platform_account_id
      left join message_archive a
        on a.account_id = m.platform_account_id
        and a.platform = p.platform::text
        and a.message_ref = m.platform_message_id
      group by m.conversation_id
      having count(*) filter (where a.account_id is null) > 0
    ) uncovered
  `);
  return Number(result.rows[0]?.gaps ?? 0);
}

export async function listArchiveConversationMessages(
  db: Database,
  input: {
    /** undefined = unscoped (owner); [] = no visible pages. */
    accountIds?: readonly number[];
    conversationRef: string;
    beforeId?: number | null;
    limit?: number;
  },
): Promise<ArchiveMessageRow[]> {
  if (input.accountIds !== undefined && input.accountIds.length === 0) {
    return [];
  }
  const limit = Math.min(input.limit ?? 100, 500);
  const conditions = [sql`ma.conversation_ref = ${input.conversationRef}`];
  if (input.accountIds !== undefined) {
    conditions.push(sql`ma.account_id in (${sql.join(input.accountIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  if (input.beforeId != null) {
    conditions.push(sql`ma.id < ${input.beforeId}`);
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select ma.* from message_archive ma
    where ${sql.join(conditions, sql` and `)}
    order by ma.occurred_at desc nulls last, ma.id desc
    limit ${limit}
  `);
  return result.rows.map(mapArchiveRow);
}

/**
 * Internal AI transcript reader (fastreply-freshness PR2). Distinct from the
 * dashboard's listArchiveConversationMessages on purpose: tombstones and
 * content-pending stubs are filtered HERE, in the reader/repo layer (prompt
 * code never re-filters — the prompt unit is manifest-pinned), and the cap
 * is 1500 (AI windows read deeper than the dashboard's 500 clamp, whose
 * route contract is unchanged).
 */
export async function listArchiveConversationMessagesForAi(
  db: Database,
  input: {
    accountId: number;
    conversationRef: string;
    limit?: number;
  },
): Promise<ArchiveMessageRow[]> {
  const limit = Math.min(input.limit ?? 100, 1500);
  const result = await db.execute<Record<string, unknown>>(sql`
    select ma.* from message_archive ma
    where ma.conversation_ref = ${input.conversationRef}
      and ma.account_id = ${input.accountId}
      and ma.deleted_at is null
      and ma.content_pending = false
    order by ma.occurred_at desc nulls last, ma.id desc
    limit ${limit}
  `);
  return result.rows.map(mapArchiveRow);
}

export async function searchArchiveMessages(
  db: Database,
  input: {
    /** undefined = unscoped (owner); [] = no visible pages. */
    accountIds?: readonly number[];
    query: string;
    fanNativeId?: string | null;
    limit?: number;
  },
): Promise<ArchiveMessageRow[]> {
  if (input.accountIds !== undefined && input.accountIds.length === 0) {
    return [];
  }
  const limit = Math.min(input.limit ?? 50, 200);
  const conditions = [sql`ma.text_plain ilike ${`%${input.query}%`}`];
  if (input.accountIds !== undefined) {
    conditions.push(sql`ma.account_id in (${sql.join(input.accountIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  if (input.fanNativeId) {
    conditions.push(sql`ma.fan_native_id = ${input.fanNativeId}`);
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select ma.* from message_archive ma
    where ${sql.join(conditions, sql` and `)}
    order by ma.occurred_at desc nulls last, ma.id desc
    limit ${limit}
  `);
  return result.rows.map(mapArchiveRow);
}

export interface BackscrollManifestRow {
  accountId: number;
  pageLabel: string;
  conversationRef: string;
  hotCount: number;
  archiveCount: number;
  earliestArchivedAt: Date | null;
  cursorState: unknown;
}

/**
 * Stage 17 manifest: per Fansly conversation — hot-table count vs archive
 * count, earliest archived timestamp, and the deep-backfill cursor state.
 * Completeness = every conversation exhausted AND archive >= hot.
 */
export async function listFanslyBackscrollManifest(
  db: Database,
): Promise<BackscrollManifestRow[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select t.platform_account_id as account_id,
           p.label as page_label,
           t.platform_conversation_id as conversation_ref,
           (select count(*) from page_dm_messages m
             where m.conversation_id = t.id and m.deleted_at is null) as hot_count,
           (select count(*) from message_archive ma
             where ma.account_id = t.platform_account_id
               and ma.conversation_ref = t.platform_conversation_id) as archive_count,
           (select min(ma.occurred_at) from message_archive ma
             where ma.account_id = t.platform_account_id
               and ma.conversation_ref = t.platform_conversation_id) as earliest_archived_at,
           (select c.state from page_sync_cursors c
             where c.page_id = t.platform_account_id and c.stream = 'dm_messages'
             limit 1) as cursor_state
    from page_dm_threads t
    join pages p on p.id = t.platform_account_id
    where p.platform = 'fansly' and p.status = 'active'
    order by p.label, t.platform_conversation_id
  `);
  return result.rows.map((row) => ({
    accountId: Number(row.account_id),
    pageLabel: String(row.page_label),
    conversationRef: String(row.conversation_ref),
    hotCount: Number(row.hot_count),
    archiveCount: Number(row.archive_count),
    earliestArchivedAt: row.earliest_archived_at == null
      ? null
      : new Date(row.earliest_archived_at as string | Date),
    cursorState: row.cursor_state ?? null,
  }));
}

/** Stage 16 v3: upsert one per-fan earnings window row (amounts in mills). */
export async function upsertFanEarningsStat(
  db: Database,
  input: {
    accountId: number;
    fanId: number;
    window: string;
    grossMills: number;
    netMills: number | null;
    observedAt: Date;
    sourceEventId: number;
  },
): Promise<void> {
  await db.execute(sql`
    insert into fan_earnings_stats (
      account_id, fan_id, "window", gross_mills, net_mills, observed_at, source_event_id
    ) values (
      ${input.accountId}, ${input.fanId}, ${input.window}, ${input.grossMills},
      ${input.netMills}, ${input.observedAt}, ${input.sourceEventId}
    )
    on conflict (account_id, fan_id, "window") do update set
      gross_mills = excluded.gross_mills,
      net_mills = excluded.net_mills,
      observed_at = excluded.observed_at,
      source_event_id = excluded.source_event_id,
      updated_at = now()
    where excluded.observed_at >= fan_earnings_stats.observed_at
  `);
}

// ── Stage 32: board reads over the Stage 16 projection ────────────────────

export interface TopFanEarningsRow {
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  grossMills: number;
  netMills: number | null;
  currency: string;
  observedAt: Date;
}

/** Top spenders for one page + window, spend-descending. Columns qualified
 * throughout (the recorded Stage 8 bare-column ORDER BY trap). */
export async function listTopFanEarnings(
  db: Database,
  input: { accountId: number; window: string; limit: number },
): Promise<TopFanEarningsRow[]> {
  const result = await db.execute(sql`
    select
      f.platform_user_id as "platformUserId",
      f.username as "username",
      f.display_name as "displayName",
      s.gross_mills as "grossMills",
      s.net_mills as "netMills",
      s.currency as "currency",
      s.observed_at as "observedAt"
    from fan_earnings_stats s
    join fans f on f.id = s.fan_id
    where s.account_id = ${input.accountId}
      and s."window" = ${input.window}
      and s.gross_mills > 0
    order by s.gross_mills desc, f.platform_user_id asc
    limit ${input.limit}
  `);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    platformUserId: String(row.platformUserId),
    username: row.username === null ? null : String(row.username),
    displayName: row.displayName === null ? null : String(row.displayName),
    grossMills: Number(row.grossMills),
    netMills: row.netMills === null ? null : Number(row.netMills),
    currency: String(row.currency),
    observedAt: new Date(String(row.observedAt)),
  }));
}

/** Snapshot honesty for the board UI: how many spenders exist in the window
 * and when the freshest row was observed (null = projection empty). */
export async function getFanEarningsSnapshotMeta(
  db: Database,
  input: { accountId: number; window: string },
): Promise<{ fanCount: number; builtAt: Date | null }> {
  const result = await db.execute(sql`
    select count(*) filter (where s.gross_mills > 0) as "fanCount",
           max(s.observed_at) as "builtAt"
    from fan_earnings_stats s
    where s.account_id = ${input.accountId} and s."window" = ${input.window}
  `);
  const row = (result.rows as Array<Record<string, unknown>>)[0];
  return {
    fanCount: row ? Number(row.fanCount) : 0,
    builtAt: row?.builtAt == null ? null : new Date(String(row.builtAt)),
  };
}
