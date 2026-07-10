// Wave 2 — the Fansly 1970-timestamp repair: the FIRST CONSUMER of the
// generic superseding-event capability (design note §2; audit known finding
// #2 / Appendix B/D). The sync-pull canonicalizer treated Fansly epoch-SECOND
// createdAt values as milliseconds, landing message events in 1970
// (domain_events_pre_2024) — and replay cannot heal them: the msg:<dir>:<id>
// dedup key silently drops a corrected re-emission.
//
// The repair: for each pre-2000 message event on a Fansly page, re-derive
// the corrected timestamp from the ORIGINAL observation's payload item
// (the seconds/ms heuristic), and append a SUPERSEDING event — same type,
// corrected occurred_at (lands in the correct live partition; the 1970
// original stays in pre_2024, the ledger is append-only), schemaVersion 2,
// dedup key msg:<dir>:<id>:<fpHex>, DATA carrying supersedesEventId +
// fingerprint + the complete corrected head. The message_archive projector's
// superseding merge then heals occurred_at in the serving store.
//
// Fansly has no dm_message_archive head (OF-only store): the fingerprint is
// computed over the CORRECTED CANONICAL FACT — the reduced head of a
// single-source platform IS the fact (design note §2). No new store, no
// Fansly fingerprint columns. One-shot owner-run campaign, dry-run default,
// keyset-paged, idempotent (the fp dedup key makes re-runs no-ops).

import { sql } from "drizzle-orm";

import {
  appendDomainEvents,
  computeFactFingerprint,
  findObservationEnvelopesByIds,
  fingerprintHex,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

const REPAIR_BATCH_SIZE = 200;
/** Sanity clamp on the CORRECTED time — this campaign must never itself
 * write an out-of-range occurred_at into a partition that doesn't exist
 * (the audit's poison-observation lesson, applied to our own writes). */
const CORRECTED_MIN = new Date("2000-01-01T00:00:00Z");

export interface Fansly1970RepairResult {
  scanned: number;
  repaired: number;
  /** Superseding key already claimed — an earlier run repaired it. */
  alreadyRepaired: number;
  /** Source observation no longer reachable by id (tiered/erased). */
  missingObservation: number;
  /** Observation reachable but the message item / timestamp is not. */
  missingItem: number;
  /** Corrected time out of sane range — never written, listed for review. */
  outOfRange: number;
  errored: number;
}

interface BadEventRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  type: string;
  occurred_at: Date;
  fan_identity_ref: string | null;
  conversation_ref: string | null;
  message_ref: string | null;
  data: Record<string, unknown>;
  observation_id: string;
}

function correctedTimestampFor(
  payload: unknown,
  messageRef: string,
): Date | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const messages = (payload as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) {
    return null;
  }
  for (const item of messages) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string"
      ? record.id
      : typeof record.id === "number"
        ? String(record.id)
        : null;
    if (id !== messageRef) {
      continue;
    }
    const createdAt = record.createdAt;
    if (typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt > 0) {
      const ms = createdAt >= 1_000_000_000_000 ? createdAt : createdAt * 1000;
      const parsed = new Date(ms);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }
  return null;
}

export async function runFansly1970Repair(
  app: Pick<AppContext, "db" | "logger">,
  options: { dryRun?: boolean; accountId?: number | null; limit?: number } = {},
): Promise<Fansly1970RepairResult> {
  const db = app.db as Database;
  const totals: Fansly1970RepairResult = {
    scanned: 0,
    repaired: 0,
    alreadyRepaired: 0,
    missingObservation: 0,
    missingItem: 0,
    outOfRange: 0,
    errored: 0,
  };
  const maxRows = options.limit ?? Number.MAX_SAFE_INTEGER;

  let afterId = 0;
  while (totals.scanned < maxRows) {
    const accountFilter = options.accountId != null
      ? sql`and e.account_id = ${options.accountId}`
      : sql``;
    const batch = await db.execute<BadEventRow>(sql`
      select e.id::text as id, e.account_id::text as account_id, e.type,
             e.occurred_at, e.fan_identity_ref, e.conversation_ref,
             e.message_ref, e.data, e.observation_id::text as observation_id
      from domain_events e
      join pages p on p.id = e.account_id
      where e.occurred_at < '2000-01-01'
        and e.type in ('message.received', 'message.sent')
        and e.schema_version = 1
        and p.platform = 'fansly'
        and e.id > ${afterId}
        ${accountFilter}
      order by e.id asc
      limit ${REPAIR_BATCH_SIZE}
    `);
    if (batch.rows.length === 0) {
      break;
    }
    afterId = Number(batch.rows[batch.rows.length - 1]!.id);

    const observationIds = [...new Set(batch.rows.map((row) => Number(row.observation_id)))];
    const envelopes = await findObservationEnvelopesByIds(db, observationIds);

    for (const row of batch.rows) {
      totals.scanned += 1;
      if (totals.scanned > maxRows) {
        break;
      }
      try {
        if (!row.message_ref) {
          totals.missingItem += 1;
          continue;
        }
        const envelope = envelopes.get(Number(row.observation_id));
        if (!envelope) {
          totals.missingObservation += 1;
          continue;
        }
        const corrected = correctedTimestampFor(envelope.payload, row.message_ref);
        if (corrected === null) {
          totals.missingItem += 1;
          continue;
        }
        if (corrected < CORRECTED_MIN || corrected.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
          totals.outOfRange += 1;
          app.logger.warn(
            { eventId: row.id, messageRef: row.message_ref, corrected: corrected.toISOString() },
            "Fansly 1970 repair: corrected timestamp out of sane range; skipped for review",
          );
          continue;
        }

        const direction = row.type === "message.sent" ? "sent" as const : "received" as const;
        const data = row.data ?? {};
        const text = typeof data.text === "string" ? data.text : "";
        const tipAmountMills = typeof data.tipAmountMills === "number" ? data.tipAmountMills : 0;
        const isTip = data.isTip === true;
        // The corrected canonical fact IS the reduced head for a
        // single-source platform (design note §2).
        const fingerprint = computeFactFingerprint({
          platform: "fansly",
          messageRef: row.message_ref,
          direction,
          occurredAt: corrected.getTime(),
          conversationRef: row.conversation_ref,
          fanIdentityRef: row.fan_identity_ref,
          text,
          isTip,
          tipAmountMills,
        });

        if (!options.dryRun) {
          const appended = await appendDomainEvents(db, Number(row.account_id), [{
            type: row.type,
            occurredAt: corrected,
            fanIdentityRef: row.fan_identity_ref,
            conversationRef: row.conversation_ref,
            messageRef: row.message_ref,
            data: {
              text,
              tipAmountMills,
              isTip,
              supersedesEventId: Number(row.id),
              fingerprint: fingerprintHex(fingerprint),
              head: {
                platformMessageId: row.message_ref,
                platformConversationId: row.conversation_ref,
                fanPlatformUserId: row.fan_identity_ref,
                senderPlatformUserId: null,
                senderRole: direction === "sent" ? "model" : "fan",
                isSentByMe: direction === "sent",
                createdAt: corrected.toISOString(),
                text,
                priceMills: null,
                isOpened: null,
                isTip,
                tipAmountMills: String(tipAmountMills),
                inReplyToMessageId: null,
                media: [],
              },
            },
            schemaVersion: 2,
            // The ORIGINAL observation — real lineage, never faked.
            observationId: Number(row.observation_id),
            dedupKey: `msg:${direction}:${row.message_ref}:${fingerprintHex(fingerprint)}`,
          }]);
          if (appended.events[0]!.appended) {
            totals.repaired += 1;
          } else {
            totals.alreadyRepaired += 1;
          }
        } else {
          totals.repaired += 1;
        }
      } catch (error) {
        totals.errored += 1;
        app.logger.error(
          { error, eventId: row.id },
          "Fansly 1970 repair failed for event; re-run resumes idempotently",
        );
      }
    }
    app.logger.info({ afterId, ...totals }, "Fansly 1970 repair batch complete");
  }
  return totals;
}
