// H2 (INC-001) — the OFAPI PPV conversation-ref repair. Pattern:
// fansly-1970-repair.ts (the first superseding consumer).
//
// Before the 2026-07-15 fix (decision #155) the webhook canonicalizer
// published messages.ppv.unlocked with the top-level `user_id` — the
// recipient CREATOR — as fan_identity_ref and conversation_ref. Production
// holds 70 such message.ppv_unlocked events (pages 8/9, 2026-07-05…15).
// Replay cannot heal them: the dedup key `ppv:<notificationId>` is the same
// for the corrected draft, so a re-canonicalization dedupes to nothing.
//
// The repair, per wrong event:
//   * re-read the ORIGINAL observation through the payload seam
//     (resolveCapturePayloadRow — the July bodies live in
//     capture_payload_objects, not observations.payload);
//   * re-derive the chat (= fan) ref with notificationChatId — the same
//     function the fixed canonicalizer uses — and the message ref from the
//     notification link;
//   * append a SUPERSEDING message.ppv_unlocked: schema 2, the ORIGINAL
//     occurred_at (it lands in the original month's partition), the original
//     observation id (real lineage, never faked), data.supersedesEventId, and
//     the dedup key `supersedes:<original id>` (domain-event-supersession.ts)
//     — which makes the superseded original recognisable to any reader by one
//     key probe, and makes a re-run repair exactly zero.
//
// The ledger stays append-only: the wrong original is never touched. The
// superseding event is deliverable on the v2 stream like any purchase —
// which is why the plan runs this only after desktop D2 is on every device.
//
// Dry-run is the DEFAULT and is provably read-only (one READ ONLY
// transaction; the seam's reads included). No OFAPI call anywhere.

import { sql } from "drizzle-orm";

import {
  appendDomainEvents,
  assertDomainEventTargetMonthsAttached,
  DomainEventTargetMonthsUnattachedError,
  domainEventNotSupersededSql,
  findObservationEnvelopesByIds,
  loadDomainEventPartitionCoverage,
  supersessionDedupKey,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { parseOfapiPpvAmountUsd } from "./canonicalize/ofapi-webhook.ts";
import {
  asRecord,
  extractMessageIdFromNotification,
  notificationChatId,
} from "./ofapi-payloads.ts";
import { isCapturePayloadUnavailable, resolveCapturePayloadRow } from "./payload-reader.ts";

const REPAIR_BATCH_SIZE = 200;
/** Recorded in each superseding event: why it exists. */
export const OFAPI_PPV_REF_REPAIR_REASON = "ofapi_ppv_creator_conversation_ref";

export interface OfapiPpvRefRepairOptions {
  /** Default true: count what WOULD be repaired, write nothing. */
  dryRun?: boolean;
  /** Restrict to one internal page id. */
  accountId?: number | null;
  /** Max candidate events to examine this run. */
  limit?: number;
}

export interface OfapiPpvRefRepairResult {
  dryRun: boolean;
  /** Candidate events: v1 OFAPI message.ppv_unlocked whose fan/conversation
   *  ref equals the page's own creator id. */
  scanned: number;
  /** Superseding events appended (dry-run: that WOULD be appended). */
  repaired: number;
  /** A superseding event already exists (`supersedes:<id>` claimed). */
  alreadyRepaired: number;
  /** The re-derived chat ref equals what the event already says. */
  alreadyCorrect: number;
  /** Source observation not reachable by id (tiered/erased). */
  missingObservation: number;
  /** The observation is not a messages.ppv.unlocked journal row. */
  lineageMismatch: number;
  /** Body unreadable right now (catalog unavailable) — transient; re-run. */
  unavailableBody: number;
  /** Observation readable but no chat ref derivable — never guessed. */
  missingChatRef: number;
  /** Original month has no attached domain_events partition — skipped. */
  partitionBlocked: number;
  errored: number;
}

interface CandidateRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  occurred_at: Date;
  fan_identity_ref: string | null;
  conversation_ref: string | null;
  message_ref: string | null;
  observation_id: string;
  superseded: boolean;
}

function emptyResult(dryRun: boolean): OfapiPpvRefRepairResult {
  return {
    dryRun,
    scanned: 0,
    repaired: 0,
    alreadyRepaired: 0,
    alreadyCorrect: 0,
    missingObservation: 0,
    lineageMismatch: 0,
    unavailableBody: 0,
    missingChatRef: 0,
    partitionBlocked: 0,
    errored: 0,
  };
}

async function repairPass(
  app: Pick<AppContext, "db" | "logger">,
  db: Database,
  options: { dryRun: boolean; accountId: number | null; limit: number },
): Promise<OfapiPpvRefRepairResult> {
  const totals = emptyResult(options.dryRun);
  const seam = { db, logger: app.logger };
  // One catalog read per run (the driver's partition gate does the same).
  const coverage = await loadDomainEventPartitionCoverage(db);
  let afterId = 0;
  while (totals.scanned < options.limit) {
    const accountFilter = options.accountId !== null
      ? sql`and e.account_id = ${options.accountId}`
      : sql``;
    // The defect's exact signature: a v1 OFAPI unlock whose fan/conversation
    // ref is the page's OWN OnlyFans id (pages.external_page_id). Correct
    // events name the fan and never match; schema-2 events are repairs.
    const batch = await db.execute<CandidateRow>(sql`
      select e.id::text as id, e.account_id::text as account_id, e.occurred_at,
             e.fan_identity_ref, e.conversation_ref, e.message_ref,
             e.observation_id::text as observation_id,
             not ${domainEventNotSupersededSql("e")} as superseded
      from domain_events e
      join pages p on p.id = e.account_id
      where e.type = 'message.ppv_unlocked'
        and e.schema_version = 1
        and p.platform = 'onlyfans'
        and p.external_page_id is not null
        and (e.conversation_ref = p.external_page_id or e.fan_identity_ref = p.external_page_id)
        and e.id > ${afterId}
        ${accountFilter}
      order by e.id asc
      limit ${REPAIR_BATCH_SIZE}
    `);
    if (batch.rows.length === 0) {
      break;
    }
    afterId = Number(batch.rows[batch.rows.length - 1]!.id);
    const envelopes = await findObservationEnvelopesByIds(
      db,
      [...new Set(batch.rows.map((row) => Number(row.observation_id)))],
    );

    for (const row of batch.rows) {
      if (totals.scanned >= options.limit) {
        break;
      }
      totals.scanned += 1;
      const eventId = Number(row.id);
      try {
        if (row.superseded) {
          totals.alreadyRepaired += 1;
          continue;
        }
        const observationId = Number(row.observation_id);
        const envelope = envelopes.get(observationId);
        if (!envelope) {
          totals.missingObservation += 1;
          continue;
        }
        if (envelope.kind !== "messages.ppv.unlocked") {
          totals.lineageMismatch += 1;
          continue;
        }
        let resolved;
        try {
          resolved = await resolveCapturePayloadRow(seam, "observation", observationId, envelope);
        } catch (error) {
          if (isCapturePayloadUnavailable(error)) {
            totals.unavailableBody += 1;
            continue;
          }
          throw error;
        }
        const payload = asRecord(asRecord(resolved.payload)?.payload);
        const chatId = payload ? notificationChatId(payload) : null;
        if (!payload || !chatId) {
          totals.missingChatRef += 1;
          continue;
        }
        if (chatId === row.conversation_ref && chatId === row.fan_identity_ref) {
          totals.alreadyCorrect += 1;
          continue;
        }
        const occurredAt = new Date(row.occurred_at);
        try {
          await assertDomainEventTargetMonthsAttached(db, [occurredAt], { coverage });
        } catch (error) {
          if (error instanceof DomainEventTargetMonthsUnattachedError) {
            totals.partitionBlocked += 1;
            continue;
          }
          throw error;
        }
        if (options.dryRun) {
          totals.repaired += 1;
          continue;
        }

        const replacePairs = asRecord(payload.replacePairs) ?? {};
        const amountText = typeof replacePairs["{AMOUNT}"] === "string"
          ? replacePairs["{AMOUNT}"] as string
          : null;
        const messageLink = typeof replacePairs["{MESSAGE_LINK}"] === "string"
          ? replacePairs["{MESSAGE_LINK}"] as string
          : null;
        const appended = await appendDomainEvents(db, Number(row.account_id), [{
          type: "message.ppv_unlocked",
          // The ORIGINAL fact time — a repair re-states the fact, it does
          // not re-date it.
          occurredAt,
          fanIdentityRef: chatId,
          conversationRef: chatId,
          messageRef: extractMessageIdFromNotification(payload) ?? row.message_ref,
          data: {
            amountText,
            amountUsd: parseOfapiPpvAmountUsd(amountText),
            messageLink,
            supersedesEventId: eventId,
            repair: OFAPI_PPV_REF_REPAIR_REASON,
          },
          schemaVersion: 2,
          observationId,
          dedupKey: supersessionDedupKey(eventId),
        }]);
        if (appended.events[0]!.appended) {
          totals.repaired += 1;
        } else {
          totals.alreadyRepaired += 1;
        }
      } catch (error) {
        totals.errored += 1;
        app.logger.error(
          { error, eventId },
          "OFAPI PPV ref repair failed for event; a re-run resumes idempotently",
        );
      }
    }
  }
  return totals;
}

export async function runOfapiPpvRefRepair(
  app: Pick<AppContext, "db" | "logger">,
  options: OfapiPpvRefRepairOptions = {},
): Promise<OfapiPpvRefRepairResult> {
  const dryRun = options.dryRun !== false;
  const pass = {
    dryRun,
    accountId: options.accountId ?? null,
    limit: options.limit ?? Number.MAX_SAFE_INTEGER,
  };
  if (dryRun) {
    return app.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      return repairPass(app, tx as unknown as Database, pass);
    });
  }
  const result = await repairPass(app, app.db as Database, pass);
  app.logger.info(result, "OFAPI PPV ref repair complete");
  return result;
}
