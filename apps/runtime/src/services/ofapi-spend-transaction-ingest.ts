import {
  listMissingOfapiSpendProjectionTransactionsForTruthIngest,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  upsertFanPages,
  upsertFans,
  upsertTransaction,
  withOwnedPageSyncTransaction,
  type OfapiSpendProjectionTransactionIngestRow,
} from "@agency_hub_core/db";
import type { TransactionState, TransactionType } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";

const OFAPI_SPEND_TRANSACTION_INGEST_LIMIT = 200;

export function isOfapiSpendTransactionIngestEnabled(
  config?: Pick<AppContext["config"], "ofapiSpendTransactionIngestEnabled">,
) {
  return config?.ofapiSpendTransactionIngestEnabled === true;
}

function mapCategoryToTransactionType(
  category: OfapiSpendProjectionTransactionIngestRow["category"],
  status: OfapiSpendProjectionTransactionIngestRow["eventStatus"],
): TransactionType {
  if (status === "reversed") {
    return "refund";
  }

  switch (category) {
    case "message":
      return "message_purchase";
    case "tip":
      return "tip";
    case "subscription":
      return "subscription";
    case "post":
      return "post_purchase";
    case "stream":
      return "stream_tip";
    case "other":
      return "other";
  }
}

function mapEventStatusToTransactionState(
  _status: OfapiSpendProjectionTransactionIngestRow["eventStatus"],
): TransactionState {
  return "posted";
}

function normalizeEventAmountMills(
  status: OfapiSpendProjectionTransactionIngestRow["eventStatus"],
  amountMills: bigint,
) {
  return status === "reversed" && amountMills > 0n ? -amountMills : amountMills;
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

  return withOwnedPageSyncTransaction(app.db, async (db) => {
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
      const grossAmountMills = normalizeEventAmountMills(row.eventStatus, row.grossAmountMills);
      const creatorNetAmountMills = normalizeEventAmountMills(
        row.eventStatus,
        row.creatorNetAmountMills,
      );
      await upsertTransaction(db, {
        platformAccountId: pageId,
        fanId: fanIdByPlatformUserId.get(row.fanPlatformUserId) ?? null,
        transactionId: row.transactionId,
        accountId: row.ofapiAccountId,
        correlationAccountId: row.fanPlatformUserId,
        rawType: `ofapi:${row.category}`,
        canonicalType: mapCategoryToTransactionType(row.category, row.eventStatus),
        transactionState: mapEventStatusToTransactionState(row.eventStatus),
        rawStatus: row.eventStatus,
        grossAmountMills,
        sourceDestinationAmountMills: grossAmountMills,
        creatorNetAmountMills,
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
    applied += await applyPageRows(app, pageId, pageRows);
  }

  return applied;
}
