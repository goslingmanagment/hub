import {
  findObservationByKey,
  getPageTransactionsWriterInfo,
  listMissingOfapiSpendProjectionTransactionsForTruthIngest,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  skipOfapiSpendProjectionEventsForTruthIngest,
  upsertFanPages,
  upsertFans,
  withOfapiSpendTransactionPageLock,
  type OfapiSpendProjectionTransactionIngestRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  mapOfapiSpendCategoryToTransactionType,
  mapOfapiSpendStatusToTransactionState,
  normalizeOfapiSpendAmountMills,
} from "./ofapi-spend-transaction-mapping.ts";
import { upsertTransactionWithNegationGuards } from "./money-negation-guards.ts";
import { resolveWrongTransactionsWriterIncident } from "./notification-incidents.ts";
import {
  assertPageTransactionsWriter,
  WrongTransactionsWriterError,
} from "./transactions-writer-gate.ts";

const OFAPI_SPEND_TRANSACTION_INGEST_LIMIT = 200;

function groupByPage(rows: OfapiSpendProjectionTransactionIngestRow[]) {
  const grouped = new Map<number, OfapiSpendProjectionTransactionIngestRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.pageId);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.pageId, [row]);
    }
  }
  return grouped;
}

/** What one page's turn did: rows written, or the page's money is another
 *  writer's and its rows left the ingest (`skippedFor` names that writer). */
interface PageApplyOutcome {
  applied: number;
  skippedFor: string | null;
  skippedRows: number;
  pageLabel: string | null;
}

async function applyPageRows(
  app: AppContext,
  pageId: number,
  rows: OfapiSpendProjectionTransactionIngestRow[],
): Promise<PageApplyOutcome> {
  if (rows.length === 0) {
    return { applied: 0, skippedFor: null, skippedRows: 0, pageLabel: null };
  }

  return withOfapiSpendTransactionPageLock(app.db, pageId, async (db): Promise<PageApplyOutcome> => {
    // A page the owner gave to another writer (`onlyfans-feed:take-money`):
    // that writer writes this money, so OFAPI's rows for it leave the ingest
    // for good instead of re-listing every minute ahead of other pages'.
    const page = await getPageTransactionsWriterInfo(db, pageId);
    const writer = page?.transactionsWriter ?? null;
    if (writer !== null && writer !== "ofapi") {
      const skippedRows = await skipOfapiSpendProjectionEventsForTruthIngest(db, {
        ids: rows.map((row) => row.id),
        reason: `writer_${writer}`,
      });
      return { applied: 0, skippedFor: writer, skippedRows, pageLabel: page?.label ?? null };
    }

    // Single-writer gate, evaluated inside the page lock. An unassigned
    // page (a defect) opens an incident and skips ITS rows only (they stay
    // pending and re-list until a writer is assigned); other pages still apply.
    await assertPageTransactionsWriter(app, {
      platformAccountId: pageId,
      attemptedWriter: "ofapi",
    });

    const fanPlatformUserIds = Array.from(new Set(rows.map((row) => row.fanPlatformUserId)));
    const fanRows = await upsertFans(db, fanPlatformUserIds.map((platformUserId) => ({
      platform: "onlyfans",
      platformUserId,
    })));
    await upsertFanPages(db, fanRows.map((fan) => ({
      fanId: fan.id,
      platformAccountId: pageId,
    })));

    const fanIdByPlatformUserId = new Map(
      fanRows.map((fan) => [fan.platformUserId, fan.id]),
    );
    let dirtyFrom: Date | null = null;
    let applied = 0;

    for (const row of rows) {
      const grossAmountMills = normalizeOfapiSpendAmountMills(row.eventStatus, row.grossAmountMills);
      const creatorNetAmountMills = normalizeOfapiSpendAmountMills(
        row.eventStatus,
        row.creatorNetAmountMills,
      );
      // Fees ride along with the same reversal sign treatment as the
      // amounts, so per-row gross − fee = net stays coherent on refunds too.
      const normalizeFee = (value: bigint | null) =>
        value === null ? null : normalizeOfapiSpendAmountMills(row.eventStatus, value);
      // Best-effort observation link: the webhook delivery key doubles as the
      // observation key; deliveries older than the journal deploy
      // resolve to null (legacy rows carry source only, per the passport).
      const observation = await findObservationByKey(db, "webhook", row.sourceIdempotencyKey);
      // W7.3: negative rows are guard-evaluated; settled positives may
      // reactivate a suppressed orphan negative (extend dirtyFrom for it).
      const guarded = await upsertTransactionWithNegationGuards(db, {
        platformAccountId: pageId,
        source: "ofapi:webhook",
        sourceObservationId: observation?.id ?? null,
        fanId: fanIdByPlatformUserId.get(row.fanPlatformUserId) ?? null,
        transactionId: row.transactionId,
        accountId: row.ofapiAccountId,
        correlationAccountId: row.fanPlatformUserId,
        rawType: `ofapi:${row.category}`,
        canonicalType: mapOfapiSpendCategoryToTransactionType(row.category, row.eventStatus),
        transactionState: mapOfapiSpendStatusToTransactionState(row.eventStatus),
        rawStatus: row.eventStatus,
        grossAmountMills,
        sourceDestinationAmountMills: grossAmountMills,
        creatorNetAmountMills,
        platformFeeMills: normalizeFee(row.platformFeeMills),
        vatAmountMills: normalizeFee(row.vatAmountMills),
        taxAmountMills: normalizeFee(row.taxAmountMills),
        senderId: row.fanPlatformUserId,
        occurredAt: row.occurredAt,
        sourceUpdatedAt: row.occurredAt,
      });
      dirtyFrom = dirtyFrom === null || row.occurredAt.getTime() < dirtyFrom.getTime()
        ? row.occurredAt
        : dirtyFrom;
      if (guarded.reactivatedFrom && (dirtyFrom === null || guarded.reactivatedFrom.getTime() < dirtyFrom.getTime())) {
        dirtyFrom = guarded.reactivatedFrom;
      }
      applied += 1;
    }

    if (dirtyFrom) {
      await rebuildSpenderProjections(db, pageId, dirtyFrom);
      await rebuildRevenueRollups(db, pageId, dirtyFrom);
    }

    return { applied, skippedFor: null, skippedRows: 0, pageLabel: null };
  });
}

export async function applyOfapiSpendProjectionTransactions(app: AppContext) {
  const rows = await listMissingOfapiSpendProjectionTransactionsForTruthIngest(app.db, {
    limit: OFAPI_SPEND_TRANSACTION_INGEST_LIMIT,
  });
  let applied = 0;

  for (const [pageId, pageRows] of groupByPage(rows)) {
    try {
      const outcome = await applyPageRows(app, pageId, pageRows);
      applied += outcome.applied;
      if (outcome.skippedFor !== null) {
        app.logger.info({
          pageId,
          assignedWriter: outcome.skippedFor,
          rows: outcome.skippedRows,
        }, "OFAPI spend ingest: the page's money has another writer; its OFAPI rows skipped");
        await resolveWrongTransactionsWriterIncident(app, {
          platformAccountId: pageId,
          pageLabel: outcome.pageLabel,
          platform: "onlyfans",
          standingDownWriter: "ofapi",
        });
      }
    } catch (error) {
      if (error instanceof WrongTransactionsWriterError) {
        // An unassigned page: incident already opened by the gate; this
        // page's rows stay pending and re-list next sweep. Other pages must
        // still apply.
        app.logger.error({
          pageId,
          assignedWriter: error.assignedWriter,
          rows: pageRows.length,
        }, "OFAPI spend ingest refused: page transactions writer is not 'ofapi'");
        continue;
      }
      throw error;
    }
  }

  return applied;
}
