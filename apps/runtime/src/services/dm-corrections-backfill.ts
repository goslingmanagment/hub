// Wave 2 corrections — the MIGRATION PREAMBLE (build spec, tabletop S7;
// owner-run, BEFORE the reconciler flag ever turns on):
//
//  1. material_fingerprint backfill for every pre-existing dm_message_archive
//     row, computed from the row's material (the reduced head — these rows
//     ARE the head; there is nothing fresher to reduce).
//  2. emitted_fingerprint = material_fingerprint (+ emitted_event_id from the
//     canonical ledger claim) for rows ALREADY IN THE LEDGER — else the whole
//     history flags as uncorrected and the reconciler mass-appends redundant
//     superseding events.
//  3. Null-ref tombstone stubs are SKIPPED (fingerprint stays NULL on both
//     sides → outside the partial repair-signal index by construction) and
//     counted.
//  4. material_field_provenance seeded from the legacy `source` column for
//     every backfilled row whose provenance is empty.
//
// Rows left with emitted NULL after the backfill (Wave-1 REST-only rows and
// command-confirmed sends the webhook never covered) are the INITIAL DRAIN
// BOUND (preamble 2): the reconciler appends their first events at its
// bounded pace — the run result reports that number so the owner sizes the
// drain before flipping the flag.

import { sql } from "drizzle-orm";

import {
  computeDmMaterialFingerprint,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

const BACKFILL_BATCH_SIZE = 500;

export interface DmCorrectionsBackfillResult {
  scanned: number;
  fingerprinted: number;
  /** Rows closed against an existing ledger claim (emitted = material). */
  emittedClosed: number;
  /** The initial-drain bound: fingerprinted rows with NO ledger claim —
   * the reconciler appends their first events after the flag flips. */
  drainOpen: number;
  /** Null-ref tombstone stubs left untouched (preamble 3). */
  stubsSkipped: number;
}

interface BackfillRow extends Record<string, unknown> {
  id: number;
  platform_account_id: string;
  platform_conversation_id: string | null;
  fan_platform_user_id: string | null;
  sender_platform_user_id: string | null;
  sender_role: string;
  is_sent_by_me: boolean;
  message_created_at: Date | null;
  text_plain: string;
  price_mills: string | null;
  is_opened: boolean | null;
  is_tip: boolean;
  tip_amount_mills: string;
  in_reply_to_message_id: string | null;
  platform_message_id: string;
  media_metadata: Array<Record<string, unknown>>;
  source: string;
  provenance_empty: boolean;
}

const MATERIAL_FIELDS = [
  "senderPlatformUserId",
  "senderRole",
  "isSentByMe",
  "messageCreatedAt",
  "textPlain",
  "priceMills",
  "isOpened",
  "isTip",
  "tipAmountMills",
  "inReplyToMessageId",
  "platformConversationId",
  "fanPlatformUserId",
  "mediaMetadata",
] as const;

export async function runDmCorrectionsFingerprintBackfill(
  app: Pick<AppContext, "db" | "logger">,
  options: { dryRun?: boolean; batchSize?: number } = {},
): Promise<DmCorrectionsBackfillResult> {
  const db = app.db as Database;
  const batchSize = options.batchSize ?? BACKFILL_BATCH_SIZE;
  const totals: DmCorrectionsBackfillResult = {
    scanned: 0,
    fingerprinted: 0,
    emittedClosed: 0,
    drainOpen: 0,
    stubsSkipped: 0,
  };

  let afterId = 0;
  for (;;) {
    const batch = await db.execute<BackfillRow>(sql`
      select d.id, d.platform_account_id::text as platform_account_id,
             d.platform_conversation_id, d.fan_platform_user_id,
             d.sender_platform_user_id, d.sender_role::text as sender_role,
             d.is_sent_by_me, d.message_created_at, d.text_plain,
             d.price_mills::text as price_mills, d.is_opened, d.is_tip,
             d.tip_amount_mills::text as tip_amount_mills,
             d.in_reply_to_message_id, d.platform_message_id,
             d.media_metadata, d.source,
             (d.material_field_provenance = '{}'::jsonb) as provenance_empty
      from dm_message_archive d
      where d.material_fingerprint is null and d.id > ${afterId}
      order by d.id asc
      limit ${batchSize}
    `);
    if (batch.rows.length === 0) {
      break;
    }
    afterId = batch.rows[batch.rows.length - 1]!.id;

    for (const row of batch.rows) {
      totals.scanned += 1;
      // Preamble 3: null-ref stubs stay unfingerprinted (NULL vs NULL is not
      // distinct → outside the repair signal by construction).
      if (row.message_created_at === null && row.platform_conversation_id === null) {
        totals.stubsSkipped += 1;
        continue;
      }

      const fingerprint = computeDmMaterialFingerprint({
        senderPlatformUserId: row.sender_platform_user_id,
        senderRole: row.sender_role,
        isSentByMe: row.is_sent_by_me,
        messageCreatedAt: row.message_created_at === null
          ? null
          : new Date(row.message_created_at),
        textPlain: row.text_plain,
        priceMills: row.price_mills === null ? null : BigInt(row.price_mills),
        isOpened: row.is_opened,
        isTip: row.is_tip,
        tipAmountMills: BigInt(row.tip_amount_mills),
        inReplyToMessageId: row.in_reply_to_message_id,
        platformConversationId: row.platform_conversation_id,
        fanPlatformUserId: row.fan_platform_user_id,
        mediaMetadata: row.media_metadata,
      });

      // Already in the ledger? The canonical first-event claim for this
      // message at this account (either direction key would have been
      // emitted by the canonicalizer with the row's direction).
      const dedupKey = `msg:${row.is_sent_by_me ? "sent" : "received"}:${row.platform_message_id}`;
      const claim = await db.execute<{ event_id: string }>(sql`
        select k.event_id::text from domain_event_keys k
        where k.account_id = ${Number(row.platform_account_id)} and k.dedup_key = ${dedupKey}
      `);
      const claimedEventId = claim.rows[0] ? Number(claim.rows[0].event_id) : null;

      if (!options.dryRun) {
        const provenance = row.provenance_empty
          ? Object.fromEntries(MATERIAL_FIELDS.map((field) => [field, `legacy:${row.source}`]))
          : null;
        await db.execute(sql`
          update dm_message_archive set
            material_fingerprint = ${fingerprint},
            emitted_fingerprint = ${claimedEventId !== null ? fingerprint : null},
            emitted_event_id = ${claimedEventId},
            material_field_provenance = coalesce(
              ${provenance === null ? null : JSON.stringify(provenance)}::jsonb,
              material_field_provenance
            ),
            updated_at = now()
          where id = ${row.id} and material_fingerprint is null
        `);
      }
      totals.fingerprinted += 1;
      if (claimedEventId !== null) {
        totals.emittedClosed += 1;
      } else {
        totals.drainOpen += 1;
      }
    }
    app.logger.info(
      { afterId, ...totals },
      "DM corrections fingerprint backfill batch complete",
    );
  }
  return totals;
}
