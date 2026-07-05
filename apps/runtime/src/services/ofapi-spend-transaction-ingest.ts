import {
  findObservationByKey,
  listMissingOfapiSpendProjectionTransactionsForTruthIngest,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  upsertFanPages,
  upsertFans,
  upsertTransaction,
  withOfapiSpendTransactionPageLock,
  type OfapiSpendProjectionTransactionIngestRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  mapOfapiSpendCategoryToTransactionType,
  mapOfapiSpendStatusToTransactionState,
  normalizeOfapiSpendAmountMills,
} from "./ofapi-spend-transaction-mapping.ts";
import {
  assertPageTransactionsWriter,
  WrongTransactionsWriterError,
} from "./transactions-writer-gate.ts";

const OFAPI_SPEND_TRANSACTION_INGEST_LIMIT = 200;

export function isOfapiSpendTransactionIngestEnabled(
  config?: Pick<AppContext["config"], "ofapiSpendTransactionIngestEnabled">,
) {
  return config?.ofapiSpendTransactionIngestEnabled === true;
}

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

async function applyPageRows(
  app: AppContext,
  pageId: number,
  rows: OfapiSpendProjectionTransactionIngestRow[],
) {
  if (rows.length === 0) {
    return 0;
  }

  return withOfapiSpendTransactionPageLock(app.db, pageId, async (db) => {
    // Stage 13 single-writer gate, evaluated inside the page lock. A refused
    // page opens an incident and skips ITS rows only (they stay pending and
    // re-list until the writer assignment is fixed); other pages still apply.
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
      // Stage 14: fees ride along with the same reversal sign treatment as the
      // amounts, so per-row gross − fee = net stays coherent on refunds too.
      const normalizeFee = (value: bigint | null) =>
        value === null ? null : normalizeOfapiSpendAmountMills(row.eventStatus, value);
      // Best-effort observation link: the webhook delivery key doubles as the
      // Stage 7 observation key; deliveries older than the journal deploy
      // resolve to null (legacy rows carry source only, per the passport).
      const observation = await findObservationByKey(db, "webhook", row.sourceIdempotencyKey);
      await upsertTransaction(db, {
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
      applied += 1;
    }

    if (dirtyFrom) {
      await rebuildSpenderProjections(db, pageId, dirtyFrom);
      await rebuildRevenueRollups(db, pageId, dirtyFrom);
    }

    return applied;
  });
}

export async function applyOfapiSpendProjectionTransactions(app: AppContext) {
  if (!isOfapiSpendTransactionIngestEnabled(app.config)) {
    return 0;
  }

  const rows = await listMissingOfapiSpendProjectionTransactionsForTruthIngest(app.db, {
    limit: OFAPI_SPEND_TRANSACTION_INGEST_LIMIT,
  });
  let applied = 0;

  for (const [pageId, pageRows] of groupByPage(rows)) {
    try {
      applied += await applyPageRows(app, pageId, pageRows);
    } catch (error) {
      if (error instanceof WrongTransactionsWriterError) {
        // Incident already opened by the gate; this page's rows stay pending
        // and re-list next sweep. Other pages must still apply.
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
