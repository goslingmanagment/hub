import {
  deleteTransactionsMissingFromWindow,
  getCheckpoint,
  getOldestPendingTransactionAt,
  insertRawPayload,
  rebuildSpenderProjections,
  rebuildRevenueRollups,
  upsertCheckpoint,
  upsertFanPage,
  upsertFans,
  upsertTransaction,
} from "@fansly-connect/db";
import {
  ONLYMONSTER_MAPPER_VERSION,
  mapOnlyMonsterTransactionState,
  mapOnlyMonsterTransactionType,
  type OnlyMonsterChargeback,
  type OnlyMonsterTransaction,
} from "@fansly-connect/onlyfans";
import {
  calculateNetMillsFromGross,
  dollarsToMills,
  startOfBusinessDay,
  UTC_TIME_ZONE,
} from "@fansly-connect/shared";

import type { AppContext } from "../../bootstrap.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { DAY_MS, retentionDate } from "./shared.ts";

function buildOnlyFansFanInputs(
  fanPlatformIds: string[],
) {
  if (fanPlatformIds.length === 0) {
    return [];
  }

  return Array.from(new Set(fanPlatformIds)).map((platformUserId) => ({
    platform: "onlyfans" as const,
    platformUserId,
    metadata: {},
  }));
}

export async function syncOnlyFansTransactions(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    platformAccountIdValue: string;
    commissionRate: number;
    rescanStart?: Date | null;
    requestContext: Parameters<AppContext["onlyFansAdapter"]["getTransactionsPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
  },
) {
  const checkpoint = await getCheckpoint(app.db, input.platformAccountId, "transactions");
  await input.telemetry.recordCheckpointLoaded("transactions", summarizeCheckpoint(checkpoint));
  const oldestPendingAt = await getOldestPendingTransactionAt(app.db, input.platformAccountId);
  const lookbackStart = checkpoint?.cursorTimestamp
    ? new Date(
      checkpoint.cursorTimestamp.getTime() -
        app.config.transactionLookbackDays * DAY_MS,
    )
    : null;
  const earliestRescanStart = lookbackStart && oldestPendingAt
    ? (oldestPendingAt < lookbackStart ? oldestPendingAt : lookbackStart)
    : (lookbackStart ?? oldestPendingAt);
  const rescanCapStart = startOfBusinessDay(
    new Date(Date.now() - app.config.transactionRescanCapDays * DAY_MS),
    UTC_TIME_ZONE,
  );
  const start = input.rescanStart ?? (
    earliestRescanStart && earliestRescanStart < rescanCapStart
      ? rescanCapStart
      : (earliestRescanStart ?? rescanCapStart)
  );
  const end = new Date();

  if (start >= end) {
    throw new Error(`OnlyFans transaction rescan start must be before ${end.toISOString()}`);
  }

  if (input.rescanStart) {
    await input.telemetry.addNote("Manual rescan override was applied", {
      start: input.rescanStart.toISOString(),
    });
  }

  let newestSeenAt: Date | null = checkpoint?.cursorTimestamp ?? null;
  let oldestSeenAt: Date | null = null;
  let processedTransactions = 0;
  let processedChargebacks = 0;
  let transactionPages = 0;
  let chargebackPages = 0;
  let olderThanBoundaryItems = 0;
  let olderThanBoundaryPages = 0;
  const sourceTransactionIds = new Set<string>();
  const transactionsToUpsert: Array<OnlyMonsterTransaction> = [];
  const chargebacksToUpsert: Array<OnlyMonsterChargeback> = [];
  const fanPlatformIds = new Set<string>();

  let transactionCursor: string | null = null;
  let transactionPageIndex = 0;
  do {
    const page = await app.onlyFansAdapter.getTransactionsPage(
      input.requestContext,
      input.platformAccountIdValue,
      {
        start,
        end,
        cursor: transactionCursor,
        limit: 100,
        pageIndex: transactionPageIndex,
      },
    );
    transactionPages += 1;

    await insertRawPayload(app.db, {
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId,
      endpoint: "onlymonster_transactions",
      requestParams: {
        start: start.toISOString(),
        end: end.toISOString(),
        cursor: transactionCursor,
        limit: 100,
      },
      responsePayload: page.raw,
      mapperVersion: ONLYMONSTER_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    });

    for (const item of page.parsed.items) {
      fanPlatformIds.add(item.fan.id);
      transactionsToUpsert.push(item);
      sourceTransactionIds.add(item.id);
      const occurredAt = new Date(item.timestamp);

      if (!oldestSeenAt || occurredAt < oldestSeenAt) {
        oldestSeenAt = occurredAt;
      }
      if (!newestSeenAt || occurredAt > newestSeenAt) {
        newestSeenAt = occurredAt;
      }
    }

    const olderItemsInPage = page.parsed.items.filter(
      (item) => new Date(item.timestamp).getTime() < start.getTime(),
    ).length;
    olderThanBoundaryItems += olderItemsInPage;
    if (olderItemsInPage > 0 && olderItemsInPage === page.parsed.items.length) {
      olderThanBoundaryPages += 1;
    }

    processedTransactions += page.parsed.items.length;
    transactionCursor = page.parsed.cursor ?? null;
    transactionPageIndex += 1;
  } while (transactionCursor);

  let chargebackCursor: string | null = null;
  let chargebackPageIndex = 0;
  do {
    const page = await app.onlyFansAdapter.getChargebacksPage(
      input.requestContext,
      input.platformAccountIdValue,
      {
        start,
        end,
        cursor: chargebackCursor,
        limit: 100,
        pageIndex: chargebackPageIndex,
      },
    );
    chargebackPages += 1;

    await insertRawPayload(app.db, {
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId,
      endpoint: "onlymonster_chargebacks",
      requestParams: {
        start: start.toISOString(),
        end: end.toISOString(),
        cursor: chargebackCursor,
        limit: 100,
      },
      responsePayload: page.raw,
      mapperVersion: ONLYMONSTER_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    });

    for (const item of page.parsed.items) {
      fanPlatformIds.add(item.fan.id);
      chargebacksToUpsert.push(item);
      sourceTransactionIds.add(item.id);
      const occurredAt = new Date(item.chargeback_timestamp);

      if (!oldestSeenAt || occurredAt < oldestSeenAt) {
        oldestSeenAt = occurredAt;
      }
      if (!newestSeenAt || occurredAt > newestSeenAt) {
        newestSeenAt = occurredAt;
      }
    }

    const olderItemsInPage = page.parsed.items.filter(
      (item) => new Date(item.chargeback_timestamp).getTime() < start.getTime(),
    ).length;
    olderThanBoundaryItems += olderItemsInPage;
    if (olderItemsInPage > 0 && olderItemsInPage === page.parsed.items.length) {
      olderThanBoundaryPages += 1;
    }

    processedChargebacks += page.parsed.items.length;
    chargebackCursor = page.parsed.cursor ?? null;
    chargebackPageIndex += 1;
  } while (chargebackCursor);

  let checkpointAfter = null;
  await app.db.transaction(async (tx) => {
    const fans = await upsertFans(
      tx as typeof app.db,
      buildOnlyFansFanInputs(Array.from(fanPlatformIds)),
    );
    const fanMap = new Map(fans.map((fan) => [fan.platformUserId, fan.id]));

    for (const fan of fans) {
      await upsertFanPage(tx as typeof app.db, {
        fanId: fan.id,
        platformAccountId: input.platformAccountId,
      });
    }

    for (const item of transactionsToUpsert) {
      const grossAmountMills = dollarsToMills(item.amount);
      const creatorNetAmountMills = calculateNetMillsFromGross(
        grossAmountMills,
        input.commissionRate,
      );

      await upsertTransaction(tx as typeof app.db, {
        platformAccountId: input.platformAccountId,
        fanId: fanMap.get(item.fan.id) ?? null,
        transactionId: item.id,
        correlationAccountId: item.fan.id,
        rawType: item.type,
        canonicalType: mapOnlyMonsterTransactionType(item.type),
        transactionState: mapOnlyMonsterTransactionState(item.status),
        rawStatus: item.status,
        grossAmountMills,
        sourceDestinationAmountMills: grossAmountMills,
        creatorNetAmountMills,
        occurredAt: new Date(item.timestamp),
      });
    }

    for (const item of chargebacksToUpsert) {
      const grossAmountMills = -dollarsToMills(item.amount);
      const creatorNetAmountMills = calculateNetMillsFromGross(
        grossAmountMills,
        input.commissionRate,
      );

      await upsertTransaction(tx as typeof app.db, {
        platformAccountId: input.platformAccountId,
        fanId: fanMap.get(item.fan.id) ?? null,
        transactionId: item.id,
        correlationAccountId: item.fan.id,
        rawType: item.type,
        canonicalType: "chargeback",
        transactionState: mapOnlyMonsterTransactionState(item.status),
        rawStatus: item.status,
        grossAmountMills,
        sourceDestinationAmountMills: grossAmountMills,
        creatorNetAmountMills,
        occurredAt: new Date(item.chargeback_timestamp),
        sourceUpdatedAt: new Date(item.transaction_timestamp),
      });
    }

    if (processedTransactions > 0) {
      await deleteTransactionsMissingFromWindow(tx as typeof app.db, {
        platformAccountId: input.platformAccountId,
        from: start,
        to: end,
        keepTransactionIds: Array.from(sourceTransactionIds),
      });
    }
    await rebuildSpenderProjections(tx as typeof app.db, input.platformAccountId);
    await rebuildRevenueRollups(tx as typeof app.db, input.platformAccountId);

    if (newestSeenAt) {
      checkpointAfter = await upsertCheckpoint(tx as typeof app.db, {
        platformAccountId: input.platformAccountId,
        stream: "transactions",
        cursorTimestamp: newestSeenAt,
        state: {
          pageLabel: input.pageLabel,
          processedTransactions,
          processedChargebacks,
        },
        lastSuccessfulRunId: input.syncRunId,
      });
    }
  });

  await input.telemetry.recordCheckpointAdvanced("transactions", summarizeCheckpoint(checkpointAfter));
  input.telemetry.setBoundarySummary({
    kind: "start",
    requestedLowerBound: start.toISOString(),
    end: end.toISOString(),
    lookbackStart: lookbackStart?.toISOString() ?? null,
    oldestPendingAt: oldestPendingAt?.toISOString() ?? null,
    rescanCapStart: rescanCapStart.toISOString(),
    olderThanBoundaryItems,
    olderThanBoundaryPages,
  });
  input.telemetry.setScanSummary({
    transactionPages,
    chargebackPages,
    processedTransactions,
    processedChargebacks,
    oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
    deleteWindowApplied: processedTransactions > 0,
  });
  if (processedTransactions > 0) {
    await input.telemetry.addNote("Delete-missing-in-window cleanup was applied to the OnlyFans transaction scan", {
      from: start.toISOString(),
      to: end.toISOString(),
      keptTransactionIds: sourceTransactionIds.size,
    });
  }

  if (oldestPendingAt && oldestPendingAt < rescanCapStart) {
    await input.telemetry.addAnomaly({
      code: "rescan_cap_clamped",
      severity: "warn",
      message: "OnlyFans scan window was clamped by the configured rescan cap",
      details: {
        oldestPendingAt: oldestPendingAt.toISOString(),
        rescanCapStart: rescanCapStart.toISOString(),
      },
    });
  }

  if (lookbackStart && start.getTime() < lookbackStart.getTime() - DAY_MS) {
    await input.telemetry.addAnomaly({
      code: "wide_rescan",
      severity: "warn",
      message: "OnlyFans scan expanded materially beyond the normal incremental lookback window",
      details: {
        start: start.toISOString(),
        lookbackStart: lookbackStart.toISOString(),
      },
    });
  }

  if (
    checkpoint?.cursorTimestamp &&
    newestSeenAt &&
    newestSeenAt.getTime() <= checkpoint.cursorTimestamp.getTime() &&
    (processedTransactions + processedChargebacks) > 0
  ) {
    await input.telemetry.addAnomaly({
      code: "checkpoint_stalled",
      severity: "error",
      message: "OnlyFans transaction checkpoint did not advance despite scanning source data",
      details: {
        checkpointTimestamp: checkpoint.cursorTimestamp.toISOString(),
        newestSeenAt: newestSeenAt.toISOString(),
      },
    });
  }

  if (
    olderThanBoundaryPages > 1 ||
    (
      olderThanBoundaryItems > 100 &&
      checkpoint?.cursorTimestamp &&
      newestSeenAt &&
      newestSeenAt.getTime() <= checkpoint.cursorTimestamp.getTime()
    )
  ) {
    await input.telemetry.addAnomaly({
      code: "after_ineffective",
      severity: "error",
      message: "The OnlyFans lower-bound filter behaved ineffectively and scanned materially old data",
      details: {
        start: start.toISOString(),
        olderThanBoundaryItems,
        olderThanBoundaryPages,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
      },
    });
  }

  return {
    processed: processedTransactions + processedChargebacks,
    processedTransactions,
    processedChargebacks,
    newestSeenAt,
  };
}
