// Wave 2 corrections — the minutely BOUNDED reconciler (build spec Wave 2 +
// design note §1). material_fingerprint != emitted_fingerprint on the OF
// material head is THE repair signal; this runner drains it into the ledger:
//
//   - emitted NULL → the row never reached the ledger (REST-only rows from
//     Wave 1, command-confirmed sends) → append its FIRST event with the
//     CANONICAL dedup key msg:<dir>:<id> — dedupe-proof against a late
//     webhook canonicalizer emission of the same message.
//   - emitted set but stale → the material advanced past the ledger →
//     append a SUPERSEDING event: same type, dedup msg:<dir>:<id>:<fpHex>,
//     schemaVersion 2, DATA carries supersedesEventId + fingerprint (hex) +
//     the COMPLETE merged head (thin frames leave the desktop unrepaired).
//
// Ordering per row (amendment 8): the candidate merge already projected;
// here = append event → advance emitted_fingerprint (guarded on the material
// fingerprint still matching — a concurrent advance keeps the row flagged
// for the next pass). Null-ref stubs and rows with unresolvable observation
// lineage are skip-and-counted (preamble 3; ids are NEVER faked).
//
// Gated on a STAGED boot flag that stays OFF until the preamble backfill
// (corrections:backfill-fingerprints) has run — enabling against NULL
// emitted fingerprints for already-evented history would mass-append
// redundant superseding events (preamble 1).

import {
  advanceDmEmittedFingerprint,
  appendDomainEvents,
  fingerprintHex,
  findObservationByKey,
  listDmRepairSignalRows,
  supersedingDedupKey,
  type Database,
  type DomainEventInput,
  type ObservationSource,
} from "@agency_hub_core/db";
import { sql } from "drizzle-orm";
import { millsToDollarsNumber } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";

const SWEEP_PAGE_SIZE = 100;
const SWEEP_MAX_PAGES = 5;

type RepairRow = Awaited<ReturnType<typeof listDmRepairSignalRows>>[number];

export function isDmCorrectionsReconcileEnabled(
  config?: Pick<AppContext["config"], "ofapiDmCorrectionsReconcileEnabled">,
) {
  return config?.ofapiDmCorrectionsReconcileEnabled === true;
}

export interface DmCorrectionsRunResult {
  scanned: number;
  firstEvents: number;
  superseding: number;
  /** Null-ref stubs (no refs, no createdAt) — documented survivors. */
  stubSkips: number;
  /** Rows whose source observation could not be resolved — never faked. */
  lineageSkips: number;
  /** Guarded emitted-advance refused (concurrent material advance). */
  staleAdvances: number;
  errored: number;
}

function emptyResult(): DmCorrectionsRunResult {
  return {
    scanned: 0,
    firstEvents: 0,
    superseding: 0,
    stubSkips: 0,
    lineageSkips: 0,
    staleAdvances: 0,
    errored: 0,
  };
}

/** The observation source lane each archive source's idempotency key lives
 * in (webhook journal keys ARE webhook observation keys; command_result
 * observations use cmd:<id>:<state>; readthrough uses the rg:/readthrough
 * keys — REST rows resolve through rest_material_observation_id instead). */
const OBSERVATION_SOURCE_BY_ARCHIVE_SOURCE: Record<string, ObservationSource> = {
  webhook: "webhook",
  command: "command_result",
};

async function resolveLineageObservationId(
  db: Database,
  row: RepairRow,
): Promise<number | null> {
  if (row.restMaterialObservationId !== null) {
    return row.restMaterialObservationId;
  }
  const source = OBSERVATION_SOURCE_BY_ARCHIVE_SOURCE[row.source];
  if (!source) {
    return null;
  }
  const observation = await findObservationByKey(db, source, row.sourceIdempotencyKey);
  return observation?.id ?? null;
}

/** The COMPLETE merged head, as carried in superseding-event data. Mills as
 * decimal strings; timestamps ISO; media verbatim (order-insensitive
 * consumers sort by id). Versioned by the event's schemaVersion (2). */
export function headOfRow(row: RepairRow): Record<string, unknown> {
  return {
    platformMessageId: row.platformMessageId,
    platformConversationId: row.platformConversationId,
    fanPlatformUserId: row.fanPlatformUserId,
    senderPlatformUserId: row.senderPlatformUserId,
    senderRole: row.senderRole,
    isSentByMe: row.isSentByMe,
    createdAt: row.messageCreatedAt?.toISOString() ?? null,
    text: row.textPlain,
    priceMills: row.priceMills === null ? null : row.priceMills.toString(),
    isOpened: row.isOpened,
    isTip: row.isTip,
    tipAmountMills: row.tipAmountMills.toString(),
    inReplyToMessageId: row.inReplyToMessageId,
    media: row.mediaMetadata,
  };
}

/** Prior event id for the supersede link: the row's emitted_event_id when
 * known, else the canonical first-event claim. */
async function resolveSupersededEventId(
  db: Database,
  row: RepairRow,
  canonicalKey: string,
): Promise<number | null> {
  if (row.emittedEventId !== null) {
    return row.emittedEventId;
  }
  const result = await db.execute<{ event_id: string }>(sql`
    select event_id::text from domain_event_keys
    where account_id = ${row.platformAccountId} and dedup_key = ${canonicalKey}
  `);
  return result.rows[0] ? Number(result.rows[0].event_id) : null;
}

/**
 * Reconcile ONE repair-signal row into the ledger. Exported for the tests
 * and the (owner-run) campaign CLIs; the sweep loops it with fault
 * isolation.
 */
export async function reconcileDmRepairRow(
  app: Pick<AppContext, "db" | "logger">,
  row: RepairRow,
  totals: DmCorrectionsRunResult,
): Promise<void> {
  if (row.materialFingerprint === null) {
    // Pre-backfill row reached through the signal (shouldn't happen — the
    // listing filters NULL material) — leave for the preamble.
    return;
  }
  // Preamble 3: null-ref stubs cannot satisfy non-null ref requirements.
  if (row.messageCreatedAt === null && row.platformConversationId === null) {
    totals.stubSkips += 1;
    return;
  }

  const observationId = await resolveLineageObservationId(app.db, row);
  if (observationId === null) {
    totals.lineageSkips += 1;
    app.logger.warn(
      { rowId: row.id, source: row.source, messageId: row.platformMessageId },
      "DM corrections: source observation unresolvable; row left flagged (never faking lineage)",
    );
    return;
  }

  const direction = row.isSentByMe ? "sent" as const : "received" as const;
  const canonicalKey = `msg:${direction}:${row.platformMessageId}`;
  const occurredAt = row.messageCreatedAt ?? row.sourceReceivedAt;
  const fingerprint = row.materialFingerprint;
  const isFirst = row.emittedFingerprint === null;

  let draft: DomainEventInput;
  if (isFirst) {
    // FIRST event: canonical key (design note §1) — a late webhook
    // canonicalizer emission dedups against this claim silently. Thin
    // canonical data shape (matches the webhook family's fields).
    draft = {
      type: `message.${direction}`,
      occurredAt,
      fanIdentityRef: direction === "received" ? row.fanPlatformUserId : null,
      conversationRef: row.platformConversationId,
      messageRef: row.platformMessageId,
      data: {
        text: row.textPlain,
        price: row.priceMills === null ? null : millsToDollarsNumber(row.priceMills),
        isTip: row.isTip,
      },
      schemaVersion: 1,
      observationId,
      dedupKey: canonicalKey,
    };
  } else {
    const supersedesEventId = await resolveSupersededEventId(app.db, row, canonicalKey);
    if (supersedesEventId === null) {
      // emitted_fingerprint set but no traceable prior event: backfilled
      // preamble rows always carry emitted_event_id or a canonical claim;
      // anything else is a bug worth surfacing, not silently re-emitting.
      totals.lineageSkips += 1;
      app.logger.warn(
        { rowId: row.id, messageId: row.platformMessageId },
        "DM corrections: no prior event to supersede; row left flagged",
      );
      return;
    }
    draft = {
      type: `message.${direction}`,
      occurredAt,
      fanIdentityRef: direction === "received" ? row.fanPlatformUserId : null,
      conversationRef: row.platformConversationId,
      messageRef: row.platformMessageId,
      data: {
        text: row.textPlain,
        price: row.priceMills === null ? null : millsToDollarsNumber(row.priceMills),
        isTip: row.isTip,
        supersedesEventId,
        fingerprint: fingerprintHex(fingerprint),
        head: headOfRow(row),
      },
      schemaVersion: 2,
      observationId,
      dedupKey: supersedingDedupKey(direction, row.platformMessageId, fingerprint),
    };
  }

  const appended = await appendDomainEvents(app.db, row.platformAccountId, [draft]);
  const outcome = appended.events[0]!;
  const advanced = await advanceDmEmittedFingerprint(app.db, {
    rowId: row.id,
    fingerprint,
    eventId: outcome.eventId,
    superseding: !isFirst,
  });
  if (!advanced) {
    totals.staleAdvances += 1;
    return;
  }
  if (isFirst) {
    totals.firstEvents += 1;
  } else {
    totals.superseding += 1;
  }
}

/** The minutely bounded sweep. Keyset-paged; per-row fault isolation
 * (one poison row costs its own pass, never the sweep). */
export async function runDmCorrectionsReconcile(
  app: Pick<AppContext, "db" | "config" | "logger">,
): Promise<DmCorrectionsRunResult> {
  const totals = emptyResult();
  if (!isDmCorrectionsReconcileEnabled(app.config)) {
    return totals;
  }

  let afterId: number | null = null;
  for (let page = 0; page < SWEEP_MAX_PAGES; page += 1) {
    const rows = await listDmRepairSignalRows(app.db, {
      afterId,
      limit: SWEEP_PAGE_SIZE,
    });
    if (rows.length === 0) {
      break;
    }
    afterId = rows[rows.length - 1]!.id;
    for (const row of rows) {
      totals.scanned += 1;
      try {
        await reconcileDmRepairRow(app, row, totals);
      } catch (error) {
        totals.errored += 1;
        app.logger.error(
          { error, rowId: row.id, messageId: row.platformMessageId },
          "DM corrections reconcile failed for row; left flagged for the next sweep",
        );
      }
    }
    if (rows.length < SWEEP_PAGE_SIZE) {
      break;
    }
  }
  return totals;
}
