import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { findVisiblePageDmConversationByPlatformConversationId } from "./page-dm.ts";
import {
  evaluateOfapiHistoryCoverage,
  type OfapiMessageCoverageServingState,
} from "./ofapi-message-coverage.ts";

export type CertifiedOfapiHistoryMissReason =
  | "conversation_missing"
  | "head_missing"
  | "cursor_out_of_storage_range"
  | "boundary_missing"
  | "material_incomplete"
  | "media_live_required"
  | "false_eof_guard"
  | "no_certificate"
  | "projection_lag"
  | "proof_policy_rejected"
  | "stale_head"
  | "range_unproven"
  | "gap";

export interface CertifiedOfapiHistoryMessage {
  nativeMessageId: string;
  textHtml: string;
  isSentByMe: boolean;
  occurredAt: Date;
  priceMills: string | null;
  isOpened: boolean | null;
  isNew: boolean | null;
  isTip: boolean;
  tipAmountMills: string;
  tipTextPlain: string | null;
  replyMetadata: Record<string, unknown> | null;
  mediaMetadata: Array<Record<string, unknown>>;
  vendorChangedAt: Date | null;
  fanNativeId: string | null;
}

export type CertifiedOfapiHistoryPage =
  | {
    kind: "hit";
    messages: CertifiedOfapiHistoryMessage[];
    nextFirstId: string | null;
    coverage: OfapiMessageCoverageServingState;
  }
  | { kind: "miss"; reason: CertifiedOfapiHistoryMissReason };

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const records = value.map(asRecord);
  return records.every((record): record is Record<string, unknown> => record !== null)
    ? records
    : null;
}

/**
 * One deliberately narrow serving surface: exclusive backward OFAPI message
 * scrollback. OFAPI treats first_id as the already-seen boundary and returns
 * only older messages. The whole proof and page are read in one snapshot so a
 * head or projection advance cannot turn a stale certificate into a DB hit.
 */
export async function readCertifiedOfapiChatHistoryPage(
  db: Database,
  input: {
    pageId: number;
    chatId: string;
    firstId: string;
    limit: number;
    acceptedProofPolicyVersions: readonly string[];
  },
): Promise<CertifiedOfapiHistoryPage> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const conversation = await findVisiblePageDmConversationByPlatformConversationId(database, {
      platformAccountId: input.pageId,
      platformConversationId: input.chatId,
    });
    if (!conversation) return { kind: "miss", reason: "conversation_missing" };
    if (!conversation.lastMessageId) return { kind: "miss", reason: "head_missing" };

    const coverage = await evaluateOfapiHistoryCoverage(database, {
      pageId: input.pageId,
      chatId: input.chatId,
      expectedCurrentHeadId: conversation.lastMessageId,
      requestedFirstId: input.firstId,
      acceptedProofPolicyVersions: input.acceptedProofPolicyVersions,
    });
    if (!coverage.eligible) return { kind: "miss", reason: coverage.reason };

    if (!/^\d+$/.test(input.firstId)) {
      return { kind: "miss", reason: "cursor_out_of_storage_range" };
    }
    const cursor = BigInt(input.firstId);
    if (cursor < 0n || cursor > POSTGRES_BIGINT_MAX) {
      return { kind: "miss", reason: "cursor_out_of_storage_range" };
    }
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const result = await database.execute<Record<string, unknown>>(sql`
      select coalesce(
               archive.native_message_id,
               case
                 when archive.message_ref = ${input.firstId} then ${cursor}::bigint
                 else null
               end
             )::text as native_message_id,
             text_html,
             is_sent_by_me,
             occurred_at,
             price_mills::text as price_mills,
             is_opened,
             is_new,
             is_tip,
             tip_amount_mills::text as tip_amount_mills,
             tip_text_plain,
             reply_metadata,
             media_metadata,
             vendor_changed_at,
             fan_native_id,
             content_pending,
             source_account_seq::text as source_account_seq,
             serving_contract_version
      from message_archive archive
      where archive.account_id = ${input.pageId}
        and archive.platform = 'onlyfans'
        and archive.conversation_ref = ${input.chatId}
        and (
          archive.native_message_id <= ${cursor}
          or (
            archive.native_message_id is null
            and archive.message_ref = ${input.firstId}
          )
        )
        and archive.deleted_at is null
      -- A webhook can create the current-head row before the paid capture
      -- observes its complete material. The row is still a valid exclusive
      -- cursor boundary; only rows returned below it must pass the strict
      -- material contract. Existing native ids stay authoritative, so a
      -- conflicting non-null id still fails closed instead of being masked.
      order by coalesce(archive.native_message_id, ${cursor}::bigint) desc,
               (archive.message_ref = ${input.firstId}) desc
      limit ${limit + 2}
    `);

    if (String(result.rows[0]?.native_message_id ?? "") !== input.firstId) {
      return { kind: "miss", reason: "boundary_missing" };
    }

    // Keep the boundary check fail-closed, but never return the boundary: the
    // live OFAPI contract is exclusive. One further row proves continuation.
    const pageRows = result.rows.slice(1);
    const hasExtra = pageRows.length > limit;
    const parsed: CertifiedOfapiHistoryMessage[] = [];
    // The extra row proves continuation only. Its material (for example an
    // expiring media URL) belongs to the next request and must not force this
    // otherwise-complete page back to the paid vendor path.
    for (const row of pageRows.slice(0, limit)) {
      const nativeMessageId = String(row.native_message_id ?? "");
      const numericId = Number(nativeMessageId);
      const mediaMetadata = asRecordArray(row.media_metadata);
      const occurredAt = row.occurred_at == null
        ? null
        : new Date(row.occurred_at as string | Date);
      const vendorChangedAt = row.vendor_changed_at == null
        ? null
        : new Date(row.vendor_changed_at as string | Date);
      const priceMills = row.price_mills == null ? null : String(row.price_mills);
      const tipAmountMills = String(row.tip_amount_mills ?? "0");
      const numericPriceMills = priceMills === null ? null : Number(priceMills);
      const numericTipAmountMills = Number(tipAmountMills);
      if (
        !/^\d+$/.test(nativeMessageId)
        || !Number.isSafeInteger(numericId)
        || occurredAt === null
        || Number.isNaN(occurredAt.getTime())
        || typeof row.text_html !== "string"
        || typeof row.is_sent_by_me !== "boolean"
        || row.content_pending === true
        || row.source_account_seq == null
        || Number(row.serving_contract_version) < 1
        || mediaMetadata === null
        || (priceMills !== null && (
          !/^\d+$/.test(priceMills)
          || !Number.isSafeInteger(numericPriceMills)
        ))
        || !/^\d+$/.test(tipAmountMills)
        || !Number.isSafeInteger(numericTipAmountMills)
        || (vendorChangedAt !== null && Number.isNaN(vendorChangedAt.getTime()))
      ) {
        return { kind: "miss", reason: "material_incomplete" };
      }
      // Signed OF media URLs are intentionally not retained in the mirror.
      // A media-bearing page stays on the existing capture-first live path.
      if (mediaMetadata.length > 0) {
        return { kind: "miss", reason: "media_live_required" };
      }
      parsed.push({
        nativeMessageId,
        textHtml: row.text_html,
        isSentByMe: row.is_sent_by_me,
        occurredAt,
        priceMills,
        isOpened: typeof row.is_opened === "boolean" ? row.is_opened : null,
        isNew: typeof row.is_new === "boolean" ? row.is_new : null,
        isTip: row.is_tip === true,
        tipAmountMills,
        tipTextPlain: typeof row.tip_text_plain === "string" ? row.tip_text_plain : null,
        replyMetadata: asRecord(row.reply_metadata),
        mediaMetadata,
        vendorChangedAt,
        fanNativeId: typeof row.fan_native_id === "string" ? row.fan_native_id : null,
      });
    }

    const messages = parsed;
    if (!hasExtra) {
      const lastId = messages.at(-1)?.nativeMessageId ?? null;
      const reachedOldest = lastId === coverage.coverage.oldestMessageId
        || (lastId === null && input.firstId === coverage.coverage.oldestMessageId);
      if (!reachedOldest) {
        return { kind: "miss", reason: "false_eof_guard" };
      }
    }
    return {
      kind: "hit",
      messages,
      nextFirstId: hasExtra ? messages.at(-1)!.nativeMessageId : null,
      coverage: coverage.coverage,
    };
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}
