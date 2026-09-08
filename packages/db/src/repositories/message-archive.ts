// Message-archive projection (kernel Stage 10). A REBUILDABLE projection over
// message.* domain events — never a fact store. The writer applies events
// per account behind the standard seq watermark; rebuild = truncate scope +
// reset watermark + re-apply from the ledger. Backfills from the frozen
// OFAPI-only dm_message_archive and the hot table are idempotent via the
// (account_id, platform, message_ref) unique key.

import { normalizeDmMessageText } from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { escapeLikePattern } from "./search.ts";

export const MESSAGE_ARCHIVE_PROJECTION = "message_archive";
export const MESSAGE_ARCHIVE_SHADOW_PROJECTION = "message_archive_shadow";

/** W10 (decision #134): serializes the shadow builder and the atomic switch
 * against each other (pg_advisory_xact_lock — both run in one transaction). */
export const MESSAGE_ARCHIVE_REBUILD_LOCK_KEY = 831_010_083;

/** The only two tables archive writers may target (W10 shadow rebuild). The
 * whitelist keeps sql.raw honest — a table name never comes from input. */
export type ArchiveTargetTable = "message_archive" | "message_archive_shadow";

function archiveTable(target: ArchiveTargetTable | undefined) {
  const table = target ?? "message_archive";
  if (table !== "message_archive" && table !== "message_archive_shadow") {
    throw new Error(`Unknown archive target table: ${String(table)}`);
  }
  return sql.raw(table);
}

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

function recordField(data: unknown, field: string): Record<string, unknown> | null {
  const value = dataField(data, field);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nativeMessageBigint(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= 9_223_372_036_854_775_807n ? parsed : null;
  } catch {
    return null;
  }
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

async function applyReplyMaterial(
  db: Database,
  input: {
    accountId: number;
    platform: string;
    messageRef: string;
    targetTable: ArchiveTargetTable | undefined;
    reply: Record<string, unknown> | null;
    observedAt: Date;
  },
): Promise<void> {
  const target = archiveTable(input.targetTable);
  const observesParent = input.reply === null || Object.hasOwn(input.reply, "messageId");
  const observesRoot = input.reply === null || Object.hasOwn(input.reply, "rootMessageId");
  const parent = typeof input.reply?.messageId === "string" ? input.reply.messageId : null;
  const root = typeof input.reply?.rootMessageId === "string" ? input.reply.rootMessageId : null;
  // The row lock makes field comparison and application one operation. A
  // failed reply update propagates, so the projection watermark cannot pass it;
  // retrying the already-applied body is safe. Whole-head provenance stays put.
  await db.execute(sql`
    with current as materialized (
      select id, in_reply_to_ref, reply_metadata,
        ${observesParent} and ${input.observedAt}::timestamptz >= coalesce(
          reply_parent_observed_at,
          case when in_reply_to_ref is not null then material_observed_at end,
          '-infinity'::timestamptz
        ) as accept_parent,
        ${input.observedAt}::timestamptz >= coalesce(
          reply_root_observed_at,
          case when reply_metadata->>'rootMessageId' is not null then material_observed_at end,
          '-infinity'::timestamptz
        ) as root_due
      from ${target}
      where account_id = ${input.accountId} and platform = ${input.platform}
        and message_ref = ${input.messageRef}
      for update
    ), parent_change as (
      select *, accept_parent and in_reply_to_ref is not null
        and in_reply_to_ref is distinct from ${parent}::text as changed_parent
      from current
    ), accepted as (
      select *, (${observesRoot} or changed_parent) and root_due
        and not (${observesParent} and not accept_parent
          and in_reply_to_ref is distinct from ${parent}::text) as accept_root
      from parent_change
    ), merged as (
      select *,
        (case when changed_parent
          then case when reply_metadata ? 'rootMessageId'
            then jsonb_build_object('rootMessageId', reply_metadata->'rootMessageId')
            else '{}'::jsonb end
          else coalesce(reply_metadata, '{}'::jsonb) end)
        || (case when accept_parent then jsonb_build_object('messageId', ${parent}::text) else '{}'::jsonb end)
        || (case when accept_root then jsonb_build_object('rootMessageId', ${root}::text) else '{}'::jsonb end)
          as next_metadata
      from accepted
    )
    update ${target} as target set
      in_reply_to_ref = case when merged.accept_parent then ${parent}::text else target.in_reply_to_ref end,
      reply_metadata = case
        when merged.next_metadata->>'messageId' is null
          and merged.next_metadata->>'rootMessageId' is null then null
        else merged.next_metadata end,
      reply_parent_observed_at = case when merged.accept_parent
        then ${input.observedAt}::timestamptz else target.reply_parent_observed_at end,
      reply_root_observed_at = case when merged.accept_root
        then ${input.observedAt}::timestamptz else target.reply_root_observed_at end,
      updated_at = now()
    from merged where target.id = merged.id
      and (merged.accept_parent or merged.accept_root)
  `);
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
 *
 * W10 additions: `targetTable` routes the same writer into the shadow table
 * during a rebuild (whitelisted — never caller data), and text_plain is
 * derived through normalizeDmMessageText (A51): the event ledger stays
 * verbatim, the PROJECTION strips HTML — so a shadow replay heals rows that
 * were projected before the strip existed.
 */
export async function applyMessageEventsToArchive(
  db: Database,
  input: {
    accountId: number;
    platform: string;
    events: readonly MessageArchiveEventRow[];
    targetTable?: ArchiveTargetTable;
  },
): Promise<{ inserted: number; tombstoned: number }> {
  const target = archiveTable(input.targetTable);
  let inserted = 0;
  let tombstoned = 0;

  for (const event of input.events) {
    if (event.type === "message.material_observed") {
      if (!event.messageRef) continue;
      const head = recordField(event.data, "head");
      if (!head || typeof head.isSentByMe !== "boolean") continue;
      const fieldPresence = recordField(head, "fieldPresence");
      const observesMedia = fieldPresence?.media !== false;
      // v5 Fansly sidecars falsely declared reply:null as observed. Reply v1
      // is applied separately, with field clocks, including on stale replays.
      const observesReply = fieldPresence?.reply !== false
        && head.originClass !== "fansly_dm_sidecar";
      const observesTipText = fieldPresence?.tipText !== false;
      const reply = typeof head.reply === "object" && head.reply !== null && !Array.isArray(head.reply)
        ? head.reply as Record<string, unknown>
        : null;
      const media = Array.isArray(head.media)
        ? head.media.filter((item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item))
        : [];
      const textHtml = typeof head.textHtml === "string" ? head.textHtml : "";
      const isOpened = typeof head.isOpened === "boolean" ? head.isOpened : null;
      const isNew = typeof head.isNew === "boolean" ? head.isNew : null;
      const materialObservedAt = headDate(head.materialObservedAt) ?? event.occurredAt;
      const vendorChangedAt = headDate(head.vendorChangedAt);
      // The archive dates a material row from the HEAD when the head names the
      // message time, and only falls back to the event's occurred_at when it
      // does not (every OFAPI head). This is what keeps a PROVIDER-DATED
      // historical draft honest: a pre-2024 message trips the driver's
      // 2024-01-01 clamp, so event.occurredAt becomes the receipt instant while
      // head.messageCreatedAt still carries the true message time (§3.2b).
      const occurredAt = headDate(head.messageCreatedAt) ?? event.occurredAt;
      const result = await db.execute(sql`
        insert into ${target} (
          account_id, platform, conversation_ref, message_ref, native_message_id,
          fan_native_id, sender_role, is_sent_by_me, occurred_at, text_plain,
          text_html, price_mills, is_opened, is_new, is_tip, tip_amount_mills,
          tip_text_plain, in_reply_to_ref, reply_metadata, media_metadata,
          origin_class, material_observed_at, vendor_changed_at,
          source_event_id, source_account_seq, serving_contract_version
        ) values (
          ${input.accountId},
          ${input.platform},
          ${event.conversationRef},
          ${event.messageRef},
          ${nativeMessageBigint(head.nativeMessageId)},
          ${event.fanIdentityRef},
          ${head.isSentByMe ? "model" : "fan"},
          ${head.isSentByMe},
          ${occurredAt},
          ${normalizeDmMessageText(textHtml)},
          ${textHtml},
          ${headMills(head.priceMills)},
          ${isOpened},
          ${isNew},
          ${head.isTip === true},
          ${headMills(head.tipAmountMills) ?? 0n},
          ${typeof head.tipTextPlain === "string" ? head.tipTextPlain : null},
          ${observesReply && typeof reply?.messageId === "string" ? reply.messageId : null},
          ${!observesReply || reply === null ? null : JSON.stringify(reply)}::jsonb,
          ${JSON.stringify(media)}::jsonb,
          ${typeof head.originClass === "string" ? head.originClass : null},
          ${materialObservedAt},
          ${vendorChangedAt},
          ${event.id},
          ${event.accountSeq},
          1
        )
        on conflict (account_id, platform, message_ref) do update set
          conversation_ref = coalesce(excluded.conversation_ref, ${target}.conversation_ref),
          native_message_id = coalesce(excluded.native_message_id, ${target}.native_message_id),
          fan_native_id = coalesce(excluded.fan_native_id, ${target}.fan_native_id),
          sender_role = excluded.sender_role,
          is_sent_by_me = excluded.is_sent_by_me,
          occurred_at = excluded.occurred_at,
          text_plain = excluded.text_plain,
          text_html = excluded.text_html,
          price_mills = excluded.price_mills,
          is_opened = case
            when ${target}.is_opened is true or excluded.is_opened is true then true
            when ${target}.is_opened is false or excluded.is_opened is false then false
            else null
          end,
          is_new = excluded.is_new,
          is_tip = excluded.is_tip,
          tip_amount_mills = excluded.tip_amount_mills,
          tip_text_plain = case
            when ${observesTipText} then excluded.tip_text_plain
            else ${target}.tip_text_plain
          end,
          in_reply_to_ref = case
            when ${observesReply} then excluded.in_reply_to_ref
            else ${target}.in_reply_to_ref
          end,
          reply_metadata = case
            when ${observesReply} then excluded.reply_metadata
            else ${target}.reply_metadata
          end,
          media_metadata = case
            when ${observesMedia} then excluded.media_metadata
            else ${target}.media_metadata
          end,
          origin_class = excluded.origin_class,
          material_observed_at = excluded.material_observed_at,
          vendor_changed_at = excluded.vendor_changed_at,
          source_event_id = excluded.source_event_id,
          source_account_seq = excluded.source_account_seq,
          serving_contract_version = excluded.serving_contract_version,
          content_pending = false,
          updated_at = now()
        where ${target}.content_pending
           or ${target}.serving_contract_version < excluded.serving_contract_version
           or (
             excluded.vendor_changed_at is not null
             and (${target}.vendor_changed_at is null
               or excluded.vendor_changed_at >= ${target}.vendor_changed_at)
           )
           or (
             excluded.vendor_changed_at is null
             and ${target}.vendor_changed_at is null
             and (${target}.material_observed_at is null
               or excluded.material_observed_at >= ${target}.material_observed_at)
           )
        returning id
      `);
      if (head.replyContractVersion === 1 && fieldPresence?.reply === true) {
        await applyReplyMaterial(db, {
          accountId: input.accountId, platform: input.platform, messageRef: event.messageRef,
          targetTable: input.targetTable, reply, observedAt: materialObservedAt,
        });
      }
      inserted += result.rows.length;
    } else if (event.type === "message.received" || event.type === "message.sent") {
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
          insert into ${target} (
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
            ${normalizeDmMessageText(typeof head.text === "string" ? head.text : "")},
            ${headMills(head.priceMills)},
            ${head.isTip === true},
            ${headMills(head.tipAmountMills) ?? 0n},
            ${typeof head.inReplyToMessageId === "string" ? head.inReplyToMessageId : null},
            ${JSON.stringify(Array.isArray(head.media) ? head.media : [])}::jsonb,
            ${event.id}
          )
          on conflict (account_id, platform, message_ref) do update set
            conversation_ref = coalesce(excluded.conversation_ref, ${target}.conversation_ref),
            fan_native_id = coalesce(excluded.fan_native_id, ${target}.fan_native_id),
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
        insert into ${target} (
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
          ${normalizeDmMessageText(typeof text === "string" ? text : "")},
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
        where ${target}.content_pending
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
        insert into ${target} (
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
          where ${target}.deleted_at is null
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

// ── W10 (decision #134): shadow rebuild machinery ──────────────────────────
// The old rebuild above is lossy by construction (attached-partition replay +
// legacy-seed destruction); everything below serves the staged shadow flow:
// preflight census → lift + replay + backfill into message_archive_shadow →
// set-difference fidelity proof → one-transaction atomic switch.

/** Accounts holding archive rows — legacy seeds can exist for accounts with
 * no domain events, so the rebuild scope is this ∪ listEventAccounts. */
export async function listArchiveAccounts(db: Database): Promise<number[]> {
  const result = await db.execute<{ account_id: string }>(sql`
    select distinct account_id::text from message_archive order by 1
  `);
  return result.rows.map((row) => Number(row.account_id));
}

/** Restartable per-account shadow build: clear the account's shadow scope
 * (and its shadow watermark) so a re-run starts from a clean slate. */
export async function clearMessageArchiveShadowAccount(
  db: Database,
  accountId: number,
): Promise<void> {
  await db.execute(sql`delete from message_archive_shadow where account_id = ${accountId}`);
  await db.execute(sql`
    delete from projection_seq_watermarks
    where projection = ${MESSAGE_ARCHIVE_SHADOW_PROJECTION} and account_id = ${accountId}
  `);
}

/**
 * Legacy-seed LIFT: rows the event ledger cannot re-derive
 * (source_event_id IS NULL, backfill_source IN ('dm_message_archive',
 * 'hot_table')) are copied VERBATIM into the shadow — provenance
 * (backfill_source, archived_at, updated_at) preserved. For pruned hot
 * originals these rows are the ONLY copy; re-derivation is not an option.
 * Runs FIRST so the replay's first-real-writer-wins conflict arm cannot
 * overwrite them — reproducing exactly the precedence the old table has.
 */
export async function liftLegacySeedRowsToShadow(
  db: Database,
  input: { accountId: number },
): Promise<number> {
  const result = await db.execute(sql`
    insert into message_archive_shadow (
      account_id, platform, native_account_ref, conversation_ref, message_ref,
      fan_native_id, sender_role, is_sent_by_me, occurred_at, text_plain,
      price_mills, is_tip, tip_amount_mills, in_reply_to_ref, media_metadata,
      reply_metadata, material_observed_at, reply_parent_observed_at, reply_root_observed_at,
      content_pending, deleted_at, source_event_id, backfill_source,
      archived_at, updated_at
    )
    select
      account_id, platform, native_account_ref, conversation_ref, message_ref,
      fan_native_id, sender_role, is_sent_by_me, occurred_at, text_plain,
      price_mills, is_tip, tip_amount_mills, in_reply_to_ref, media_metadata,
      reply_metadata, material_observed_at, reply_parent_observed_at, reply_root_observed_at,
      content_pending, deleted_at, source_event_id, backfill_source,
      archived_at, updated_at
    from message_archive
    where account_id = ${input.accountId}
      and source_event_id is null
      and backfill_source in ('dm_message_archive', 'hot_table')
    on conflict (account_id, platform, message_ref) do nothing
    returning id
  `);
  return result.rows.length;
}

export interface ArchiveRebuildAccountCensus {
  accountId: number;
  totalRows: number;
  eventSourcedRows: number;
  legacySeedsBySource: Record<string, number>;
  /** Legacy seeds with NO surviving origin row in dm_message_archive OR the
   * hot table — the corrected query INCLUDES dm_message_archive as a source
   * (the audit's version omitted it). These rows exist ONLY here. */
  unrecoverableIfDropped: number;
}

export async function getArchiveRebuildAccountCensus(
  db: Database,
  accountId: number,
): Promise<ArchiveRebuildAccountCensus> {
  const totals = await db.execute<{ total: string; event_sourced: string }>(sql`
    select count(*)::text as total,
           count(*) filter (where a.source_event_id is not null)::text as event_sourced
    from message_archive a
    where a.account_id = ${accountId}
  `);
  const seeds = await db.execute<{ backfill_source: string; n: string }>(sql`
    select a.backfill_source, count(*)::text as n
    from message_archive a
    where a.account_id = ${accountId}
      and a.source_event_id is null
      and a.backfill_source in ('dm_message_archive', 'hot_table')
    group by a.backfill_source
    order by a.backfill_source
  `);
  const unrecoverable = await db.execute<{ n: string }>(sql`
    select count(*)::text as n
    from message_archive a
    where a.account_id = ${accountId}
      and a.source_event_id is null
      and a.backfill_source in ('dm_message_archive', 'hot_table')
      and not exists (
        select 1 from dm_message_archive d
        where d.platform_account_id = a.account_id
          and d.platform::text = a.platform
          and d.platform_message_id = a.message_ref
      )
      and not exists (
        select 1 from page_dm_messages m
        where m.platform_account_id = a.account_id
          and m.platform_message_id = a.message_ref
      )
  `);
  const legacySeedsBySource: Record<string, number> = {};
  for (const row of seeds.rows) {
    legacySeedsBySource[row.backfill_source] = Number(row.n);
  }
  return {
    accountId,
    totalRows: Number(totals.rows[0]?.total ?? 0),
    eventSourcedRows: Number(totals.rows[0]?.event_sourced ?? 0),
    legacySeedsBySource,
    unrecoverableIfDropped: Number(unrecoverable.rows[0]?.n ?? 0),
  };
}

export interface DetachedDomainEventPartition {
  schema: string;
  name: string;
  totalRows: number;
}

function quotedRelation(schema: string, name: string) {
  return sql.raw(`"${schema.replaceAll("\"", "\"\"")}"."${name.replaceAll("\"", "\"\"")}"`);
}

/**
 * Detached-partition census (pg_inherits vs the tiering bookkeeping): every
 * domain_events partition that listEventsSince can NOT see — parked in
 * tiered_pending_drop by Stage 28 tiering, or detached-in-public (the 0077
 * leftovers). The replay watermark advances past their seqs silently, which
 * is exactly why the shadow replay hard-refuses when one holds account rows.
 */
export async function listDomainEventPartitionCensus(db: Database): Promise<{
  attached: string[];
  detached: DetachedDomainEventPartition[];
}> {
  const attached = await db.execute<{ name: string }>(sql`
    select c.relname as name
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace n on n.oid = c.relnamespace
    where p.relname = 'domain_events' and n.nspname = 'public'
    order by c.relname
  `);
  const detachedRelations = await db.execute<{ schema: string; name: string }>(sql`
    select n.nspname as schema, c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and c.relname ~ '^domain_events_(pre_2024|[0-9]{4}(_[0-9]{2})?)$'
      and (
        n.nspname = 'tiered_pending_drop'
        or (
          n.nspname = 'public'
          and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
        )
      )
    order by n.nspname, c.relname
  `);
  const detached: DetachedDomainEventPartition[] = [];
  for (const relation of detachedRelations.rows) {
    const count = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from ${quotedRelation(relation.schema, relation.name)}
    `);
    detached.push({
      schema: relation.schema,
      name: relation.name,
      totalRows: Number(count.rows[0]?.n ?? 0),
    });
  }
  return { attached: attached.rows.map((row) => row.name), detached };
}

/** The HARD gate's question: which detached partitions hold events for THIS
 * account (their seqs are invisible to the replay). Nonzero = refuse. */
export async function listDetachedPartitionsHoldingAccount(
  db: Database,
  accountId: number,
): Promise<Array<{ schema: string; name: string; rows: number }>> {
  const census = await listDomainEventPartitionCensus(db);
  const holding: Array<{ schema: string; name: string; rows: number }> = [];
  for (const partition of census.detached) {
    if (partition.totalRows === 0) {
      continue;
    }
    const count = await db.execute<{ n: string }>(sql`
      select count(*)::text as n
      from ${quotedRelation(partition.schema, partition.name)}
      where account_id = ${accountId}
    `);
    const rows = Number(count.rows[0]?.n ?? 0);
    if (rows > 0) {
      holding.push({ schema: partition.schema, name: partition.name, rows });
    }
  }
  return holding;
}

// ── §3.2c(ii) WRITE-SIDE target-month census ────────────────────────────────
//
// The read-side gate above answers "can this rebuild see all of the account's
// events". This one answers the opposite question, and it is the one that was
// still live after two earlier passes: can this APPEND land at all?
//
// domain_events is monthly-partitioned by occurred_at. Two lanes are
// deliberately provider-dated — message.material_observed (the archive dates
// from the message's own createdAt) and post.observed (publishedAt) — and this
// initiative drains BOTH across history. An append whose occurred_at falls in
// a month with no ATTACHED partition fails ExecFindPartition (23514) per row,
// forever: the observation is never stamped, so every subsequent sweep retries
// it. The account-row preflight cannot see two of the three failure shapes —
// an EMPTY detached partition hides no rows, and an ABSENT partition involves
// no detachment at all (ensureDomainEventPartitions creates the current month
// + 3 and no historical month is ever auto-created).
//
// [S1] SCOPE, deliberately narrow: the check name-matches domain_events_YYYY_MM
// for 2026–2030 ONLY, and passes everything else through. No relpartbound
// parsing, because every other regime is covered by construction:
// domain_events_pre_2024 spans MINVALUE → 2024-01-01; _2024 and _2025 are
// YEARLY partitions migration 0077 named so tiering cannot re-detach them; the
// 0082 catch-all covers 2031+. Re-generalising this costs a bound parser with
// MINVALUE/MAXVALUE cases and buys nothing.

export const DOMAIN_EVENT_MONTHLY_REGIME_MIN_YEAR = 2026;
export const DOMAIN_EVENT_MONTHLY_REGIME_MAX_YEAR = 2030;

const DOMAIN_EVENT_MONTHLY_PARTITION_PATTERN = /^domain_events_(\d{4})_(\d{2})$/;

/** The monthly partition key an append at `target` would aim at, or null when
 *  the instant falls OUTSIDE the 2026–2030 monthly regime (covered by
 *  construction — see the block comment). */
export function domainEventTargetMonthKey(target: Date): string | null {
  const time = target.getTime();
  if (Number.isNaN(time)) {
    return null;
  }
  const year = target.getUTCFullYear();
  if (
    year < DOMAIN_EVENT_MONTHLY_REGIME_MIN_YEAR
    || year > DOMAIN_EVENT_MONTHLY_REGIME_MAX_YEAR
  ) {
    return null;
  }
  return `${year}_${String(target.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface DomainEventPartitionCoverage {
  /** Month keys (YYYY_MM) with an ATTACHED monthly partition. */
  attachedMonths: ReadonlySet<string>;
  /** Month keys whose partition exists but is DETACHED, with its relations. */
  detachedMonths: ReadonlyMap<string, string[]>;
}

/** One census read, reusable for a whole run: resolving it per draft would put
 *  a catalog query in front of every row the sweep touches. */
export async function loadDomainEventPartitionCoverage(
  db: Database,
): Promise<DomainEventPartitionCoverage> {
  const census = await listDomainEventPartitionCensus(db);
  const attachedMonths = new Set<string>();
  for (const name of census.attached) {
    const match = DOMAIN_EVENT_MONTHLY_PARTITION_PATTERN.exec(name);
    if (match) {
      attachedMonths.add(`${match[1]}_${match[2]}`);
    }
  }
  const detachedMonths = new Map<string, string[]>();
  for (const partition of census.detached) {
    const match = DOMAIN_EVENT_MONTHLY_PARTITION_PATTERN.exec(partition.name);
    if (!match) {
      continue;
    }
    const key = `${match[1]}_${match[2]}`;
    const relations = detachedMonths.get(key) ?? [];
    relations.push(`${partition.schema}.${partition.name}`);
    detachedMonths.set(key, relations);
  }
  return { attachedMonths, detachedMonths };
}

export interface BlockedDomainEventTargetMonth {
  /** YYYY_MM — the partition name suffix the append would need. */
  month: string;
  /** The operator's two recoveries differ; the mechanism's do not. */
  shape: "detached" | "absent";
  detachedRelations: string[];
  recovery: string;
}

const DETACHED_RECOVERY =
  "re-attach the month (the 0077 ritual — DETACH/ATTACH only, NEVER DROP: the "
  + "detached table holds the facts), or replay hot + lake for the range, then re-run";
const ABSENT_RECOVERY =
  "create the missing monthly partition (correct ONLY for the absent shape), then re-run";

export class DomainEventTargetMonthsUnattachedError extends Error {
  readonly blocked: readonly BlockedDomainEventTargetMonth[];

  constructor(blocked: readonly BlockedDomainEventTargetMonth[]) {
    super(
      `domain_events has no attached partition for target month(s): ${
        blocked.map((entry) => `${entry.month} (${entry.shape})`).join(", ")
      }`,
    );
    this.name = "DomainEventTargetMonthsUnattachedError";
    this.blocked = blocked;
  }
}

/**
 * REFUSES BEFORE ANY WRITE when a draft's target month has no attached
 * partition. Throws `DomainEventTargetMonthsUnattachedError`, which callers
 * count as `partitionBlocked` — a skipped step, distinct from an error, and
 * never a stamped observation (its parse debt must survive the recovery).
 */
export async function assertDomainEventTargetMonthsAttached(
  db: Database,
  targets: readonly Date[],
  options?: { coverage?: DomainEventPartitionCoverage },
): Promise<void> {
  const months = new Set<string>();
  for (const target of targets) {
    const key = domainEventTargetMonthKey(target);
    if (key !== null) {
      months.add(key);
    }
  }
  if (months.size === 0) {
    return;
  }
  const coverage = options?.coverage ?? await loadDomainEventPartitionCoverage(db);
  const blocked: BlockedDomainEventTargetMonth[] = [];
  for (const month of [...months].sort()) {
    if (coverage.attachedMonths.has(month)) {
      continue;
    }
    const detachedRelations = coverage.detachedMonths.get(month) ?? [];
    const shape = detachedRelations.length > 0 ? "detached" as const : "absent" as const;
    blocked.push({
      month,
      shape,
      detachedRelations,
      recovery: shape === "detached" ? DETACHED_RECOVERY : ABSENT_RECOVERY,
    });
  }
  if (blocked.length > 0) {
    throw new DomainEventTargetMonthsUnattachedError(blocked);
  }
}

const SHADOW_JOIN = sql`
  on s.account_id = o.account_id
  and s.platform = o.platform
  and s.message_ref = o.message_ref
`;

export interface ArchiveShadowVerifyCounts {
  oldRows: number;
  shadowRows: number;
  /** Rows in message_archive with NO shadow counterpart — nonzero FAILS. */
  missing: number;
  /** Shadow rows with no old counterpart (new coverage) — informational. */
  extra: number;
  compared: number;
  mismatches: {
    textPlain: number;
    occurredAt: number;
    priceMills: number;
    tipAmountMills: number;
    deletedAt: number;
    conversationRef: number;
    fanNativeId: number;
  };
}

/** R2 set-difference proof: shadow ⊇ old on (account_id, platform,
 * message_ref) plus per-column material mismatch counts. */
export async function getArchiveShadowVerifyCounts(
  db: Database,
  input?: { accountId?: number | null },
): Promise<ArchiveShadowVerifyCounts> {
  const oldFilter = input?.accountId != null ? sql`where o.account_id = ${input.accountId}` : sql``;
  const shadowScope = input?.accountId != null ? sql`where s.account_id = ${input.accountId}` : sql``;
  const sizes = await db.execute<{ old_rows: string; shadow_rows: string }>(sql`
    select
      (select count(*) from message_archive o ${oldFilter})::text as old_rows,
      (select count(*) from message_archive_shadow s ${shadowScope})::text as shadow_rows
  `);
  const missing = await db.execute<{ n: string }>(sql`
    select count(*)::text as n
    from message_archive o
    left join message_archive_shadow s ${SHADOW_JOIN}
    ${input?.accountId != null ? sql`where o.account_id = ${input.accountId} and s.id is null` : sql`where s.id is null`}
  `);
  const extra = await db.execute<{ n: string }>(sql`
    select count(*)::text as n
    from message_archive_shadow s
    left join message_archive o
      on o.account_id = s.account_id
      and o.platform = s.platform
      and o.message_ref = s.message_ref
    ${input?.accountId != null ? sql`where s.account_id = ${input.accountId} and o.id is null` : sql`where o.id is null`}
  `);
  const material = await db.execute<Record<string, string>>(sql`
    select
      count(*)::text as compared,
      count(*) filter (where o.text_plain is distinct from s.text_plain)::text as text_plain,
      count(*) filter (where o.occurred_at is distinct from s.occurred_at)::text as occurred_at,
      count(*) filter (where o.price_mills is distinct from s.price_mills)::text as price_mills,
      count(*) filter (where o.tip_amount_mills is distinct from s.tip_amount_mills)::text as tip_amount_mills,
      count(*) filter (where o.deleted_at is distinct from s.deleted_at)::text as deleted_at,
      count(*) filter (where o.conversation_ref is distinct from s.conversation_ref)::text as conversation_ref,
      count(*) filter (where o.fan_native_id is distinct from s.fan_native_id)::text as fan_native_id
    from message_archive o
    join message_archive_shadow s ${SHADOW_JOIN}
    ${oldFilter}
  `);
  const row = material.rows[0] ?? {};
  return {
    oldRows: Number(sizes.rows[0]?.old_rows ?? 0),
    shadowRows: Number(sizes.rows[0]?.shadow_rows ?? 0),
    missing: Number(missing.rows[0]?.n ?? 0),
    extra: Number(extra.rows[0]?.n ?? 0),
    compared: Number(row.compared ?? 0),
    mismatches: {
      textPlain: Number(row.text_plain ?? 0),
      occurredAt: Number(row.occurred_at ?? 0),
      priceMills: Number(row.price_mills ?? 0),
      tipAmountMills: Number(row.tip_amount_mills ?? 0),
      deletedAt: Number(row.deleted_at ?? 0),
      conversationRef: Number(row.conversation_ref ?? 0),
      fanNativeId: Number(row.fan_native_id ?? 0),
    },
  };
}

export interface ArchiveShadowMissingKey {
  accountId: number;
  platform: string;
  messageRef: string;
  backfillSource: string | null;
  sourceEventId: number | null;
}

/** Bounded sample of the FAILING set (old rows the shadow lacks). */
export async function listArchiveShadowMissingSample(
  db: Database,
  input: { accountId?: number | null; limit: number },
): Promise<ArchiveShadowMissingKey[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select o.account_id, o.platform, o.message_ref, o.backfill_source,
           o.source_event_id::text as source_event_id
    from message_archive o
    left join message_archive_shadow s ${SHADOW_JOIN}
    ${input.accountId != null ? sql`where o.account_id = ${input.accountId} and s.id is null` : sql`where s.id is null`}
    order by o.account_id, o.message_ref
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    accountId: Number(row.account_id),
    platform: String(row.platform),
    messageRef: String(row.message_ref),
    backfillSource: (row.backfill_source as string | null) ?? null,
    sourceEventId: row.source_event_id == null ? null : Number(row.source_event_id),
  }));
}

export interface ArchiveShadowDiffRow {
  accountId: number;
  platform: string;
  messageRef: string;
  old: {
    textPlain: string;
    occurredAt: Date | null;
    priceMills: string | null;
    tipAmountMills: string;
    deletedAt: Date | null;
    conversationRef: string | null;
    fanNativeId: string | null;
  };
  shadow: {
    textPlain: string;
    occurredAt: Date | null;
    priceMills: string | null;
    tipAmountMills: string;
    deletedAt: Date | null;
    conversationRef: string | null;
    fanNativeId: string | null;
  };
}

/** Bounded material-diff sample across the compared columns. */
export async function listArchiveShadowDiffSample(
  db: Database,
  input: { accountId?: number | null; limit: number },
): Promise<ArchiveShadowDiffRow[]> {
  const accountFilter = input.accountId != null
    ? sql`and o.account_id = ${input.accountId}`
    : sql``;
  const result = await db.execute<Record<string, unknown>>(sql`
    select o.account_id, o.platform, o.message_ref,
           o.text_plain as old_text_plain, s.text_plain as shadow_text_plain,
           o.occurred_at as old_occurred_at, s.occurred_at as shadow_occurred_at,
           o.price_mills::text as old_price_mills, s.price_mills::text as shadow_price_mills,
           o.tip_amount_mills::text as old_tip_mills, s.tip_amount_mills::text as shadow_tip_mills,
           o.deleted_at as old_deleted_at, s.deleted_at as shadow_deleted_at,
           o.conversation_ref as old_conversation_ref, s.conversation_ref as shadow_conversation_ref,
           o.fan_native_id as old_fan_native_id, s.fan_native_id as shadow_fan_native_id
    from message_archive o
    join message_archive_shadow s ${SHADOW_JOIN}
    where (
      o.text_plain is distinct from s.text_plain
      or o.occurred_at is distinct from s.occurred_at
      or o.price_mills is distinct from s.price_mills
      or o.tip_amount_mills is distinct from s.tip_amount_mills
      or o.deleted_at is distinct from s.deleted_at
      or o.conversation_ref is distinct from s.conversation_ref
      or o.fan_native_id is distinct from s.fan_native_id
    ) ${accountFilter}
    order by o.account_id, o.message_ref
    limit ${input.limit}
  `);
  const toDate = (value: unknown) => (value == null ? null : new Date(value as string | Date));
  return result.rows.map((row) => ({
    accountId: Number(row.account_id),
    platform: String(row.platform),
    messageRef: String(row.message_ref),
    old: {
      textPlain: String(row.old_text_plain ?? ""),
      occurredAt: toDate(row.old_occurred_at),
      priceMills: (row.old_price_mills as string | null) ?? null,
      tipAmountMills: String(row.old_tip_mills ?? "0"),
      deletedAt: toDate(row.old_deleted_at),
      conversationRef: (row.old_conversation_ref as string | null) ?? null,
      fanNativeId: (row.old_fan_native_id as string | null) ?? null,
    },
    shadow: {
      textPlain: String(row.shadow_text_plain ?? ""),
      occurredAt: toDate(row.shadow_occurred_at),
      priceMills: (row.shadow_price_mills as string | null) ?? null,
      tipAmountMills: String(row.shadow_tip_mills ?? "0"),
      deletedAt: toDate(row.shadow_deleted_at),
      conversationRef: (row.shadow_conversation_ref as string | null) ?? null,
      fanNativeId: (row.shadow_fan_native_id as string | null) ?? null,
    },
  }));
}

export interface ArchiveShadowSwitchResult {
  retiredTable: string;
  liveRows: number;
  retiredRows: number;
  watermarksReset: number;
  /** The archive generation AFTER this swap; every older read cursor is now invalid. */
  archiveGeneration: number;
}

/**
 * R3 — the atomic switch, ONE transaction: rename message_archive →
 * message_archive_retired_<ts> (KEPT — capture-first; its drop is a separate
 * owner decision), message_archive_shadow → message_archive, rename
 * indexes/constraints/sequences so canonical names follow the live table,
 * and force-reset the projection watermark to the shadow's replay high-seq
 * (the guarded upsert would keep a HIGHER stale watermark and silently skip
 * events — so the swap deletes + reinserts). Refuses inside the transaction
 * when the set-difference proof shows missing rows. Serialized against the
 * shadow builder by the same advisory lock. The archive sweep worker must be
 * PAUSED for the window — docs/runbooks/message-archive-rebuild.md.
 */
export async function switchMessageArchiveShadowTables(
  db: Database,
  input?: { now?: Date },
): Promise<ArchiveShadowSwitchResult> {
  const now = input?.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const retired = `message_archive_retired_${stamp}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${MESSAGE_ARCHIVE_REBUILD_LOCK_KEY})`);

    const missing = await tx.execute<{ n: string }>(sql`
      select count(*)::text as n
      from message_archive o
      left join message_archive_shadow s ${SHADOW_JOIN}
      where s.id is null
    `);
    const missingRows = Number(missing.rows[0]?.n ?? 0);
    if (missingRows > 0) {
      throw new Error(
        `archive shadow switch REFUSED: ${missingRows} message_archive row(s) have no shadow `
          + "counterpart — the switch would lose them. Re-run the shadow build "
          + "(projection:rebuild message_archive), then archive:rebuild-verify.",
      );
    }

    const counts = await tx.execute<{ old_rows: string; shadow_rows: string }>(sql`
      select
        (select count(*) from message_archive)::text as old_rows,
        (select count(*) from message_archive_shadow)::text as shadow_rows
    `);

    // Old table out of the way first — its canonical index/constraint names
    // must be freed before the shadow's are renamed onto them.
    await tx.execute(sql.raw(`alter table message_archive rename to "${retired}"`));
    const oldIndexes = await tx.execute<{ index_name: string; constraint_name: string | null }>(sql`
      select c.relname as index_name, con.conname as constraint_name
      from pg_index x
      join pg_class c on c.oid = x.indexrelid
      left join pg_constraint con on con.conindid = x.indexrelid
      where x.indrelid = ${retired}::regclass
      order by c.relname
    `);
    let ordinal = 0;
    for (const index of oldIndexes.rows) {
      ordinal += 1;
      if (index.constraint_name !== null) {
        await tx.execute(sql.raw(
          `alter table "${retired}" rename constraint "${index.constraint_name}" to "${retired}_c${ordinal}"`,
        ));
      } else {
        await tx.execute(sql.raw(
          `alter index "${index.index_name}" rename to "${retired}_i${ordinal}"`,
        ));
      }
    }
    const oldSequence = await tx.execute<{ seq: string | null }>(sql`
      select pg_get_serial_sequence(${retired}, 'id') as seq
    `);
    if (oldSequence.rows[0]?.seq) {
      await tx.execute(sql.raw(
        `alter sequence ${oldSequence.rows[0].seq} rename to "${retired}_id_seq"`,
      ));
    }

    // Shadow takes the canonical name + the canonical index/constraint names.
    await tx.execute(sql`alter table message_archive_shadow rename to message_archive`);
    await tx.execute(sql`
      alter table message_archive
        rename constraint message_archive_shadow_pkey to message_archive_pkey
    `);
    await tx.execute(sql`
      alter table message_archive
        rename constraint message_archive_shadow_account_platform_message_ref_key
        to message_archive_account_id_platform_message_ref_key
    `);
    await tx.execute(sql`
      alter table message_archive
        rename constraint message_archive_shadow_account_id_fkey
        to message_archive_account_id_fkey
    `);
    await tx.execute(sql`
      alter index message_archive_shadow_account_conv_idx rename to message_archive_account_conv_idx
    `);
    await tx.execute(sql`
      alter index message_archive_shadow_account_occurred_idx rename to message_archive_account_occurred_idx
    `);
    await tx.execute(sql`
      alter index message_archive_shadow_text_search_idx rename to message_archive_text_search_idx
    `);
    await tx.execute(sql`
      alter index message_archive_shadow_ofapi_native_order_idx
        rename to message_archive_ofapi_native_order_idx
    `);
    const newSequence = await tx.execute<{ seq: string | null }>(sql`
      select pg_get_serial_sequence('message_archive', 'id') as seq
    `);
    if (newSequence.rows[0]?.seq) {
      await tx.execute(sql.raw(
        `alter sequence ${newSequence.rows[0].seq} rename to "message_archive_id_seq"`,
      ));
    }

    // Watermark force-reset: the live projection resumes exactly where the
    // shadow's replay stopped.
    await tx.execute(sql`
      delete from projection_seq_watermarks where projection = ${MESSAGE_ARCHIVE_PROJECTION}
    `);
    const carried = await tx.execute(sql`
      insert into projection_seq_watermarks (projection, account_id, high_seq, updated_at)
      select ${MESSAGE_ARCHIVE_PROJECTION}, account_id, high_seq, now()
      from projection_seq_watermarks
      where projection = ${MESSAGE_ARCHIVE_SHADOW_PROJECTION}
      returning account_id
    `);
    await tx.execute(sql`
      delete from projection_seq_watermarks where projection = ${MESSAGE_ARCHIVE_SHADOW_PROJECTION}
    `);

    // Agent Read Plane: a read cursor carries the archive generation it was
    // minted under. The live table has just been replaced by a different physical
    // table, so resuming an older cursor could skip rows while still reporting
    // "the snapshot is exhausted" — a false "I read everything". Bumping inside
    // the same transaction means no reader can observe the swap without the bump.
    // A MANUAL reverse rename must bump it too — docs/runbooks/message-archive-rebuild.md.
    const generation = await tx.execute<{ generation: string }>(sql`
      insert into archive_generation (id, generation, bumped_at, reason)
      values (1, 1, now(), 'message_archive rebuild swap')
      on conflict (id) do update set
        generation = archive_generation.generation + 1,
        bumped_at = now(),
        reason = excluded.reason
      returning generation::text as generation
    `);

    return {
      retiredTable: retired,
      liveRows: Number(counts.rows[0]?.shadow_rows ?? 0),
      retiredRows: Number(counts.rows[0]?.old_rows ?? 0),
      watermarksReset: carried.rows.length,
      archiveGeneration: Number(generation.rows[0]?.generation ?? 0),
    };
  });
}

/**
 * Backfill source 1: the frozen OFAPI-only dm_message_archive. Direct column
 * copy, idempotent, batched by id checkpoint. Returns rows copied + the new
 * checkpoint (null when exhausted). W10: `targetTable` routes the same copy
 * into the shadow table, `accountId` scopes a per-account shadow build.
 */
export async function backfillArchiveFromDmMessageArchive(
  db: Database,
  input: {
    afterId?: number | null;
    batchSize?: number;
    accountId?: number | null;
    targetTable?: ArchiveTargetTable;
  },
): Promise<{ lastId: number | null }> {
  const target = archiveTable(input.targetTable);
  const batchSize = input.batchSize ?? 10_000;
  const afterId = input.afterId ?? 0;
  const accountFilter = input.accountId != null
    ? sql`and platform_account_id = ${input.accountId}`
    : sql``;
  const result = await db.execute<{ id: string }>(sql`
    with batch as (
      select * from dm_message_archive
      where id > ${afterId} ${accountFilter}
      order by id
      limit ${batchSize}
    ), copied as (
      insert into ${target} (
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
        deleted_at = coalesce(${target}.deleted_at, excluded.deleted_at),
        backfill_source = excluded.backfill_source,
        content_pending = false,
        updated_at = now()
      where ${target}.content_pending
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
 * arithmetic form outside backfill SQL). W10: `targetTable` routes the same
 * copy into the shadow table, `accountId` scopes a per-account shadow build.
 */
export async function backfillArchiveFromHotTable(
  db: Database,
  input: {
    afterId?: number | null;
    batchSize?: number;
    accountId?: number | null;
    targetTable?: ArchiveTargetTable;
  },
): Promise<{ lastId: number | null }> {
  const target = archiveTable(input.targetTable);
  const batchSize = input.batchSize ?? 10_000;
  const afterId = input.afterId ?? 0;
  const accountFilter = input.accountId != null
    ? sql`and m.platform_account_id = ${input.accountId}`
    : sql``;
  const result = await db.execute<{ id: string }>(sql`
    with batch as (
      select m.*, t.platform_conversation_id, t.partner_platform_user_id, p.platform as page_platform
      from page_dm_messages m
      join page_dm_threads t on t.id = m.conversation_id
      join pages p on p.id = m.platform_account_id
      where m.id > ${afterId} ${accountFilter}
      order by m.id
      limit ${batchSize}
    ), copied as (
      insert into ${target} (
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
        deleted_at = coalesce(${target}.deleted_at, excluded.deleted_at),
        backfill_source = excluded.backfill_source,
        content_pending = false,
        updated_at = now()
      where ${target}.content_pending
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
 * messages — 0 means pruning is safe. W10: `targetTable` lets the rebuild
 * verify run the same coverage proof against the shadow table.
 */
export async function countArchiveCoverageGaps(
  db: Database,
  targetTable?: ArchiveTargetTable,
): Promise<number> {
  const result = await db.execute<{ gaps: string }>(sql`
    select count(*)::text as gaps from (
      select m.conversation_id
      from page_dm_messages m
      join pages p on p.id = m.platform_account_id
      left join ${archiveTable(targetTable)} a
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
  // The query is a user's literal search string, not a pattern: `%`, `_` and `\`
  // are escaped (the `escapeLikePattern` precedent) so that searching for "100%"
  // finds the text "100%" instead of matching every message in the archive.
  const conditions = [
    sql`ma.text_plain ilike ${`%${escapeLikePattern(input.query)}%`} escape '\\'`,
  ];
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
  /** First time hydration failed to find this account on the platform
   * (`fans.deleted_detected_at`); null = the fan is alive. Cleared server side
   * as soon as any sync sees a name again (see the fans upsert). Deleted fans
   * are NOT filtered out of the ranking: they still spent the money, and
   * dropping them would stop the board's totals from adding up. */
  deletedAt: Date | null;
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
      s.observed_at as "observedAt",
      f.deleted_detected_at as "deletedAt"
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
    deletedAt: row.deletedAt == null ? null : new Date(String(row.deletedAt)),
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
