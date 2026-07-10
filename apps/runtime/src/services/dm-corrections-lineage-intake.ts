// W2.1 — lineage intake for the corrections reconciler (decision #123).
//
// The Wave-2 reconciler refuses to fake lineage: a dm_message_archive row
// whose source observation cannot be resolved is skip-and-counted. On prod
// that was ALL pre-#49 history (17,172 rows): OFAPI webhook observation
// intake only began ~2026-07-05, and the ofapi_webhook_events journal
// retains ~14 days — so the reconciler had nothing to anchor first events
// to. This owner-run CLI journals the missing observations honestly:
//
//   - JOURNAL LANE: when the webhook journal row survives (live table, or
//     the frozen ofapi_webhook_events_w2_lineage_snapshot rescue copy), the
//     observation carries the reassembled wire envelope VERBATIM, in the
//     webhook source under the row's ORIGINAL idempotency key — the
//     reconciler's primary lookup then resolves it with no special casing.
//   - MATERIAL LANE: when no journal payload survives anywhere, the archive
//     row itself is the retained fact (the cold archive is the journal's
//     durable copy by design). The observation carries the row's material
//     head, in the operator source under the same original key; the
//     reconciler's #123 fallback arm resolves it. Timestamps and ids are
//     the row's own — nothing is guessed.
//
// The intake kinds are NOT registered with any canonicalize family: these
// observations exist as lineage anchors, and the events themselves come
// from the reconciler (canonical dedup keys — late-webhook-proof).
// Idempotent: rows whose lineage already resolves are counted and skipped,
// and insertObservation dedupes on (source, idempotency_key).

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import {
  insertObservation,
  listDmRepairSignalRows,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { headOfRow, resolveLineageObservationId } from "./dm-corrections-reconciler.ts";

const INTAKE_BATCH_SIZE = 200;
const INTAKE_PRODUCER = "cli:corrections-lineage-intake";
const SNAPSHOT_TABLE = "ofapi_webhook_events_w2_lineage_snapshot";

export interface DmLineageIntakeResult {
  scanned: number;
  /** Lineage already resolves (prior intake, live observation, REST ref). */
  alreadyResolvable: number;
  /** Verbatim envelope journaled from the live table or the snapshot. */
  journalIntaken: number;
  /** Reconstructed from the archive row's material head (decision #123). */
  materialIntaken: number;
  /** Null-ref stubs — documented survivors, never intaken. */
  stubsSkipped: number;
  errored: number;
}

interface JournalRow extends Record<string, unknown> {
  event_type: string;
  ofapi_account_id: string | null;
  payload: Record<string, unknown>;
}

async function snapshotTableExists(db: Database): Promise<boolean> {
  const result = await db.execute<{ reg: string | null }>(sql`
    select to_regclass(${`public.${SNAPSHOT_TABLE}`})::text as reg
  `);
  return result.rows[0]?.reg != null;
}

async function findJournalRow(
  db: Database,
  idempotencyKey: string,
  snapshotAvailable: boolean,
): Promise<JournalRow | null> {
  const live = await db.execute<JournalRow>(sql`
    select event_type, ofapi_account_id, payload
    from ofapi_webhook_events
    where idempotency_key = ${idempotencyKey}
    limit 1
  `);
  if (live.rows[0]) {
    return live.rows[0];
  }
  if (!snapshotAvailable) {
    return null;
  }
  // The snapshot table is not in the drizzle schema (operational rescue
  // copy) — only its NAME is raw; the key stays a bind parameter.
  const frozen = await db.execute<JournalRow>(sql`
    select event_type, ofapi_account_id, payload
    from ${sql.raw(SNAPSHOT_TABLE)}
    where idempotency_key = ${idempotencyKey}
    limit 1
  `);
  return frozen.rows[0] ?? null;
}

function sha256Json(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

export async function runDmCorrectionsLineageIntake(
  app: Pick<AppContext, "db" | "logger">,
  options: { dryRun?: boolean; batchSize?: number } = {},
): Promise<DmLineageIntakeResult> {
  const db = app.db as Database;
  const batchSize = options.batchSize ?? INTAKE_BATCH_SIZE;
  const totals: DmLineageIntakeResult = {
    scanned: 0,
    alreadyResolvable: 0,
    journalIntaken: 0,
    materialIntaken: 0,
    stubsSkipped: 0,
    errored: 0,
  };
  const snapshotAvailable = await snapshotTableExists(db);

  let afterId: number | null = null;
  for (;;) {
    const rows = await listDmRepairSignalRows(db, { afterId, limit: batchSize });
    if (rows.length === 0) {
      break;
    }
    afterId = rows[rows.length - 1]!.id;

    for (const row of rows) {
      totals.scanned += 1;
      if (row.messageCreatedAt === null && row.platformConversationId === null) {
        totals.stubsSkipped += 1;
        continue;
      }
      try {
        const resolved = await resolveLineageObservationId(db, row);
        if (resolved !== null) {
          totals.alreadyResolvable += 1;
          continue;
        }

        const journal = await findJournalRow(db, row.sourceIdempotencyKey, snapshotAvailable);
        if (journal) {
          if (!options.dryRun) {
            const payload = {
              event: journal.event_type,
              account_id: journal.ofapi_account_id,
              payload: journal.payload,
            };
            await insertObservation(db, {
              source: "webhook",
              producer: INTAKE_PRODUCER,
              platform: "onlyfans",
              accountId: row.platformAccountId,
              kind: "ofapi_webhook_lineage_backfill",
              payload,
              payloadHash: sha256Json(payload),
              idempotencyKey: row.sourceIdempotencyKey,
              observedAt: row.sourceReceivedAt,
            });
          }
          totals.journalIntaken += 1;
          continue;
        }

        if (!options.dryRun) {
          const payload = {
            archiveRowId: row.id,
            originalSource: row.source,
            originalIdempotencyKey: row.sourceIdempotencyKey,
            material: headOfRow(row),
          };
          await insertObservation(db, {
            source: "operator",
            producer: INTAKE_PRODUCER,
            platform: "onlyfans",
            accountId: row.platformAccountId,
            kind: "dm_archive_material_reconstruction",
            payload,
            payloadHash: sha256Json(payload),
            idempotencyKey: row.sourceIdempotencyKey,
            observedAt: row.sourceReceivedAt ?? row.messageCreatedAt,
          });
        }
        totals.materialIntaken += 1;
      } catch (error) {
        totals.errored += 1;
        app.logger.error(
          { error, rowId: row.id, messageId: row.platformMessageId },
          "Lineage intake failed for row; rerun covers it (idempotent)",
        );
      }
    }
    app.logger.info({ afterId, ...totals }, "DM corrections lineage intake batch complete");
  }
  return totals;
}
