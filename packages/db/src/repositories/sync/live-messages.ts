// Fansly Sync Engine, step 1 "Оверлей" (plan §7.1–7.3, §7.7, §15 step 1).
//
// A captured socket frame (observation + pending decode receipt, committed by
// the B0 receiver) is applied here in ONE transaction: the overlay rows of
// `dm_live_messages`, one deliverable `message.live_observed` domain event per
// newly visible message (NOTIFY `domain_events_appended` fires at commit, so
// SSE v2 delivers it), and the receipt's ack (`live_state`). The ack never
// commits without the overlay and the event, and neither commits without the
// ack. One function drives every path — right after capture, at start and on
// the worker timer — and it is idempotent per receipt (only `pending` receipts
// are taken, `for update skip locked`) and per message (the overlay keys on
// the Fansly message id; the event dedups on `ws-msg:v1:<id>`). A transient
// failure leaves the receipt pending for the next path; a frame the database
// refuses the same way on every retry (a data error) is acked as debt, so no
// receipt stays pending forever.
//
// Step 1 boundaries: apply creates no work and makes no HTTP request; it
// writes no legacy store and no money (plan §7.3, owner decision №7). The
// event is NOT a `message_archive` projection input (MESSAGE_EVENT_TYPES does
// not list it), so the archive stays REST-confirmed only. A deletion is a
// sticky mark on the overlay row in the same transaction; nothing clears it.

import { sql } from "drizzle-orm";
import {
  decodeFanslyWsCapture,
  decodeFanslyWsLiveFrame,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY,
  FANSLY_WS_CAPTURE_KIND,
  FANSLY_WS_LIVE_DECODER_VERSION,
  FANSLY_WS_LIVE_FIELD,
  normalizeDmMessageText,
  wsObject,
  type FanslyWsLiveMessage,
} from "@agency_hub_core/shared";

import type { Database } from "../../client.ts";
import { capturePayloadRefFromColumns, type CapturePayloadRef } from "../capture-payloads.ts";
import { appendDomainEventsInTransaction, type DomainEventInput } from "../domain-events.ts";
import { isDmArchiveScopeFenced, tryAcquireDmArchiveWriterFenceLock } from "../erasure-fence.ts";

/** Deliverable (SSE v2), never projection-only, never an archive input. */
export const FANSLY_WS_LIVE_OBSERVED_EVENT = "message.live_observed";
export const FANSLY_WS_LIVE_EVENT_SCHEMA_VERSION = 1;

export type FanslyWsLiveState = "applied" | "debt" | "skipped";

export interface FanslyWsLiveApplyCounts {
  /** Messages this apply made visible (not a repeat, not already deleted). */
  created: number;
  /** Deletion marks this apply set (sticky; a repeated mark counts once). */
  deleted: number;
  /** Message items skipped because an executed erasure covers them. */
  fenced: number;
  /** Message items without a required field, past the decoder bound, or (on
   * a `dataError`) in a frame the database refused. */
  invalid: number;
  /** `message.live_observed` events appended (dedup hits excluded). */
  events: number;
}

export type FanslyWsLiveApplyResult =
  | ({ status: FanslyWsLiveState } & FanslyWsLiveApplyCounts)
  /** The database refused the frame's writes with an error every retry would
   * hit (`dataError` is its SQLSTATE): they are rolled back and the receipt is
   * acked as debt, so it never stays pending and never wedges the replay. */
  | ({ status: "debt"; dataError: string } & FanslyWsLiveApplyCounts)
  /** Already acked, or another applier holds the receipt right now. */
  | { status: "not_pending" }
  /** An erasure holds this page's fence; the receipt stays pending. */
  | { status: "erasure_busy" };

export interface FanslyWsLivePayloadSource {
  payload: unknown;
  payloadRef: CapturePayloadRef | null;
}

/** Reads a receipt's raw observation body through the caller's payload seam,
 * on the apply transaction. Returns null when the body is permanently gone
 * (the receipt becomes debt); throws on a transient failure, which rolls the
 * attempt back and leaves the receipt pending. */
export type FanslyWsLivePayloadResolver = (
  db: Database,
  observationId: number,
  source: FanslyWsLivePayloadSource,
) => Promise<unknown>;

/** Lock waits (the account's event counter, an overlay row) end the attempt
 * instead of holding a pool connection; the receipt stays pending. */
const APPLY_STATEMENT_TIMEOUT = "5s";

/** Parity's first look, 30 s after the row became visible; REST polling is
 * minutes, so most rows are confirmed on a later look. */
const CONFIRM_FIRST_CHECK = "30 seconds";

type LiveOperation =
  | { kind: "create"; messageId: string; message: FanslyWsLiveMessage }
  | { kind: "delete"; messageId: string; groupId: string | null };

function emptyCounts(): FanslyWsLiveApplyCounts {
  return { created: 0, deleted: 0, fenced: 0, invalid: 0, events: 0 };
}

/** The SQLSTATE of an error the same frame would hit on every retry: a data
 * exception (class 22: an escape jsonb refuses, a NUL in text, a value past a
 * column's range) or a check violation. Anything else (a statement timeout,
 * a lock, a lost connection, an injected failure) is transient: null. The
 * driver error sits under the query wrapper's `cause`. */
function deterministicDataError(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      return code.startsWith("22") || code === "23514" ? code : null;
    }
    current = current.cause;
  }
  return null;
}

/**
 * Apply one captured frame to the live overlay. See the module header for the
 * contract. `resolvePayload` is the runtime payload seam; without it only an
 * inline body is read.
 */
export async function applyFanslyWsLiveReceipt(
  db: Database,
  input: { observationId: number; resolvePayload?: FanslyWsLivePayloadResolver },
): Promise<FanslyWsLiveApplyResult> {
  return db.transaction(async (tx): Promise<FanslyWsLiveApplyResult> => {
    const database = tx as unknown as Database;
    await database.execute(sql`select set_config('statement_timeout', ${APPLY_STATEMENT_TIMEOUT}, true)`);
    const locked = await database.execute<{
      page_id: string;
      received_at: Date | string;
      found: boolean;
      native_account_ref: string | null;
      payload: unknown;
      bucket: string | null;
      object_id: string | null;
    }>(sql`
      select r.page_id::text as page_id, r.received_at, o.id is not null as found,
        o.native_account_ref, o.payload, to_char(o.payload_bucket_month, 'YYYY-MM-DD') as bucket,
        o.payload_object_id::text as object_id
      from fansly_ws_decode_receipts r
      left join observations o on o.id = r.observation_id and o.received_at = r.received_at
      where r.observation_id = ${input.observationId} and r.live_state = 'pending'
      for update of r skip locked
    `);
    const row = locked.rows[0];
    if (!row) return { status: "not_pending" };
    const pageId = Number(row.page_id);
    const receivedAt = new Date(row.received_at);
    // Same shared fence every DM archive writer takes: an erasure in flight
    // defers this apply (receipt stays pending) instead of racing its delete.
    if (!await tryAcquireDmArchiveWriterFenceLock(database, pageId)) return { status: "erasure_busy" };

    let frame: string | null = null;
    if (row.found) {
      const source = { payload: row.payload, payloadRef: capturePayloadRefFromColumns(row.bucket, row.object_id) };
      const payload = input.resolvePayload
        ? await input.resolvePayload(database, input.observationId, source)
        : source.payload;
      const envelope = wsObject(payload);
      frame = envelope?.codec === FANSLY_WS_CAPTURE_KIND && typeof envelope.frame === "string" ? envelope.frame : null;
    }
    if (frame === null) {
      // Tiered, erased or otherwise unreachable raw: nothing to apply ever.
      await ackReceipt(database, input.observationId, "debt", null);
      return { status: "debt", ...emptyCounts() };
    }

    const live = decodeFanslyWsLiveFrame(frame);
    let invalid = 0;
    const operations: LiveOperation[] = [];
    for (const item of live.items) {
      if (item.kind === "invalid" || item.kind === "limit") invalid += 1;
      else if (item.kind === "message_created") {
        operations.push({ kind: "create", messageId: item.message.id, message: item.message });
      } else if (item.kind === "message_deleted") {
        operations.push({ kind: "delete", messageId: item.messageId, groupId: item.groupId });
      }
    }
    // One lock order for every applier: by message id, then a deletion before
    // a create of the same message (a message deleted in the very frame that
    // creates it was never visible, so it is no news). Two batch frames naming
    // the same messages in different orders cannot deadlock.
    operations.sort((a, b) => a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1
      : a.kind === b.kind ? 0 : a.kind === "delete" ? -1 : 1);
    const nodes = decodeFanslyWsCapture(frame);

    try {
      // The frame's writes and its ack run in a savepoint (`tx` is already a
      // transaction), so a refusal that every retry would hit rolls back only
      // them: the receipt, still locked, is then acked as debt below instead
      // of staying pending forever and holding the replay's head.
      return await tx.transaction((savepoint) => applyOperations(savepoint as unknown as Database, {
        observationId: input.observationId, pageId, receivedAt, ownRef: row.native_account_ref,
        decoderVersion: live.decoderVersion, operations, invalid, nodes,
      }));
    } catch (error) {
      const dataError = deterministicDataError(error);
      if (dataError === null) throw error;
      // No overlay row and no event of this frame survive; the ack does.
      await ackReceipt(database, input.observationId, "debt", nodes);
      return { status: "debt", ...emptyCounts(), invalid: invalid + operations.length, dataError };
    }
  });
}

/** The frame's overlay rows, events and ack (the savepoint body above). */
async function applyOperations(database: Database, input: {
  observationId: number;
  pageId: number;
  receivedAt: Date;
  ownRef: string | null;
  decoderVersion: number;
  operations: readonly LiveOperation[];
  invalid: number;
  nodes: ReturnType<typeof decodeFanslyWsCapture>;
}): Promise<FanslyWsLiveApplyResult> {
  const { pageId, receivedAt } = input;
  const counts = { ...emptyCounts(), invalid: input.invalid };
  const events: DomainEventInput[] = [];
  let applicable = 0;
  for (const operation of input.operations) {
    if (operation.kind === "create") {
      const message = operation.message;
      const createdAt = new Date(message.createdAtMs);
      if (await isDmArchiveScopeFenced(database, {
        pageId, platform: "fansly", refs: [message.groupId, message.senderId],
        materialAt: createdAt < receivedAt ? createdAt : receivedAt,
      })) {
        counts.fenced += 1;
        continue;
      }
      applicable += 1;
      const sentByPage = input.ownRef ? message.senderId === input.ownRef : null;
      const visible = await upsertCreated(database, {
        pageId, observationId: input.observationId, receivedAt, message, sentByPage,
      });
      // Nothing new (a repeated frame), or a stub filled under a deletion
      // that already arrived: neither is news for SSE.
      if (!visible || visible.deleted) continue;
      counts.created += 1;
      events.push({
        type: FANSLY_WS_LIVE_OBSERVED_EVENT,
        occurredAt: receivedAt,
        fanIdentityRef: sentByPage === true ? null : message.senderId,
        conversationRef: message.groupId,
        messageRef: message.id,
        data: {
          text: message.content,
          senderRef: message.senderId,
          sentByPage,
          createdAt: createdAt.toISOString(),
          inReplyToRef: message.inReplyTo,
          inReplyToRootRef: message.inReplyToRoot,
          attachments: message.attachments.map((attachment) => ({
            contentType: attachment.contentType,
            contentRef: attachment.contentId,
          })),
          messageType: message.type,
          decoderVersion: input.decoderVersion,
          confirmed: false,
        },
        schemaVersion: FANSLY_WS_LIVE_EVENT_SCHEMA_VERSION,
        observationId: input.observationId,
        dedupKey: `ws-msg:v1:${message.id}`,
      });
    } else {
      if (await isDmArchiveScopeFenced(database, {
        pageId, platform: "fansly", refs: [operation.groupId], materialAt: receivedAt,
      })) {
        counts.fenced += 1;
        continue;
      }
      applicable += 1;
      if (await markDeleted(database, {
        pageId, observationId: input.observationId, receivedAt,
        messageId: operation.messageId, groupId: operation.groupId,
      })) counts.deleted += 1;
    }
  }
  if (events.length > 0) {
    counts.events = (await appendDomainEventsInTransaction(database, pageId, events)).appended;
  }
  const state: FanslyWsLiveState = counts.invalid > 0 ? "debt" : applicable > 0 ? "applied" : "skipped";
  await ackReceipt(database, input.observationId, state, input.nodes);
  return { status: state, ...counts };
}

/** Insert a visible message, or fill a deletion stub (no sender yet). A row
 * that already carries a create is never overwritten, and `deleted_at` is
 * never in the SET list. Returns null when nothing became visible. */
async function upsertCreated(database: Database, input: {
  pageId: number;
  observationId: number;
  receivedAt: Date;
  message: FanslyWsLiveMessage;
  sentByPage: boolean | null;
}): Promise<{ deleted: boolean } | null> {
  const message = input.message;
  const result = await database.execute<{ deleted: boolean }>(sql`
    insert into dm_live_messages as m (
      page_id, platform_message_id, platform_conversation_id, sender_platform_user_id, is_sent_by_page,
      created_at, content, in_reply_to_message_id, in_reply_to_root_message_id, attachments, message_type,
      correlation_id, field_mask, decoder_version, source_observation_id, source_received_at,
      first_visible_at, confirm_due_at, updated_at
    ) values (
      ${input.pageId}, ${message.id}, ${message.groupId}, ${message.senderId}, ${input.sentByPage},
      ${new Date(message.createdAtMs)}, ${message.content}, ${message.inReplyTo}, ${message.inReplyToRoot},
      ${JSON.stringify(message.attachments)}::jsonb, ${message.type}, ${message.correlationId},
      ${message.fieldMask}, ${FANSLY_WS_LIVE_DECODER_VERSION}, ${input.observationId}, ${input.receivedAt},
      clock_timestamp(), clock_timestamp() + ${CONFIRM_FIRST_CHECK}::interval, clock_timestamp()
    )
    on conflict (page_id, platform_message_id) do update set
      platform_conversation_id = coalesce(m.platform_conversation_id, excluded.platform_conversation_id),
      sender_platform_user_id = excluded.sender_platform_user_id,
      is_sent_by_page = excluded.is_sent_by_page,
      created_at = excluded.created_at,
      content = excluded.content,
      in_reply_to_message_id = excluded.in_reply_to_message_id,
      in_reply_to_root_message_id = excluded.in_reply_to_root_message_id,
      attachments = excluded.attachments,
      message_type = excluded.message_type,
      correlation_id = excluded.correlation_id,
      field_mask = excluded.field_mask,
      decoder_version = excluded.decoder_version,
      source_observation_id = excluded.source_observation_id,
      source_received_at = excluded.source_received_at,
      first_visible_at = excluded.first_visible_at,
      confirm_due_at = excluded.confirm_due_at,
      updated_at = excluded.updated_at
    where m.sender_platform_user_id is null
    returning m.deleted_at is not null as deleted
  `);
  const row = result.rows[0];
  return row ? { deleted: row.deleted === true } : null;
}

/** Sticky deletion: a stub when the create has not been seen yet, otherwise a
 * mark on the existing row. A later create fills the stub and keeps the mark.
 * Returns true when this call set the mark. */
async function markDeleted(database: Database, input: {
  pageId: number;
  observationId: number;
  receivedAt: Date;
  messageId: string;
  groupId: string | null;
}): Promise<boolean> {
  const result = await database.execute(sql`
    insert into dm_live_messages as m (
      page_id, platform_message_id, platform_conversation_id, decoder_version,
      deleted_at, delete_observation_id, updated_at
    ) values (
      ${input.pageId}, ${input.messageId}, ${input.groupId}, ${FANSLY_WS_LIVE_DECODER_VERSION},
      ${input.receivedAt}, ${input.observationId}, clock_timestamp()
    )
    on conflict (page_id, platform_message_id) do update set
      deleted_at = excluded.deleted_at,
      delete_observation_id = excluded.delete_observation_id,
      platform_conversation_id = coalesce(m.platform_conversation_id, excluded.platform_conversation_id),
      updated_at = excluded.updated_at
    where m.deleted_at is null
    returning 1
  `);
  return result.rows.length > 0;
}

/** The ack, in the apply transaction. The legacy metadata receipt is settled
 * here too (only while still pending), so no second writer touches the row. */
async function ackReceipt(
  database: Database,
  observationId: number,
  state: FanslyWsLiveState,
  nodes: ReturnType<typeof decodeFanslyWsCapture> | null,
) {
  const metadataState = nodes === null ? null : nodes.some((node) => node.state !== "retained") ? "debt" : "retained";
  await database.execute(sql`
    update fansly_ws_decode_receipts set
      live_state = ${state},
      live_decoder_version = ${FANSLY_WS_LIVE_DECODER_VERSION},
      live_applied_at = clock_timestamp(),
      nodes = case when state = 'pending' and ${metadataState}::text is not null
        then ${nodes === null ? null : JSON.stringify(nodes)}::jsonb else nodes end,
      decoded_at = case when state = 'pending' and ${metadataState}::text is not null
        then clock_timestamp() else decoded_at end,
      state = case when state = 'pending' and ${metadataState}::text is not null
        then ${metadataState}::text else state end
    where observation_id = ${observationId} and live_state = 'pending'
  `);
}

/** Pending live receipts, oldest first: the start-up and timer replay input.
 * `afterObservationId` continues a walk past the previous batch, so receipts
 * that keep failing never hide the ones behind them. `receivedBefore` keeps
 * the timer from racing a frame the live applier is about to take; the
 * receipt lock settles any race anyway. */
export async function listPendingFanslyWsLiveReceipts(
  db: Database,
  input: { limit: number; pageId?: number; afterObservationId?: number; receivedBefore?: Date },
): Promise<number[]> {
  const result = await db.execute<{ observation_id: string }>(sql`
    select observation_id::text as observation_id
    from fansly_ws_decode_receipts
    where live_state = 'pending'
      ${input.pageId === undefined ? sql`` : sql`and page_id = ${input.pageId}`}
      ${input.afterObservationId === undefined ? sql`` : sql`and observation_id > ${input.afterObservationId}`}
      ${input.receivedBefore === undefined ? sql`` : sql`and received_at <= ${input.receivedBefore}`}
    order by observation_id
    limit ${input.limit}
  `);
  return result.rows.map((row) => Number(row.observation_id));
}

// ---------------------------------------------------------------------------
// Passive parity (plan §15 step 1): no HTTP, no work. Each visible overlay row
// is compared with the legacy engine's REST copy once it appears —
// page_dm_messages first (raw content, exact sender id), else message_archive
// — field by field. Without a copy inside the window it is `not_found`, or
// `excluded` when its chat is excluded from message sync (reported apart).

/** Socket createdAt is fractional seconds; REST normalizes to whole seconds. */
const CONFIRM_TIME_TOLERANCE_MS = 1_000;
export const DM_LIVE_CONFIRM_WINDOW_MS = 24 * 60 * 60_000;

export type DmLiveConfirmOutcome = "match" | "mismatch" | "not_found" | "excluded";
export type DmLiveMismatchField = "text" | "sender" | "time" | "group" | "reply";

export interface DmLiveConfirmCounts {
  checked: number;
  match: number;
  mismatch: number;
  notFound: number;
  excluded: number;
  rescheduled: number;
}

export type DmLiveParityRow = {
  page_id: string;
  platform_message_id: string;
  platform_conversation_id: string | null;
  sender_platform_user_id: string | null;
  is_sent_by_page: boolean | null;
  created_at: Date | string | null;
  content: string | null;
  in_reply_to_message_id: string | null;
  field_mask: number;
  age_ms: string;
  hot_found: boolean;
  hot_content: string | null;
  hot_sender: string | null;
  hot_created_at: Date | string | null;
  hot_reply: string | null;
  hot_group: string | null;
  arc_found: boolean;
  arc_text: string | null;
  arc_sent_by_me: boolean | null;
  arc_occurred_at: Date | string | null;
  arc_reply: string | null;
  arc_group: string | null;
  arc_content_pending: boolean | null;
  excluded: boolean;
};

const instant = (value: Date | string | null) => value === null ? null : new Date(value).getTime();

function timeDiffers(a: Date | string | null, b: Date | string | null) {
  const left = instant(a);
  const right = instant(b);
  return left !== null && right !== null && Math.abs(left - right) > CONFIRM_TIME_TOLERANCE_MS;
}

/** The parity verdict for one row; exported for unit tests. Only fields the
 * socket carried (field mask) and the store holds are compared. */
export function judgeDmLiveParity(row: DmLiveParityRow, windowMs: number): {
  outcome: DmLiveConfirmOutcome | null;
  source: "page_dm_messages" | "message_archive" | null;
  fields: DmLiveMismatchField[];
} {
  const fields: DmLiveMismatchField[] = [];
  const hasContent = (row.field_mask & FANSLY_WS_LIVE_FIELD.content) !== 0;
  const hasReply = (row.field_mask & FANSLY_WS_LIVE_FIELD.inReplyTo) !== 0;
  if (row.hot_found) {
    if (hasContent && (row.content ?? "") !== (row.hot_content ?? "")) fields.push("text");
    if (row.hot_sender !== null && row.sender_platform_user_id !== row.hot_sender) fields.push("sender");
    if (timeDiffers(row.created_at, row.hot_created_at)) fields.push("time");
    if (row.hot_group !== null && row.platform_conversation_id !== row.hot_group) fields.push("group");
    if (hasReply && (row.in_reply_to_message_id ?? null) !== (row.hot_reply ?? null)) fields.push("reply");
    return { outcome: fields.length ? "mismatch" : "match", source: "page_dm_messages", fields };
  }
  if (row.arc_found) {
    if (hasContent && row.arc_content_pending !== true
      && normalizeDmMessageText(row.content) !== (row.arc_text ?? "")) fields.push("text");
    if (row.is_sent_by_page !== null && row.arc_sent_by_me !== null
      && row.is_sent_by_page !== row.arc_sent_by_me) fields.push("sender");
    if (timeDiffers(row.created_at, row.arc_occurred_at)) fields.push("time");
    if (row.arc_group !== null && row.platform_conversation_id !== row.arc_group) fields.push("group");
    if (hasReply && row.arc_reply !== null && row.in_reply_to_message_id !== row.arc_reply) fields.push("reply");
    return { outcome: fields.length ? "mismatch" : "match", source: "message_archive", fields };
  }
  if (Number(row.age_ms) >= windowMs) {
    return { outcome: row.excluded ? "excluded" : "not_found", source: null, fields };
  }
  return { outcome: null, source: null, fields };
}

/** Next look for a row without a REST copy yet: often while fresh, then rarely. */
function retrySeconds(ageMs: number) {
  if (ageMs < 10 * 60_000) return 30;
  if (ageMs < 60 * 60_000) return 120;
  return 600;
}

/**
 * One bounded parity pass over due, unconfirmed overlay rows (`skip locked`,
 * so concurrent passes split the work). Reads only Hub's own stores.
 */
export async function confirmDmLiveMessages(
  db: Database,
  input: { limit: number; windowMs?: number },
): Promise<DmLiveConfirmCounts> {
  const windowMs = input.windowMs ?? DM_LIVE_CONFIRM_WINDOW_MS;
  const counts: DmLiveConfirmCounts = { checked: 0, match: 0, mismatch: 0, notFound: 0, excluded: 0, rescheduled: 0 };
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await database.execute(sql`select set_config('statement_timeout', '15s', true)`);
    const due = await database.execute<DmLiveParityRow>(sql`
      select m.page_id::text as page_id, m.platform_message_id, m.platform_conversation_id,
        m.sender_platform_user_id, m.is_sent_by_page, m.created_at, m.content, m.in_reply_to_message_id,
        m.field_mask, (extract(epoch from (clock_timestamp() - m.first_visible_at)) * 1000)::bigint::text as age_ms,
        hot.id is not null as hot_found, hot.content as hot_content, hot.sender_platform_user_id as hot_sender,
        hot.created_at as hot_created_at, hot.in_reply_to_message_id as hot_reply, hot.group_id as hot_group,
        arc.id is not null as arc_found, arc.text_plain as arc_text, arc.is_sent_by_me as arc_sent_by_me,
        arc.occurred_at as arc_occurred_at, arc.in_reply_to_ref as arc_reply, arc.conversation_ref as arc_group,
        arc.content_pending as arc_content_pending,
        coalesce(th.excluded, false) as excluded
      from dm_live_messages m
      left join lateral (
        select pm.id, pm.content, pm.sender_platform_user_id, pm.created_at, pm.in_reply_to_message_id,
          t.platform_conversation_id as group_id
        from page_dm_messages pm
        join page_dm_threads t on t.id = pm.conversation_id
        where pm.platform_account_id = m.page_id and pm.platform_message_id = m.platform_message_id
        order by pm.id
        limit 1
      ) hot on true
      left join lateral (
        select a.id, a.text_plain, a.is_sent_by_me, a.occurred_at, a.in_reply_to_ref, a.conversation_ref,
          a.content_pending
        from message_archive a
        where a.account_id = m.page_id and a.platform = 'fansly' and a.message_ref = m.platform_message_id
        limit 1
      ) arc on true
      left join lateral (
        select bool_or(t.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY} is not null) as excluded
        from page_dm_threads t
        where t.platform_account_id = m.page_id and t.platform_conversation_id = m.platform_conversation_id
      ) th on true
      where m.confirmed_at is null and m.confirm_due_at <= clock_timestamp()
      order by m.confirm_due_at
      limit ${input.limit}
      for update of m skip locked
    `);
    if (due.rows.length === 0) return counts;
    const verdicts = due.rows.map((row) => {
      const verdict = judgeDmLiveParity(row, windowMs);
      counts.checked += 1;
      if (verdict.outcome === "match") counts.match += 1;
      else if (verdict.outcome === "mismatch") counts.mismatch += 1;
      else if (verdict.outcome === "not_found") counts.notFound += 1;
      else if (verdict.outcome === "excluded") counts.excluded += 1;
      else counts.rescheduled += 1;
      return {
        page_id: Number(row.page_id),
        message_id: row.platform_message_id,
        outcome: verdict.outcome,
        source: verdict.source,
        fields: verdict.fields.join(","),
        retry_s: retrySeconds(Number(row.age_ms)),
      };
    });
    await database.execute(sql`
      update dm_live_messages m set
        confirmed_at = case when v.outcome is null then null else clock_timestamp() end,
        confirm_source = v.source,
        confirm_outcome = v.outcome,
        mismatch_fields = case when v.fields = '' then null else string_to_array(v.fields, ',') end,
        confirm_due_at = case when v.outcome is null
          then clock_timestamp() + make_interval(secs => v.retry_s) else m.confirm_due_at end,
        updated_at = clock_timestamp()
      from jsonb_to_recordset(${JSON.stringify(verdicts)}::jsonb)
        as v(page_id bigint, message_id text, outcome text, source text, fields text, retry_s integer)
      where m.page_id = v.page_id and m.platform_message_id = v.message_id
    `);
    return counts;
  });
}

// ---------------------------------------------------------------------------
// Golden-signal gauges (services/golden-signals.ts samples them minutely).

export interface FanslyWsLiveGauges {
  /** first_visible_at − created_at of messages made visible in the window. */
  visibleLagP50Ms: number | null;
  visibleLagP95Ms: number | null;
  /** match / (match + mismatch) of verdicts in the last hour, basis points. */
  parityBasisPoints: number | null;
  /** Receipts acked as `debt` in the last 24 hours. */
  decodeDebt24h: number;
  /** Age of the oldest pending live receipt; 0 when none waits. */
  pendingAgeMs: number;
}

export async function readFanslyWsLiveGauges(
  db: Database,
  input: { windowMinutes: number },
): Promise<FanslyWsLiveGauges> {
  const lag = await db.execute<{ p50: string | null; p95: string | null }>(sql`
    select
      percentile_cont(0.5) within group (order by extract(epoch from (first_visible_at - created_at)) * 1000) as p50,
      percentile_cont(0.95) within group (order by extract(epoch from (first_visible_at - created_at)) * 1000) as p95
    from dm_live_messages
    where first_visible_at > now() - make_interval(mins => ${input.windowMinutes}) and created_at is not null
  `);
  const parity = await db.execute<{ matched: string; mismatched: string }>(sql`
    select count(*) filter (where confirm_outcome = 'match')::text as matched,
      count(*) filter (where confirm_outcome = 'mismatch')::text as mismatched
    from dm_live_messages
    where confirmed_at > now() - interval '1 hour'
  `);
  const debt = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from fansly_ws_decode_receipts
    where live_state = 'debt' and live_applied_at > now() - interval '24 hours'
  `);
  const pending = await db.execute<{ age_ms: string | null }>(sql`
    select coalesce(extract(epoch from (now() - min(received_at))) * 1000, 0) as age_ms
    from fansly_ws_decode_receipts where live_state = 'pending'
  `);
  const number = (value: string | null | undefined) => value === null || value === undefined ? null : Number(value);
  const matched = Number(parity.rows[0]?.matched ?? 0);
  const judged = matched + Number(parity.rows[0]?.mismatched ?? 0);
  return {
    visibleLagP50Ms: number(lag.rows[0]?.p50),
    visibleLagP95Ms: number(lag.rows[0]?.p95),
    parityBasisPoints: judged === 0 ? null : Math.floor((matched * 10_000) / judged),
    decodeDebt24h: Number(debt.rows[0]?.n ?? 0),
    pendingAgeMs: Math.max(0, Number(pending.rows[0]?.age_ms ?? 0)),
  };
}
